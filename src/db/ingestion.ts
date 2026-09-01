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
import { normalizeUtcInstant, semanticEventOrderKey, semanticOrderKey } from "../domain/ordering";
import { parseGrammarPracticeMetadata } from "../domain/reading-grammar";
import { REFLEX_INTERACTION, isReflexActivity, parseReflexAttemptMetadata } from "../domain/reflex";
import { getPreparedReflexItem } from "./reflex";
import {
  PRONUNCIATION_AUDIO_SKIP_INTERACTION,
  PRONUNCIATION_AUDIO_SKIP_REASON,
  deriveTonePair,
  isPronunciationActivity,
  normalizeNumericPinyin,
  singleTone,
} from "../domain/pronunciation";
import type {
  AttemptInput,
  CanonicalFsrsReview,
  FsrsCardProjection,
  IngestResult,
  LearnerId,
  MaterializedCardState,
  SchedulerConfig,
} from "../domain/types";
import { registerLearnerDevice } from "./learners";

const MAX_CONCURRENCY_RETRIES = 3;

export interface IngestOptions {
  now?: () => number;
  forceFailureAfterWrites?: boolean;
  /** Coordination seam used to exercise concurrent ordinary-attempt writes after validation. */
  beforeUnscheduledWrite?: () => Promise<void>;
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
  subject_type: "lexeme" | "lexeme_reading" | "sentence" | "grammar_topic";
  activity_type: AttemptInput["activityType"];
  scheduler_eligible: number;
  lexeme_reading_id: string | null;
  sentence_id: string | null;
  grammar_topic_id: string | null;
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
  learnerId: LearnerId,
  input: AttemptInput,
  options: IngestOptions = {},
): Promise<IngestResult> {
  validateAttempt(input);
  const occurredAt = normalizeUtcInstant(input.occurredAt);
  const receivedAt = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
    throw new Error("server received time must be a non-negative integer");
  }
  await registerLearnerDevice(db, learnerId, input.deviceId);

  for (let attemptNumber = 0; attemptNumber < MAX_CONCURRENCY_RETRIES; attemptNumber += 1) {
    const existing = await findAttempt(db, learnerId, input.eventId);
    if (existing) return duplicateResult(db, learnerId, existing, input, occurredAt);
    await assertDeviceSequenceAvailable(db, learnerId, input);
    await assertStudySessionOwnedByDevice(
      db,
      learnerId,
      input.studySessionId,
      input.deviceId,
      input.mode,
    );

    const card = await db
      .prepare(
        `SELECT id, subject_type, activity_type, scheduler_eligible,
          lexeme_reading_id, sentence_id, grammar_topic_id
         FROM cards WHERE id = ?`,
      )
      .bind(input.cardId)
      .first<CardRow>();

    if (!card) throw new ReferenceNotFoundError("card", input.cardId);
    if (card.activity_type !== input.activityType) {
      throw new InvalidInputError("attempt activity does not match its card");
    }
    await validatePronunciationAttempt(db, input, card);
    await validateReflexAttempt(db, learnerId, input, card);
    await validateReadingGrammarAttempt(db, input, card);

    if (!input.fsrsReview) {
      try {
        if (input.mode === "grammar" && card.grammar_topic_id !== null) {
          await insertGrammarAttempt(
            db,
            learnerId,
            input,
            card.grammar_topic_id,
            occurredAt,
            receivedAt,
            options,
          );
        } else {
          await options.beforeUnscheduledWrite?.();
          await insertUnscheduledAttempt(db, learnerId, input, occurredAt, receivedAt, options);
        }
        const inserted = await findAttempt(db, learnerId, input.eventId);
        if (!inserted) throw new Error("inserted attempt could not be reloaded");
        return {
          disposition: "inserted",
          eventId: input.eventId,
          attemptServerSeq: inserted.server_seq,
          reviewCreated: false,
          cardState: null,
        };
      } catch (error) {
        const duplicate = await findAttempt(db, learnerId, input.eventId);
        if (duplicate) return duplicateResult(db, learnerId, duplicate, input, occurredAt);
        await assertDeviceSequenceAvailable(db, learnerId, input);
        throw mapReflexSequenceConstraint(input, error);
      }
    }

    if (card.scheduler_eligible !== 1) {
      throw new InvalidInputError("FSRS review requires a scheduler-eligible card");
    }

    const currentState = await getCardState(db, learnerId, input.cardId);
    if (!currentState) throw new Error(`missing materialized state for card: ${input.cardId}`);

    const { reviews, configs } = await loadCanonicalHistory(db, learnerId, input.cardId);
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
        learnerId,
        input,
        incomingReview,
        receivedAt,
        currentState,
        projection,
        options,
      );

      const [inserted, state] = await Promise.all([
        findAttempt(db, learnerId, input.eventId),
        getCardState(db, learnerId, input.cardId),
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
      const duplicate = await findAttempt(db, learnerId, input.eventId);
      if (duplicate) return duplicateResult(db, learnerId, duplicate, input, occurredAt);
      await assertDeviceSequenceAvailable(db, learnerId, input);
      if (options.forceFailureAfterWrites) throw error;

      const latestState = await getCardState(db, learnerId, input.cardId);
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
  learnerId: LearnerId,
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
          (change_id, learner_id, entity_type, entity_id, operation, changed_at)
         VALUES (?, ?, 'attempt', ?, 'upsert', ?)`,
      )
      .bind(changeId, learnerId, input.eventId, receivedAt),
    attemptInsert(db, learnerId, input, occurredAt, receivedAt, changeId),
    db
      .prepare(
        `UPDATE projection_state SET
          dirty = 1,
          last_attempt_at = CASE
            WHEN last_attempt_at IS NULL OR last_attempt_at < ? THEN ?
            ELSE last_attempt_at
          END
         WHERE learner_id = ?`,
      )
      .bind(occurredAt, occurredAt, learnerId),
  ];

  if (options.forceFailureAfterWrites) {
    statements.push(forcedFailureStatement(db, input.eventId));
  }
  await db.batch(statements);
}

async function insertGrammarAttempt(
  db: D1Database,
  learnerId: LearnerId,
  input: AttemptInput,
  grammarTopicId: string,
  occurredAt: number,
  receivedAt: number,
  options: IngestOptions,
): Promise<void> {
  if (input.selfRating === undefined) {
    throw new InvalidInputError("grammar practice requires an explicit confidence rating");
  }
  const attemptChangeId = `attempt:${input.eventId}`;
  const stateChangeId = `grammar-topic-state:${input.eventId}`;
  const orderKey = semanticEventOrderKey({
    eventId: input.eventId,
    deviceId: input.deviceId,
    deviceSeq: input.deviceSeq,
    occurredAt,
  });
  const status =
    input.selfRating === 1 ? "introduced" : input.selfRating === 4 ? "comfortable" : "learning";
  const metadata = canonicalJson({ lastPracticeOrderKey: orderKey });
  const statements = [
    db
      .prepare(
        `INSERT INTO server_changes
          (change_id, learner_id, entity_type, entity_id, operation, changed_at)
         VALUES (?, ?, 'attempt', ?, 'upsert', ?)`,
      )
      .bind(attemptChangeId, learnerId, input.eventId, receivedAt),
    db
      .prepare(
        `INSERT INTO server_changes
          (change_id, learner_id, entity_type, entity_id, operation, changed_at)
         VALUES (?, ?, 'grammar_topic_state', ?, 'upsert', ?)`,
      )
      .bind(stateChangeId, learnerId, grammarTopicId, receivedAt),
    attemptInsert(db, learnerId, input, occurredAt, receivedAt, attemptChangeId),
    db
      .prepare(
        `INSERT INTO grammar_topic_state
          (learner_id, grammar_topic_id, status, introduced_at, last_studied_at,
           self_confidence, version, server_seq, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, 1,
           (SELECT seq FROM server_changes WHERE change_id = ?), ?)
         ON CONFLICT(learner_id, grammar_topic_id) DO UPDATE SET
           introduced_at = MIN(grammar_topic_state.introduced_at, excluded.introduced_at),
           last_studied_at = MAX(grammar_topic_state.last_studied_at, excluded.last_studied_at),
           status = CASE
             WHEN json_extract(excluded.metadata_json, '$.lastPracticeOrderKey') >=
               COALESCE(json_extract(grammar_topic_state.metadata_json, '$.lastPracticeOrderKey'), '')
             THEN excluded.status ELSE grammar_topic_state.status
           END,
           self_confidence = CASE
             WHEN json_extract(excluded.metadata_json, '$.lastPracticeOrderKey') >=
               COALESCE(json_extract(grammar_topic_state.metadata_json, '$.lastPracticeOrderKey'), '')
             THEN excluded.self_confidence ELSE grammar_topic_state.self_confidence
           END,
           metadata_json = CASE
             WHEN json_extract(excluded.metadata_json, '$.lastPracticeOrderKey') >=
               COALESCE(json_extract(grammar_topic_state.metadata_json, '$.lastPracticeOrderKey'), '')
             THEN excluded.metadata_json ELSE grammar_topic_state.metadata_json
           END,
           version = grammar_topic_state.version + 1,
           server_seq = excluded.server_seq`,
      )
      .bind(
        learnerId,
        grammarTopicId,
        status,
        occurredAt,
        occurredAt,
        input.selfRating / 4,
        stateChangeId,
        metadata,
      ),
    db
      .prepare(
        `UPDATE projection_state SET
          dirty = 1,
          last_attempt_at = CASE
            WHEN last_attempt_at IS NULL OR last_attempt_at < ? THEN ?
            ELSE last_attempt_at
          END
         WHERE learner_id = ?`,
      )
      .bind(occurredAt, occurredAt, learnerId),
  ];
  if (options.forceFailureAfterWrites) {
    statements.push(forcedFailureStatement(db, input.eventId));
  }
  await db.batch(statements);
}

async function insertScheduledAttempt(
  db: D1Database,
  learnerId: LearnerId,
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
          (change_id, learner_id, entity_type, entity_id, operation, changed_at)
         VALUES (?, ?, 'attempt', ?, 'upsert', ?)`,
      )
      .bind(attemptChangeId, learnerId, input.eventId, receivedAt),
    db
      .prepare(
        `INSERT INTO server_changes
          (change_id, learner_id, entity_type, entity_id, operation, changed_at)
         VALUES (?, ?, 'card_state', ?, 'upsert', ?)`,
      )
      .bind(stateChangeId, learnerId, input.cardId, receivedAt),
    attemptInsert(db, learnerId, input, review.occurredAt, receivedAt, attemptChangeId),
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
         WHERE learner_id = ? AND card_id = ? AND version = ?`,
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
        learnerId,
        input.cardId,
        currentState.version,
      ),
    db
      .prepare("INSERT INTO atomic_write_guards (guard_id, assertion) VALUES (?, changes())")
      .bind(guardId),
    db.prepare("DELETE FROM atomic_write_guards WHERE guard_id = ?").bind(guardId),
    db
      .prepare(
        `UPDATE projection_state SET
          dirty = 1,
          last_attempt_at = CASE
            WHEN last_attempt_at IS NULL OR last_attempt_at < ? THEN ?
            ELSE last_attempt_at
          END
         WHERE learner_id = ?`,
      )
      .bind(review.occurredAt, review.occurredAt, learnerId),
  ];

  if (options.forceFailureAfterWrites) {
    statements.push(forcedFailureStatement(db, input.eventId));
  }
  await db.batch(statements);
}

function attemptInsert(
  db: D1Database,
  learnerId: LearnerId,
  input: AttemptInput,
  occurredAt: number,
  receivedAt: number,
  changeId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO attempts
        (event_id, learner_id, device_id, device_seq, occurred_at, received_at, card_id,
         study_session_id, mode, activity_type, correct, score, self_rating,
         response_ms, expected_card_state_version, metadata_json, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT seq FROM server_changes WHERE change_id = ?))`,
    )
    .bind(
      input.eventId,
      learnerId,
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

async function findAttempt(
  db: D1Database,
  learnerId: LearnerId,
  eventId: string,
): Promise<ExistingAttemptRow | null> {
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
       WHERE a.learner_id = ? AND a.event_id = ?`,
    )
    .bind(learnerId, eventId)
    .first<ExistingAttemptRow>();
}

async function duplicateResult(
  db: D1Database,
  learnerId: LearnerId,
  existing: ExistingAttemptRow,
  input: AttemptInput,
  occurredAt: number,
): Promise<IngestResult> {
  assertDuplicatePayload(existing, input, occurredAt);
  const state =
    existing.review_rating === null ? null : await getCardState(db, learnerId, existing.card_id);
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

async function getCardState(
  db: D1Database,
  learnerId: LearnerId,
  cardId: string,
): Promise<CardStateRow | null> {
  return db
    .prepare(
      `SELECT card_id, due_at, stability, difficulty, elapsed_days, scheduled_days,
        learning_steps, reps, lapses, state, last_review_at, version, server_seq, rebuilt_at
       FROM card_state WHERE learner_id = ? AND card_id = ?`,
    )
    .bind(learnerId, cardId)
    .first<CardStateRow>();
}

async function loadCanonicalHistory(
  db: D1Database,
  learnerId: LearnerId,
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
       WHERE a.learner_id = ? AND r.card_id = ?`,
    )
    .bind(learnerId, cardId)
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

async function validatePronunciationAttempt(
  db: D1Database,
  input: AttemptInput,
  card: CardRow,
): Promise<void> {
  if (input.mode === "reflex" && isReflexActivity(card.activity_type)) return;
  const pronunciationCard = isPronunciationActivity(card.activity_type);
  if (!pronunciationCard && input.mode !== "pronunciation") return;
  if (!pronunciationCard) {
    throw new InvalidInputError("pronunciation mode requires a pronunciation activity");
  }
  if (input.mode !== "pronunciation") {
    throw new InvalidInputError("pronunciation activities require pronunciation mode");
  }
  if (card.scheduler_eligible !== 0 || input.fsrsReview !== undefined) {
    throw new InvalidInputError("pronunciation sessions are ordinary practice, not FSRS reviews");
  }
  if (input.expectedCardStateVersion !== undefined) {
    throw new InvalidInputError("pronunciation practice must not carry card state versions");
  }

  if (input.metadata?.interaction === PRONUNCIATION_AUDIO_SKIP_INTERACTION) {
    if (input.activityType !== "audio_to_hanzi" && input.activityType !== "audio_to_meaning") {
      throw new InvalidInputError("uncached-audio skips require an audio pronunciation card");
    }
    if (
      input.correct !== undefined ||
      input.selfRating !== undefined ||
      input.score !== undefined ||
      input.metadata.selectedChoiceId !== undefined
    ) {
      throw new InvalidInputError("uncached-audio skips must not claim a graded response");
    }
    if (input.metadata.reason !== PRONUNCIATION_AUDIO_SKIP_REASON) {
      throw new InvalidInputError("uncached-audio skips require their canonical reason");
    }
    if (card.lexeme_reading_id === null || input.metadata.readingId !== card.lexeme_reading_id) {
      throw new InvalidInputError("uncached-audio skips must preserve the exact reading identity");
    }
    return;
  }

  if (input.activityType === "pronunciation_production") {
    if (input.selfRating === undefined) {
      throw new InvalidInputError("pronunciation production requires a self-rating");
    }
    if (input.correct !== undefined || input.score !== undefined) {
      throw new InvalidInputError(
        "pronunciation production keeps self-rating separate from correctness and score",
      );
    }
    return;
  }

  if (input.correct === undefined) {
    throw new InvalidInputError("pronunciation perception and recall require correctness");
  }
  if (input.selfRating !== undefined || input.score !== undefined) {
    throw new InvalidInputError(
      "pronunciation perception and recall keep correctness separate from self-rating and score",
    );
  }

  if (input.activityType === "hanzi_to_pinyin") return;
  if (card.lexeme_reading_id === null) {
    throw new InvalidInputError("pronunciation cards must reference an exact reading");
  }
  const selectedChoiceId = input.metadata?.selectedChoiceId;
  if (typeof selectedChoiceId !== "string" || selectedChoiceId.length === 0) {
    throw new InvalidInputError("objective pronunciation attempts require a selected choice");
  }

  let answerChoiceId = card.lexeme_reading_id;
  if (
    input.activityType === "tone_identification" ||
    input.activityType === "tone_pair_identification"
  ) {
    // An offline attempt is an immutable fact about content that was valid when
    // the prompt was cached. Retirement must not make that delayed fact invalid.
    const reading = await db
      .prepare("SELECT numeric_pinyin FROM lexeme_readings WHERE id = ?")
      .bind(card.lexeme_reading_id)
      .first<{ numeric_pinyin: string }>();
    if (!reading) throw new ReferenceNotFoundError("lexeme reading", card.lexeme_reading_id);
    const syllables = normalizeNumericPinyin(reading.numeric_pinyin);
    if (input.activityType === "tone_identification") {
      const tone = singleTone(syllables);
      if (tone === null) throw new Error("tone-identification card has no single tone");
      answerChoiceId = `tone:${tone}`;
    } else {
      const pair = deriveTonePair(syllables);
      if (pair === null) throw new Error("tone-pair card has no exact pair");
      answerChoiceId = `tone-pair:${pair[0]}-${pair[1]}`;
    }
  }
  if (input.correct !== (selectedChoiceId === answerChoiceId)) {
    throw new InvalidInputError("pronunciation correctness disagrees with the selected choice");
  }
}

async function validateReflexAttempt(
  db: D1Database,
  learnerId: LearnerId,
  input: AttemptInput,
  card: CardRow,
): Promise<void> {
  if (input.mode !== "reflex") return;
  if (input.fsrsReview !== undefined || input.expectedCardStateVersion !== undefined) {
    throw new InvalidInputError("reflex attempts must not carry FSRS review state");
  }
  // Before the automaticity drill existed, `reflex` was already a valid
  // ordinary-practice taxonomy value. Preserve those immutable legacy facts;
  // the prepared-session contract is identified by its canonical interaction.
  if (input.metadata?.interaction !== REFLEX_INTERACTION) return;
  if (!isReflexActivity(input.activityType)) {
    throw new InvalidInputError("reflex mode only supports its activated objective activities");
  }
  if (input.correct === undefined) {
    throw new InvalidInputError("reflex attempts require correctness");
  }
  if (input.score !== undefined || input.selfRating !== undefined) {
    throw new InvalidInputError(
      "reflex attempts keep objective correctness separate from other grades",
    );
  }
  if (!input.studySessionId) {
    throw new InvalidInputError("reflex attempts must belong to a prepared reflex session");
  }
  if (card.activity_type !== input.activityType) {
    throw new InvalidInputError("reflex attempt activity does not match its card");
  }

  const metadata = parseReflexAttemptMetadata(input.metadata, {
    legacyResponseMs: input.responseMs,
  });
  if (
    metadata.timingInterrupted ? input.responseMs !== undefined : input.responseMs === undefined
  ) {
    throw new InvalidInputError(
      metadata.timingInterrupted
        ? "interrupted reflex timing must not carry response time"
        : "uninterrupted reflex attempts require response time",
    );
  }
  const preparedItem = await getPreparedReflexItem(
    db,
    learnerId,
    input.studySessionId,
    input.cardId,
  );
  if (!preparedItem) {
    throw new InvalidInputError("reflex card was not part of the prepared session");
  }
  const {
    card: prepared,
    maxItems,
    completedItems,
    endedAt,
    activityType,
    choiceCount,
  } = preparedItem;
  if (endedAt !== null || completedItems >= maxItems) {
    throw new InvalidInputError("reflex session has already reached its prepared bound");
  }
  if (metadata.round > maxItems) {
    throw new InvalidInputError("reflex presentation exceeds the prepared session bound");
  }
  if (metadata.round !== completedItems + 1) {
    throw new InvalidInputError("reflex presentation is not the canonical next session round");
  }
  if (
    prepared.activityType !== input.activityType ||
    metadata.prompt !== prepared.prompt ||
    metadata.promptHint !== prepared.promptHint ||
    metadata.answerChoiceId !== prepared.answerChoiceId ||
    metadata.presentationId !== `${input.studySessionId}:${metadata.round}:${input.cardId}`
  ) {
    throw new InvalidInputError("reflex presentation does not match its prepared learning item");
  }
  if (metadata.choiceCount !== choiceCount) {
    throw new InvalidInputError("reflex choice count does not match its prepared session");
  }
  if (activityType !== "mixed" && input.activityType !== activityType) {
    throw new InvalidInputError("reflex activity does not match its prepared session setting");
  }
  const preparedOptions = [...prepared.choices].map(({ id, label }) => `${id}\0${label}`).sort();
  const presentedOptions = metadata.options.map(({ id, label }) => `${id}\0${label}`).sort();
  if (
    preparedOptions.length !== presentedOptions.length ||
    preparedOptions.some((option, index) => option !== presentedOptions[index])
  ) {
    throw new InvalidInputError("reflex options do not match the prepared distractor set");
  }
  if (!metadata.options.some(({ id }) => id === metadata.selectedChoiceId)) {
    throw new InvalidInputError("reflex selected choice was not presented");
  }
  if (input.correct !== (metadata.selectedChoiceId === prepared.answerChoiceId)) {
    throw new InvalidInputError("reflex correctness disagrees with the selected choice");
  }
}

async function validateReadingGrammarAttempt(
  db: D1Database,
  input: AttemptInput,
  card: CardRow,
): Promise<void> {
  const guidedMode = input.mode === "reading" || input.mode === "grammar";
  if (card.activity_type !== "sentence_reading" && !guidedMode) return;
  if (card.activity_type !== "sentence_reading") {
    throw new InvalidInputError("reading and grammar modes require sentence-reading activities");
  }
  if (!guidedMode) {
    throw new InvalidInputError("sentence-reading activities require reading or grammar mode");
  }
  if (
    card.scheduler_eligible !== 0 ||
    input.fsrsReview !== undefined ||
    input.expectedCardStateVersion !== undefined
  ) {
    throw new InvalidInputError("reading and grammar practice must not mutate FSRS state");
  }
  if (input.selfRating === undefined) {
    throw new InvalidInputError("reading and grammar practice requires a self-rating");
  }
  if (input.score !== undefined) {
    throw new InvalidInputError("reading and grammar practice keeps score unset");
  }

  if (input.mode === "reading") {
    if (card.subject_type !== "sentence" || card.sentence_id === null) {
      throw new InvalidInputError("reading mode requires a sentence card");
    }
    if (input.correct !== undefined) {
      throw new InvalidInputError("sentence reading keeps self-rating separate from correctness");
    }
    if (
      input.metadata?.interaction !== "staged-sentence-reading" ||
      input.metadata.sentenceId !== card.sentence_id ||
      JSON.stringify(input.metadata.revealOrder) !==
        JSON.stringify(["vocabulary", "pinyin", "meaning", "grammar"])
    ) {
      throw new InvalidInputError("reading attempts must preserve their staged sentence reveal");
    }
    return;
  }

  if (card.subject_type !== "grammar_topic" || card.grammar_topic_id === null) {
    throw new InvalidInputError("grammar mode requires a grammar-topic card");
  }
  if (input.correct === undefined) {
    throw new InvalidInputError("grammar choice practice requires correctness");
  }
  const selectedChoiceId = input.metadata?.selectedChoiceId;
  const sentenceId = input.metadata?.sentenceId;
  const practiceVersionId = input.metadata?.practiceVersionId;
  if (
    input.metadata?.interaction !== "grammar-choice" ||
    input.metadata.topicId !== card.grammar_topic_id ||
    typeof selectedChoiceId !== "string" ||
    typeof sentenceId !== "string" ||
    typeof practiceVersionId !== "string"
  ) {
    throw new InvalidInputError(
      "grammar attempts must preserve topic, practice version, sentence, and choice identity",
    );
  }
  const practiceVersion = await db
    .prepare(
      `SELECT sentence_id, practice_json
       FROM grammar_practice_versions
       WHERE id = ? AND grammar_topic_id = ?`,
    )
    .bind(practiceVersionId, card.grammar_topic_id)
    .first<{ sentence_id: string; practice_json: string }>();
  if (!practiceVersion) {
    throw new ReferenceNotFoundError("grammar practice version", practiceVersionId);
  }
  if (practiceVersion.sentence_id !== sentenceId) {
    throw new InvalidInputError("grammar practice sentence does not match its cached version");
  }
  const practice = parseGrammarPracticeMetadata(practiceVersion.practice_json);
  if (!practice.choices.some(({ id }) => id === selectedChoiceId)) {
    throw new InvalidInputError("grammar choice is not part of the presented practice");
  }
  if (input.correct !== (selectedChoiceId === practice.answerChoiceId)) {
    throw new InvalidInputError("grammar correctness disagrees with the selected choice");
  }
}

async function assertDeviceSequenceAvailable(
  db: D1Database,
  learnerId: LearnerId,
  input: AttemptInput,
): Promise<void> {
  const owner = await db
    .prepare(
      "SELECT event_id FROM attempts WHERE learner_id = ? AND device_id = ? AND device_seq = ?",
    )
    .bind(learnerId, input.deviceId, input.deviceSeq)
    .first<AttemptIdentityRow>();
  if (owner && owner.event_id !== input.eventId) {
    throw new ConflictError(
      `device sequence ${input.deviceId}/${input.deviceSeq} already belongs to another event`,
    );
  }
}

function mapReflexSequenceConstraint(input: AttemptInput, error: unknown): unknown {
  if (input.mode !== "reflex" || input.metadata?.interaction !== REFLEX_INTERACTION) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("canonical Reflex attempt is not the next session round") ||
    message.includes("canonical Reflex session reached its prepared bound") ||
    message.includes("canonical Reflex session has ended")
  ) {
    return new ConflictError("reflex session advanced before this response could be accepted");
  }
  return error;
}

async function assertStudySessionOwnedByDevice(
  db: D1Database,
  learnerId: LearnerId,
  studySessionId: string | undefined,
  deviceId: string,
  mode: AttemptInput["mode"],
): Promise<void> {
  if (studySessionId === undefined) return;
  const session = await db
    .prepare("SELECT id, device_id, mode FROM study_sessions WHERE learner_id = ? AND id = ?")
    .bind(learnerId, studySessionId)
    .first<{ id: string; device_id: string; mode: AttemptInput["mode"] }>();
  if (!session) throw new ReferenceNotFoundError("study session", studySessionId);
  if (session.device_id !== deviceId) {
    throw new ConflictError(`study session ${studySessionId} belongs to another device`);
  }
  if (session.mode !== mode) {
    throw new ConflictError(`study session ${studySessionId} belongs to another learning mode`);
  }
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
