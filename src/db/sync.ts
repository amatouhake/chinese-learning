import { getOfflinePronunciationPack } from "./pronunciation";
import { getOfflineReflexPack } from "./reflex";
import { getOfflineStudyPack } from "./study";
import { getOfflineGrammarPack, getOfflineReadingPack } from "./reading-grammar";
import type { SyncPullInput } from "../domain/sync-validation";
import type { SyncLearnerChange, SyncPullResponse } from "../domain/types";

const PULL_LIMIT = 100;

interface ChangeRow {
  seq: number;
  entity_type: "attempt" | "card_state" | "content" | "grammar_topic_state" | "study_session";
  entity_id: string;
  operation: "upsert" | "delete";
  content_revision: number | null;
  attempt_event_id: string | null;
  attempt_device_id: string | null;
  attempt_device_seq: number | null;
  attempt_card_id: string | null;
  attempt_occurred_at: number | null;
  attempt_review_created: number;
  state_card_id: string | null;
  state_due_at: number | null;
  state_stability: number | null;
  state_difficulty: number | null;
  state_elapsed_days: number | null;
  state_scheduled_days: number | null;
  state_learning_steps: number | null;
  state_reps: number | null;
  state_lapses: number | null;
  state_state: number | null;
  state_last_review_at: number | null;
  state_version: number | null;
  state_server_seq: number | null;
  state_rebuilt_at: number | null;
  session_id: string | null;
  session_mode: string | null;
  session_ended_at: number | null;
  grammar_topic_id: string | null;
  grammar_status: "introduced" | "learning" | "comfortable" | null;
  grammar_introduced_at: number | null;
  grammar_last_studied_at: number | null;
  grammar_self_confidence: number | null;
  grammar_version: number | null;
  grammar_server_seq: number | null;
}

