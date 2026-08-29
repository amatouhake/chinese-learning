import {
  FSRS_ALGORITHM,
  FSRS_IMPLEMENTATION,
  FSRS_IMPLEMENTATION_VERSION,
  parseFsrsParameters,
  replayFsrsHistory,
} from "../domain/fsrs";
import {
  ConcurrencyConflictError,
  ConflictError,
  InvalidInputError,
  ReferenceNotFoundError,
} from "../domain/errors";
import { normalizeUtcInstant, semanticOrderKey } from "../domain/ordering";
import type {
  AttemptInput,
  CanonicalFsrsReview,
  FsrsCardProjection,
  IngestResult,
  MaterializedCardState,
  SchedulerConfig,
} from "../domain/types";

const MAX_CONCURRENCY_RETRIES = 3;

export interface IngestOptions {
  now?: () => number;
  forceFailureAfterWrites?: boolean;
  /** Coordination seam used to exercise an interleaving immediately before the atomic write. */
  beforeScheduledWrite?: () => Promise<void>;
}

interface ExistingAttemptRow {
  event_id: string;
  device_id: string;
  device_seq: number;
  occurred_at: number;
  card_id: string;
  study_session_id: string | null;
  mode: AttemptInput["mode"];
  activity_type: AttemptInput["activityType"];
  correct: number | null;
  score: number | null;
  self_rating: number | null;
  response_ms: number | null;
  expected_card_state_version: number | null;
  metadata_json: string;
  server_seq: number;
  review_rating: number | null;
  scheduler_config_id: string | null;
}

interface CardRow {
  id: string;
  activity_type: AttemptInput["activityType"];
  scheduler_eligible: number;
}

interface CardStateRow {
  card_id: string;
  due_at: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review_at: number | null;
  version: number;
  server_seq: number | null;
  rebuilt_at: number;
}

interface HistoryRow {
  event_id: string;
  card_id: string;
  device_id: string;
  device_seq: number;
  occurred_at: number;
  rating: number;
  scheduler_config_id: string;
  config_id: string;
  algorithm: string;
  implementation: string;
  implementation_version: string;
  parameters_json: string;
  desired_retention: number;
}

interface SchedulerConfigRow {
  id: string;
  algorithm: string;
  implementation: string;
  implementation_version: string;
  parameters_json: string;
  desired_retention: number;
}

interface AttemptIdentityRow {
  event_id: string;
}

export async function ingestAttempt(
  db: D1Database,
  input: AttemptInput,
  options: IngestOptions = {},
): Promise<IngestResult> {
  validateAttempt(input);
  const occurredAt = normalizeUtcInstant(input.occurredAt);
  const receivedAt = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
    throw new Error("server received time must be a non-negative integer");
  }

  for (let attemptNumber = 0; attemptNumber < MAX_CONCURRENCY_RETRIES; attemptNumber += 1) {
    const existing = await findAttempt(db, input.eventId);
    if (existing) return duplicateResult(db, existing, input, occurredAt);
    await assertDeviceSequenceAvailable(db, input);
    await assertStudySessionExists(db, input.studySessionId);

    const card = await db
      .prepare("SELECT id, activity_type, scheduler_eligible FROM cards WHERE id = ?")
      .bind(input.cardId)
      .first<CardRow>();

    if (!card) throw new ReferenceNotFoundError("card", input.cardId);
    if (card.activity_type !== input.activityType) {
      throw new InvalidInputError("attempt activity does not match its card");
    }

    if (!input.fsrsReview) {
      try {
        await insertUnscheduledAttempt(db, input, occurredAt, receivedAt, options);
        const inserted = await findAttempt(db, input.eventId);
        if (!inserted) throw new Error("inserted attempt could not be reloaded");
        return {
          disposition: "inserted",
          eventId: input.eventId,
          attemptServerSeq: inserted.server_seq,
          reviewCreated: false,
          cardState: null,
        };
      } catch (error) {
        const duplicate = await findAttempt(db, input.eventId);
        if (duplicate) return duplicateResult(db, duplicate, input, occurredAt);
        await assertDeviceSequenceAvailable(db, input);
        throw error;
      }
    }

    if (card.scheduler_eligible !== 1) {
      throw new InvalidInputError("FSRS review requires a scheduler-eligible card");
    }

    const currentState = await getCardState(db, input.cardId);
    if (!currentState) throw new Error(`missing materialized state for card: ${input.cardId}`);

    const { reviews, configs } = await loadCanonicalHistory(db, input.cardId);
    const selectedConfig = await loadSchedulerConfig(db, input.fsrsReview.schedulerConfigId);
    configs.set(selectedConfig.id, selectedConfig);

    const incomingReview: CanonicalFsrsReview = {
      eventId: input.eventId,
      cardId: input.cardId,
      deviceId: input.deviceId,
      deviceSeq: input.deviceSeq,
      occurredAt,
      rating: input.fsrsReview.rating,
      schedulerConfigId: input.fsrsReview.schedulerConfigId,
    };
    const projection = replayFsrsHistory([...reviews, incomingReview], configs);

    try {
      await options.beforeScheduledWrite?.();
      await insertScheduledAttempt(
        db,
        input,
        incomingReview,
        receivedAt,
        currentState,
        projection,
        options,
      );

      const [inserted, state] = await Promise.all([
        findAttempt(db, input.eventId),
        getCardState(db, input.cardId),
      ]);
      if (!inserted || !state) throw new Error("scheduled ingestion could not be reloaded");
      return {
        disposition: "inserted",
        eventId: input.eventId,
        attemptServerSeq: inserted.server_seq,
        reviewCreated: true,
        cardState: mapCardState(state),
      };
    } catch (error) {
      const duplicate = await findAttempt(db, input.eventId);
      if (duplicate) return duplicateResult(db, duplicate, input, occurredAt);
      await assertDeviceSequenceAvailable(db, input);
      if (options.forceFailureAfterWrites) throw error;

      const latestState = await getCardState(db, input.cardId);
      if (latestState && latestState.version !== currentState.version) {
        continue;
      }
      throw error;
    }
  }

  throw new ConcurrencyConflictError("card state kept changing during ingestion");
}

