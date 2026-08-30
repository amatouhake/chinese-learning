import { getOfflinePronunciationPack } from "./pronunciation";
import { getOfflineStudyPack } from "./study";
import type { SyncPullInput } from "../domain/sync-validation";
import type { MaterializedCardState, SyncLearnerChange, SyncPullResponse } from "../domain/types";

const PULL_LIMIT = 100;

interface ChangeRow {
  seq: number;
  entity_type: "attempt" | "card_state" | "content" | "grammar_topic_state" | "study_session";
  entity_id: string;
  operation: "upsert" | "delete";
  content_revision: number | null;
}

interface AttemptChangeRow {
  event_id: string;
  device_id: string;
  device_seq: number;
  card_id: string;
  occurred_at: number;
  review_created: number;
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

interface SessionChangeRow {
  id: string;
  mode: "study" | "pronunciation";
  ended_at: number | null;
}

export async function pullSyncChanges(
  db: D1Database,
  input: SyncPullInput,
): Promise<SyncPullResponse> {
  const [changeResult, settings] = await Promise.all([
    db
      .prepare(
        `SELECT seq, entity_type, entity_id, operation, content_revision
         FROM server_changes
         WHERE seq > ?
         ORDER BY seq
         LIMIT ?`,
      )
      .bind(input.cursor, PULL_LIMIT + 1)
      .all<ChangeRow>(),
    db
      .prepare("SELECT current_content_revision FROM learner_settings WHERE singleton = 1")
      .first<{ current_content_revision: number | null }>(),
  ]);

  const rows = changeResult.results.slice(0, PULL_LIMIT);
  const learnerChanges: SyncLearnerChange[] = [];
  const contentChanges: SyncPullResponse["contentChanges"] = [];
  for (const row of rows) {
    if (row.entity_type === "content") {
      if (row.content_revision === null) {
        throw new Error(`content change ${row.seq} has no revision`);
      }
      contentChanges.push({
        seq: row.seq,
        entityId: row.entity_id,
        operation: row.operation,
        revision: row.content_revision,
      });
      continue;
    }
    learnerChanges.push(await mapLearnerChange(db, row));
  }

  const currentContentRevision = settings?.current_content_revision ?? null;
  const [studyPack, pronunciationPack] = await Promise.all([
    input.studySessionId
      ? getOfflineStudyPack(db, input.studySessionId, input.deviceId)
      : Promise.resolve(null),
    input.pronunciationSessionId
      ? getOfflinePronunciationPack(db, input.pronunciationSessionId, input.deviceId)
      : Promise.resolve(null),
  ]);

  return {
    nextCursor: rows.at(-1)?.seq ?? input.cursor,
    hasMore: changeResult.results.length > PULL_LIMIT,
    currentContentRevision,
    contentChanged: input.contentRevision !== currentContentRevision,
    learnerChanges,
    contentChanges,
    studyPack,
    pronunciationPack,
  };
}

async function mapLearnerChange(db: D1Database, row: ChangeRow): Promise<SyncLearnerChange> {
  if (row.entity_type === "attempt") {
    const attempt = await db
      .prepare(
        `SELECT a.event_id, a.device_id, a.device_seq, a.card_id, a.occurred_at,
           CASE WHEN r.attempt_id IS NULL THEN 0 ELSE 1 END AS review_created
         FROM attempts a
         LEFT JOIN fsrs_reviews r ON r.attempt_id = a.event_id
         WHERE a.event_id = ?`,
      )
      .bind(row.entity_id)
      .first<AttemptChangeRow>();
    if (!attempt) throw new Error(`attempt change ${row.seq} has no canonical attempt`);
    return {
      seq: row.seq,
      entityType: "attempt",
      eventId: attempt.event_id,
      deviceId: attempt.device_id,
      deviceSeq: attempt.device_seq,
      cardId: attempt.card_id,
      occurredAt: attempt.occurred_at,
      reviewCreated: attempt.review_created === 1,
    };
  }
  if (row.entity_type === "card_state") {
    const state = await db
      .prepare(
        `SELECT card_id, due_at, stability, difficulty, elapsed_days, scheduled_days,
           learning_steps, reps, lapses, state, last_review_at, version, server_seq, rebuilt_at
         FROM card_state WHERE card_id = ?`,
      )
      .bind(row.entity_id)
      .first<CardStateRow>();
    if (!state) throw new Error(`card-state change ${row.seq} has no canonical state`);
    return { seq: row.seq, entityType: "card_state", cardState: mapCardState(state) };
  }
  if (row.entity_type === "study_session") {
    const session = await db
      .prepare("SELECT id, mode, ended_at FROM study_sessions WHERE id = ?")
      .bind(row.entity_id)
      .first<SessionChangeRow>();
    if (!session || (session.mode !== "study" && session.mode !== "pronunciation")) {
      throw new Error(`study-session change ${row.seq} has no supported session`);
    }
    return {
      seq: row.seq,
      entityType: "study_session",
      sessionId: session.id,
      mode: session.mode,
      endedAt: session.ended_at,
    };
  }
  return { seq: row.seq, entityType: "grammar_topic_state", entityId: row.entity_id };
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