export async function pullSyncChanges(
  db: D1Database,
  input: SyncPullInput,
): Promise<SyncPullResponse> {
  const [changeResult, settings] = await Promise.all([
    db
      .prepare(
        `SELECT sc.seq, sc.entity_type, sc.entity_id, sc.operation, sc.content_revision,
           a.event_id AS attempt_event_id,
           a.device_id AS attempt_device_id,
           a.device_seq AS attempt_device_seq,
           a.card_id AS attempt_card_id,
           a.occurred_at AS attempt_occurred_at,
           CASE WHEN r.attempt_id IS NULL THEN 0 ELSE 1 END AS attempt_review_created,
           cs.card_id AS state_card_id,
           cs.due_at AS state_due_at,
           cs.stability AS state_stability,
           cs.difficulty AS state_difficulty,
           cs.elapsed_days AS state_elapsed_days,
           cs.scheduled_days AS state_scheduled_days,
           cs.learning_steps AS state_learning_steps,
           cs.reps AS state_reps,
           cs.lapses AS state_lapses,
           cs.state AS state_state,
           cs.last_review_at AS state_last_review_at,
           cs.version AS state_version,
           cs.server_seq AS state_server_seq,
           cs.rebuilt_at AS state_rebuilt_at,
           ss.id AS session_id,
           ss.mode AS session_mode,
           ss.ended_at AS session_ended_at,
           gs.grammar_topic_id,
           gs.status AS grammar_status,
           gs.introduced_at AS grammar_introduced_at,
           gs.last_studied_at AS grammar_last_studied_at,
           gs.self_confidence AS grammar_self_confidence,
           gs.version AS grammar_version,
           gs.server_seq AS grammar_server_seq
         FROM server_changes sc
         LEFT JOIN attempts a
           ON sc.entity_type = 'attempt' AND a.event_id = sc.entity_id
         LEFT JOIN fsrs_reviews r ON r.attempt_id = a.event_id
         LEFT JOIN card_state cs
           ON sc.entity_type = 'card_state' AND cs.card_id = sc.entity_id
         LEFT JOIN study_sessions ss
           ON sc.entity_type = 'study_session' AND ss.id = sc.entity_id
         LEFT JOIN grammar_topic_state gs
           ON sc.entity_type = 'grammar_topic_state' AND gs.grammar_topic_id = sc.entity_id
         WHERE sc.seq > ?
         ORDER BY sc.seq
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
    learnerChanges.push(mapLearnerChange(row));
  }

  const currentContentRevision = settings?.current_content_revision ?? null;
  const [studyPack, reflexPack, pronunciationPack, readingPack, grammarPack] = await Promise.all([
    input.studySessionId
      ? getOfflineStudyPack(db, input.studySessionId, input.deviceId)
      : Promise.resolve(null),
    input.reflexSessionId
      ? getOfflineReflexPack(db, input.reflexSessionId, input.deviceId)
      : Promise.resolve(null),
    input.pronunciationSessionId
      ? getOfflinePronunciationPack(db, input.pronunciationSessionId, input.deviceId)
      : Promise.resolve(null),
    input.readingSessionId
      ? getOfflineReadingPack(db, input.readingSessionId, input.deviceId)
      : Promise.resolve(null),
    input.grammarSessionId
      ? getOfflineGrammarPack(db, input.grammarSessionId, input.deviceId)
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
    reflexPack,
    pronunciationPack,
    readingPack,
    grammarPack,
  };
}

function mapLearnerChange(row: ChangeRow): SyncLearnerChange {
  if (row.entity_type === "attempt") {
    if (
      row.attempt_event_id === null ||
      row.attempt_device_id === null ||
      row.attempt_device_seq === null ||
      row.attempt_card_id === null ||
      row.attempt_occurred_at === null
    ) {
      throw new Error(`attempt change ${row.seq} has no canonical attempt`);
    }
    return {
      seq: row.seq,
      entityType: "attempt",
      eventId: row.attempt_event_id,
      deviceId: row.attempt_device_id,
      deviceSeq: row.attempt_device_seq,
      cardId: row.attempt_card_id,
      occurredAt: row.attempt_occurred_at,
      reviewCreated: row.attempt_review_created === 1,
    };
  }
  if (row.entity_type === "card_state") {
    if (
      row.state_card_id === null ||
      row.state_due_at === null ||
      row.state_stability === null ||
      row.state_difficulty === null ||
      row.state_elapsed_days === null ||
      row.state_scheduled_days === null ||
      row.state_learning_steps === null ||
      row.state_reps === null ||
      row.state_lapses === null ||
      row.state_state === null ||
      row.state_version === null ||
      row.state_rebuilt_at === null
    ) {
      throw new Error(`card-state change ${row.seq} has no canonical state`);
    }
    return {
      seq: row.seq,
      entityType: "card_state",
      cardState: {
        cardId: row.state_card_id,
        dueAt: row.state_due_at,
        stability: row.state_stability,
        difficulty: row.state_difficulty,
        elapsedDays: row.state_elapsed_days,
        scheduledDays: row.state_scheduled_days,
        learningSteps: row.state_learning_steps,
        reps: row.state_reps,
        lapses: row.state_lapses,
        state: row.state_state,
        lastReviewAt: row.state_last_review_at,
        version: row.state_version,
        serverSeq: row.state_server_seq,
        rebuiltAt: row.state_rebuilt_at,
      },
    };
  }
  if (row.entity_type === "study_session") {
    if (
      row.session_id === null ||
      (row.session_mode !== "study" &&
        row.session_mode !== "reflex" &&
        row.session_mode !== "pronunciation" &&
        row.session_mode !== "reading" &&
        row.session_mode !== "grammar")
    ) {
      throw new Error(`study-session change ${row.seq} has no supported session`);
    }
    return {
      seq: row.seq,
      entityType: "study_session",
      sessionId: row.session_id,
      mode: row.session_mode,
      endedAt: row.session_ended_at,
    };
  }
  if (row.grammar_topic_id === null || row.grammar_version === null) {
    throw new Error(`grammar-topic-state change ${row.seq} has no canonical state`);
  }
  return {
    seq: row.seq,
    entityType: "grammar_topic_state",
    state: {
      grammarTopicId: row.grammar_topic_id,
      status: row.grammar_status,
      introducedAt: row.grammar_introduced_at,
      lastStudiedAt: row.grammar_last_studied_at,
      selfConfidence: row.grammar_self_confidence,
      version: row.grammar_version,
      serverSeq: row.grammar_server_seq,
    },
  };
}