async function insertUnscheduledAttempt(
  db: D1Database,
  input: AttemptInput,
  occurredAt: number,
  receivedAt: number,
  options: IngestOptions,
): Promise<void> {
  const changeId = `attempt:${input.eventId}`;
  const statements = [
    db
      .prepare(
        `INSERT INTO server_changes
          (change_id, entity_type, entity_id, operation, changed_at)
         VALUES (?, 'attempt', ?, 'upsert', ?)`,
      )
      .bind(changeId, input.eventId, receivedAt),
    attemptInsert(db, input, occurredAt, receivedAt, changeId),
    db
      .prepare("UPDATE projection_state SET dirty = 1, last_attempt_at = ? WHERE singleton = 1")
      .bind(occurredAt),
  ];

  if (options.forceFailureAfterWrites) {
    statements.push(forcedFailureStatement(db, input.eventId));
  }
  await db.batch(statements);
}

async function insertScheduledAttempt(
  db: D1Database,
  input: AttemptInput,
  review: CanonicalFsrsReview,
  receivedAt: number,
  currentState: CardStateRow,
  projection: FsrsCardProjection,
  options: IngestOptions,
): Promise<void> {
  const attemptChangeId = `attempt:${input.eventId}`;
  const stateChangeId = `card-state:${input.eventId}`;
  const guardId = `state-version:${input.eventId}:${currentState.version}`;
  const previousAudit = JSON.stringify(mapCardState(currentState));
  const newAudit = JSON.stringify(projection);

  const statements = [
    db
      .prepare(
        `INSERT INTO server_changes
          (change_id, entity_type, entity_id, operation, changed_at)
         VALUES (?, 'attempt', ?, 'upsert', ?)`,
      )
      .bind(attemptChangeId, input.eventId, receivedAt),
    db
      .prepare(
        `INSERT INTO server_changes
          (change_id, entity_type, entity_id, operation, changed_at)
         VALUES (?, 'card_state', ?, 'upsert', ?)`,
      )
      .bind(stateChangeId, input.cardId, receivedAt),
    attemptInsert(db, input, review.occurredAt, receivedAt, attemptChangeId),
    db
      .prepare(
        `INSERT INTO fsrs_reviews
          (attempt_id, card_id, rating, scheduler_config_id, semantic_order_key,
           audit_previous_state_json, audit_new_state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.eventId,
        input.cardId,
        review.rating,
        review.schedulerConfigId,
        semanticOrderKey(review),
        previousAudit,
        newAudit,
      ),
    db
      .prepare(
        `UPDATE card_state SET
          due_at = ?, stability = ?, difficulty = ?, elapsed_days = ?,
          scheduled_days = ?, learning_steps = ?, reps = ?, lapses = ?, state = ?,
          last_review_at = ?, version = version + 1,
          server_seq = (SELECT seq FROM server_changes WHERE change_id = ?),
          rebuilt_at = ?
         WHERE card_id = ? AND version = ?`,
      )
      .bind(
        projection.dueAt,
        projection.stability,
        projection.difficulty,
        projection.elapsedDays,
        projection.scheduledDays,
        projection.learningSteps,
        projection.reps,
        projection.lapses,
        projection.state,
        projection.lastReviewAt,
        stateChangeId,
        receivedAt,
        input.cardId,
        currentState.version,
      ),
    db
      .prepare("INSERT INTO atomic_write_guards (guard_id, assertion) VALUES (?, changes())")
      .bind(guardId),
    db.prepare("DELETE FROM atomic_write_guards WHERE guard_id = ?").bind(guardId),
    db
      .prepare("UPDATE projection_state SET dirty = 1, last_attempt_at = ? WHERE singleton = 1")
      .bind(review.occurredAt),
  ];

  if (options.forceFailureAfterWrites) {
    statements.push(forcedFailureStatement(db, input.eventId));
  }
  await db.batch(statements);
}

function attemptInsert(
  db: D1Database,
  input: AttemptInput,
  occurredAt: number,
  receivedAt: number,
  changeId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO attempts
        (event_id, device_id, device_seq, occurred_at, received_at, card_id,
         study_session_id, mode, activity_type, correct, score, self_rating,
         response_ms, expected_card_state_version, metadata_json, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT seq FROM server_changes WHERE change_id = ?))`,
    )
    .bind(
      input.eventId,
      input.deviceId,
      input.deviceSeq,
      occurredAt,
      receivedAt,
      input.cardId,
      input.studySessionId ?? null,
      input.mode,
      input.activityType,
      input.correct === undefined ? null : Number(input.correct),
      input.score ?? null,
      input.selfRating ?? null,
      input.responseMs ?? null,
      input.expectedCardStateVersion ?? null,
      canonicalJson(input.metadata ?? {}),
      changeId,
    );
}

function forcedFailureStatement(db: D1Database, eventId: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO atomic_write_guards (guard_id, assertion) VALUES (?, 0)")
    .bind(`forced-failure:${eventId}`);
}

async function findAttempt(db: D1Database, eventId: string): Promise<ExistingAttemptRow | null> {
  return db
    .prepare(
      `SELECT
        a.event_id, a.device_id, a.device_seq, a.occurred_at, a.card_id,
        a.study_session_id, a.mode, a.activity_type, a.correct, a.score,
        a.self_rating, a.response_ms, a.expected_card_state_version,
        a.metadata_json, a.server_seq, r.rating AS review_rating,
        r.scheduler_config_id
       FROM attempts a
       LEFT JOIN fsrs_reviews r ON r.attempt_id = a.event_id
       WHERE a.event_id = ?`,
    )
    .bind(eventId)
    .first<ExistingAttemptRow>();
}

async function duplicateResult(
  db: D1Database,
  existing: ExistingAttemptRow,
  input: AttemptInput,
  occurredAt: number,
): Promise<IngestResult> {
  assertDuplicatePayload(existing, input, occurredAt);
  const state = existing.review_rating === null ? null : await getCardState(db, existing.card_id);
  return {
    disposition: "duplicate",
    eventId: existing.event_id,
    attemptServerSeq: existing.server_seq,
    reviewCreated: existing.review_rating !== null,
    cardState: state ? mapCardState(state) : null,
  };
}

function assertDuplicatePayload(
  existing: ExistingAttemptRow,
  input: AttemptInput,
  occurredAt: number,
): void {
  const same =
    existing.device_id === input.deviceId &&
    existing.device_seq === input.deviceSeq &&
    existing.occurred_at === occurredAt &&
    existing.card_id === input.cardId &&
    existing.study_session_id === (input.studySessionId ?? null) &&
    existing.mode === input.mode &&
    existing.activity_type === input.activityType &&
    existing.correct === (input.correct === undefined ? null : Number(input.correct)) &&
    existing.score === (input.score ?? null) &&
    existing.self_rating === (input.selfRating ?? null) &&
    existing.response_ms === (input.responseMs ?? null) &&
    existing.expected_card_state_version === (input.expectedCardStateVersion ?? null) &&
    existing.metadata_json === canonicalJson(input.metadata ?? {}) &&
    existing.review_rating === (input.fsrsReview?.rating ?? null) &&
    existing.scheduler_config_id === (input.fsrsReview?.schedulerConfigId ?? null);

  if (!same) {
    throw new ConflictError("event_id already exists with a different immutable payload");
  }
}

async function getCardState(db: D1Database, cardId: string): Promise<CardStateRow | null> {
  return db
    .prepare(
      `SELECT card_id, due_at, stability, difficulty, elapsed_days, scheduled_days,
        learning_steps, reps, lapses, state, last_review_at, version, server_seq, rebuilt_at
       FROM card_state WHERE card_id = ?`,
    )
    .bind(cardId)
    .first<CardStateRow>();
}

async function loadCanonicalHistory(
  db: D1Database,
  cardId: string,
): Promise<{ reviews: CanonicalFsrsReview[]; configs: Map<string, SchedulerConfig> }> {
  const result = await db
    .prepare(
      `SELECT
        a.event_id, r.card_id, a.device_id, a.device_seq, a.occurred_at,
        r.rating, r.scheduler_config_id, c.id AS config_id, c.algorithm,
        c.implementation, c.implementation_version, c.parameters_json,
        c.desired_retention
       FROM fsrs_reviews r
       JOIN attempts a ON a.event_id = r.attempt_id
       JOIN scheduler_configs c ON c.id = r.scheduler_config_id
       WHERE r.card_id = ?`,
    )
    .bind(cardId)
    .all<HistoryRow>();

  const reviews: CanonicalFsrsReview[] = [];
  const configs = new Map<string, SchedulerConfig>();
  for (const row of result.results) {
    reviews.push({
      eventId: row.event_id,
      cardId: row.card_id,
      deviceId: row.device_id,
      deviceSeq: row.device_seq,
      occurredAt: row.occurred_at,
      rating: requireRating(row.rating),
      schedulerConfigId: row.scheduler_config_id,
    });
    if (!configs.has(row.config_id)) {
      configs.set(
        row.config_id,
        schedulerConfigFromRow({
          id: row.config_id,
          algorithm: row.algorithm,
          implementation: row.implementation,
          implementation_version: row.implementation_version,
          parameters_json: row.parameters_json,
          desired_retention: row.desired_retention,
        }),
      );
    }
  }
  return { reviews, configs };
}

async function loadSchedulerConfig(db: D1Database, id: string): Promise<SchedulerConfig> {
  const row = await db
    .prepare(
      `SELECT id, algorithm, implementation, implementation_version,
        parameters_json, desired_retention
       FROM scheduler_configs WHERE id = ?`,
    )
    .bind(id)
    .first<SchedulerConfigRow>();
  if (!row) throw new ReferenceNotFoundError("scheduler config", id);
  return schedulerConfigFromRow(row);
}

function schedulerConfigFromRow(row: SchedulerConfigRow): SchedulerConfig {
  if (
    row.algorithm !== FSRS_ALGORITHM ||
    row.implementation !== FSRS_IMPLEMENTATION ||
    row.implementation_version !== FSRS_IMPLEMENTATION_VERSION
  ) {
    throw new Error(
      `unsupported scheduler implementation: ${row.algorithm}/${row.implementation}@${row.implementation_version}`,
    );
  }
  const parameters = parseFsrsParameters(row.parameters_json);
  if (parameters.request_retention !== row.desired_retention) {
    throw new Error(`scheduler config ${row.id} has inconsistent desired retention`);
  }
  return {
    id: row.id,
    algorithm: row.algorithm,
    implementation: row.implementation,
    implementationVersion: row.implementation_version,
    parameters,
    desiredRetention: row.desired_retention,
  };
}

function mapCardState(row: CardStateRow): MaterializedCardState {
  return {
    cardId: row.card_id,
    dueAt: row.due_at,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsed_days,
    scheduledDays: row.scheduled_days,
    learningSteps: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    lastReviewAt: row.last_review_at,
    version: row.version,
    serverSeq: row.server_seq,
    rebuiltAt: row.rebuilt_at,
  };
}

function validateAttempt(input: AttemptInput): void {
  if (!input.eventId.trim() || !input.deviceId.trim() || !input.cardId.trim()) {
    throw new InvalidInputError("event, device, and card IDs must be non-empty");
  }
  if (!Number.isSafeInteger(input.deviceSeq) || input.deviceSeq <= 0) {
    throw new InvalidInputError("device sequence must be a positive safe integer");
  }
  if (
    input.responseMs !== undefined &&
    (!Number.isSafeInteger(input.responseMs) || input.responseMs < 0)
  ) {
    throw new InvalidInputError("response time must be a non-negative integer");
  }
  canonicalJson(input.metadata ?? {});
}

async function assertDeviceSequenceAvailable(db: D1Database, input: AttemptInput): Promise<void> {
  const owner = await db
    .prepare("SELECT event_id FROM attempts WHERE device_id = ? AND device_seq = ?")
    .bind(input.deviceId, input.deviceSeq)
    .first<AttemptIdentityRow>();
  if (owner && owner.event_id !== input.eventId) {
    throw new ConflictError(
      `device sequence ${input.deviceId}/${input.deviceSeq} already belongs to another event`,
    );
  }
}

async function assertStudySessionExists(
  db: D1Database,
  studySessionId: string | undefined,
): Promise<void> {
  if (studySessionId === undefined) return;
  const session = await db
    .prepare("SELECT id FROM study_sessions WHERE id = ?")
    .bind(studySessionId)
    .first<{ id: string }>();
  if (!session) throw new ReferenceNotFoundError("study session", studySessionId);
}

function requireRating(value: number): 1 | 2 | 3 | 4 {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  throw new Error(`invalid persisted FSRS rating: ${value}`);
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJson(record[key])]),
  );
}
