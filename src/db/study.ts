import { ConflictError, InvalidInputError, ReferenceNotFoundError } from "../domain/errors";
import type {
  OfflineStudyPack,
  LearnerId,
  StudyCard,
  StudyMeaning,
  StudyNextResult,
  StudyDirection,
  StudySessionView,
} from "../domain/types";
import type { CreateStudySessionInput } from "../domain/study-validation";
import { registerLearnerDevice } from "./learners";

interface StudySessionRow {
  id: string;
  learner_id: string;
  device_id: string;
  started_at: number;
  ended_at: number | null;
  context_json: string;
}

interface StudyCardRow {
  card_id: string;
  lexeme_id: string;
  activity_type: StudyCard["activityType"];
  due_at: number;
  reps: number;
  lapses: number;
  version: number;
  simplified: string;
  traditional: string | null;
  meanings_json: string;
  pinyin: string | null;
  numeric_pinyin: string | null;
  preferred_meanings_json: string | null;
  hsk_level: number | null;
  media_id: string | null;
  media_delivery_key: string | null;
  media_license: string | null;
  media_attribution: string | null;
  example_chinese: string | null;
  example_pinyin: string | null;
  example_meaning_ja: string | null;
  example_meaning_en: string | null;
}

interface SchedulerRow {
  id: string;
}

interface SessionContext {
  maxCards: number;
  direction: StudyDirection;
}

export interface StudyServiceOptions {
  now?: () => number;
}

export interface CreateStudySessionResult {
  disposition: "created" | "existing";
  session: StudySessionView;
}

export async function createStudySession(
  db: D1Database,
  learnerId: LearnerId,
  input: CreateStudySessionInput,
  options: StudyServiceOptions = {},
): Promise<CreateStudySessionResult> {
  await registerLearnerDevice(db, learnerId, input.deviceId);
  const existing = await loadSession(db, learnerId, input.sessionId);
  if (existing) return existingSessionResult(db, existing, input.deviceId);

  const now = serverTime(options);
  const changeId = `study-session:start:${input.sessionId}`;
  const contextJson = JSON.stringify({
    maxCards: input.maxCards,
    direction: input.direction ?? "mixed",
  } satisfies SessionContext);

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO server_changes
            (change_id, learner_id, entity_type, entity_id, operation, changed_at)
           VALUES (?, ?, 'study_session', ?, 'upsert', ?)`,
        )
        .bind(changeId, learnerId, input.sessionId, now),
      db
        .prepare(
          `INSERT INTO study_sessions
            (id, learner_id, device_id, mode, started_at, context_json, server_seq)
           VALUES (?, ?, ?, 'study', ?, ?,
             (SELECT seq FROM server_changes WHERE change_id = ?))`,
        )
        .bind(input.sessionId, learnerId, input.deviceId, now, contextJson, changeId),
    ]);
  } catch (error) {
    const raced = await loadSession(db, learnerId, input.sessionId);
    if (raced) return existingSessionResult(db, raced, input.deviceId);
    throw error;
  }

  const created = await loadSession(db, learnerId, input.sessionId);
  if (!created) throw new Error("created study session could not be reloaded");
  return {
    disposition: "created",
    session: await mapSession(db, created),
  };
}

export async function getNextStudyCard(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
  deviceId: string,
  options: StudyServiceOptions = {},
): Promise<StudyNextResult> {
  const session = await loadOwnedStudySession(db, learnerId, sessionId, deviceId);
  const sessionView = await mapSession(db, session);

  if (session.ended_at !== null || sessionView.reviewedCards >= sessionView.maxCards) {
    if (session.ended_at === null) await completeStudySession(db, session, sessionView, options);
    return {
      status: sessionView.reviewedCards === 0 ? "empty" : "completed",
      session: await mapSession(db, (await loadSession(db, learnerId, sessionId)) ?? session),
      card: null,
    };
  }

  const now = serverTime(options);
  const selection = await selectPreferredStudyCard(
    db,
    learnerId,
    sessionId,
    now,
    sessionView.direction,
    [],
    await recentStudyLexemeIds(db, learnerId, sessionId),
  );
  if (!selection) {
    await completeStudySession(db, session, sessionView, { now: () => now });
    return {
      status: sessionView.reviewedCards === 0 ? "empty" : "completed",
      session: await mapSession(db, (await loadSession(db, learnerId, sessionId)) ?? session),
      card: null,
    };
  }

  const schedulerConfigId = await currentSchedulerId(db);

  return {
    status: "card",
    session: sessionView,
    card: mapStudyCard(selection.card, selection.source, schedulerConfigId),
  };
}

export async function getOfflineStudyPack(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
  deviceId: string,
  options: StudyServiceOptions = {},
): Promise<OfflineStudyPack> {
  const session = await loadOwnedStudySession(db, learnerId, sessionId, deviceId);
  let sessionView = await mapSession(db, session);
  if (session.ended_at !== null || sessionView.reviewedCards >= sessionView.maxCards) {
    if (session.ended_at === null) {
      await completeStudySession(db, session, sessionView, options);
      sessionView = await mapSession(db, (await loadSession(db, learnerId, sessionId)) ?? session);
    }
    return {
      status: sessionView.reviewedCards === 0 ? "empty" : "completed",
      session: sessionView,
      cards: [],
    };
  }

  const now = serverTime(options);
  const schedulerConfigId = await currentSchedulerId(db);
  const cards: StudyCard[] = [];
  const excludedCardIds: string[] = [];
  let recentLexemeIds = await recentStudyLexemeIds(db, learnerId, sessionId);
  const remaining = sessionView.maxCards - sessionView.reviewedCards;
  for (let index = 0; index < remaining; index += 1) {
    const selection = await selectPreferredStudyCard(
      db,
      learnerId,
      sessionId,
      now,
      sessionView.direction,
      excludedCardIds,
      recentLexemeIds,
    );
    if (!selection) break;
    excludedCardIds.push(selection.card.card_id);
    recentLexemeIds = [
      selection.card.lexeme_id,
      ...recentLexemeIds.filter((id) => id !== selection.card.lexeme_id),
    ].slice(0, 2);
    cards.push(mapStudyCard(selection.card, selection.source, schedulerConfigId));
  }

  if (cards.length === 0) {
    await completeStudySession(db, session, sessionView, { now: () => now });
    sessionView = await mapSession(db, (await loadSession(db, learnerId, sessionId)) ?? session);
    return {
      status: sessionView.reviewedCards === 0 ? "empty" : "completed",
      session: sessionView,
      cards,
    };
  }
  return { status: "cards", session: sessionView, cards };
}

async function selectStudyCard(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
  now: number,
  source: "due" | "new",
  excludedCardIds: readonly string[] = [],
  direction: StudyDirection = "mixed",
  avoidedLexemeIds: readonly string[] = [],
): Promise<StudyCardRow | null> {
  const schedulingPredicate = source === "due" ? "cs.reps > 0 AND cs.due_at <= ?" : "cs.reps = 0";
  const directionPredicate =
    direction === "mixed"
      ? "AND c.activity_type IN ('hanzi_to_meaning', 'meaning_to_hanzi')"
      : "AND c.activity_type = ?";
  const exclusionPredicate =
    excludedCardIds.length === 0
      ? ""
      : `AND c.id NOT IN (${excludedCardIds.map(() => "?").join(", ")})`;
  const avoidedLexemePredicate =
    avoidedLexemeIds.length === 0
      ? ""
      : `AND l.id NOT IN (${avoidedLexemeIds.map(() => "?").join(", ")})`;
  // Vocabulary Study cards are lexeme-level and carry no exact reading ID.
  // Keep the single-active-reading guard so they cannot borrow a sibling's audio.
  return db
    .prepare(
      `SELECT
        c.id AS card_id,
        l.id AS lexeme_id,
        c.activity_type,
        cs.due_at,
        cs.reps,
        cs.lapses,
        cs.version,
        l.simplified,
        l.traditional,
        l.meanings_json,
        (
          SELECT r.pinyin FROM lexeme_readings r
          WHERE r.lexeme_id = l.id AND r.is_preferred = 1 AND r.retired_at IS NULL
          ORDER BY r.id LIMIT 1
        ) AS pinyin,
        (
          SELECT r.numeric_pinyin FROM lexeme_readings r
          WHERE r.lexeme_id = l.id AND r.is_preferred = 1 AND r.retired_at IS NULL
          ORDER BY r.id LIMIT 1
        ) AS numeric_pinyin,
        (
          SELECT r.sense_scope FROM lexeme_readings r
          WHERE r.lexeme_id = l.id AND r.is_preferred = 1 AND r.retired_at IS NULL
          ORDER BY r.id LIMIT 1
        ) AS preferred_meanings_json,
        (
          SELECT MIN(CAST(substr(t.label, 7) AS INTEGER))
          FROM lexeme_tags lt JOIN tags t ON t.id = lt.tag_id
          WHERE lt.lexeme_id = l.id AND t.kind = 'hsk-2.0'
        ) AS hsk_level,
        (
          SELECT m.id
          FROM lexeme_readings media_reading
          JOIN lexeme_reading_media media_link
            ON media_link.lexeme_reading_id = media_reading.id
           AND media_link.role = 'word_pronunciation'
          JOIN media_assets m ON m.id = media_link.media_asset_id
          WHERE media_reading.lexeme_id = l.id
            AND media_reading.is_preferred = 1
            AND media_reading.retired_at IS NULL
            AND 1 = (
              SELECT COUNT(*) FROM lexeme_readings active_reading
              WHERE active_reading.lexeme_id = l.id
                AND active_reading.retired_at IS NULL
            )
          ORDER BY media_reading.id
          LIMIT 1
        ) AS media_id,
        (
          SELECT m.delivery_key
          FROM lexeme_readings media_reading
          JOIN lexeme_reading_media media_link
            ON media_link.lexeme_reading_id = media_reading.id
           AND media_link.role = 'word_pronunciation'
          JOIN media_assets m ON m.id = media_link.media_asset_id
          WHERE media_reading.lexeme_id = l.id
            AND media_reading.is_preferred = 1
            AND media_reading.retired_at IS NULL
            AND 1 = (
              SELECT COUNT(*) FROM lexeme_readings active_reading
              WHERE active_reading.lexeme_id = l.id
                AND active_reading.retired_at IS NULL
            )
          ORDER BY media_reading.id
          LIMIT 1
        ) AS media_delivery_key,
        (
          SELECT m.license
          FROM lexeme_readings media_reading
          JOIN lexeme_reading_media media_link
            ON media_link.lexeme_reading_id = media_reading.id
           AND media_link.role = 'word_pronunciation'
          JOIN media_assets m ON m.id = media_link.media_asset_id
          WHERE media_reading.lexeme_id = l.id
            AND media_reading.is_preferred = 1
            AND media_reading.retired_at IS NULL
            AND 1 = (
              SELECT COUNT(*) FROM lexeme_readings active_reading
              WHERE active_reading.lexeme_id = l.id
                AND active_reading.retired_at IS NULL
            )
          ORDER BY media_reading.id
          LIMIT 1
        ) AS media_license,
        (
          SELECT m.attribution
          FROM lexeme_readings media_reading
          JOIN lexeme_reading_media media_link
            ON media_link.lexeme_reading_id = media_reading.id
           AND media_link.role = 'word_pronunciation'
          JOIN media_assets m ON m.id = media_link.media_asset_id
          WHERE media_reading.lexeme_id = l.id
            AND media_reading.is_preferred = 1
            AND media_reading.retired_at IS NULL
            AND 1 = (
              SELECT COUNT(*) FROM lexeme_readings active_reading
              WHERE active_reading.lexeme_id = l.id
                AND active_reading.retired_at IS NULL
            )
          ORDER BY media_reading.id
          LIMIT 1
        ) AS media_attribution,
        (
          SELECT s.chinese
          FROM sentence_lexemes sl JOIN sentences s ON s.id = sl.sentence_id
          WHERE sl.lexeme_id = l.id AND s.retired_at IS NULL
          ORDER BY CASE WHEN sl.role = 'target' THEN 0 ELSE 1 END, s.id LIMIT 1
        ) AS example_chinese,
        (
          SELECT s.pinyin
          FROM sentence_lexemes sl JOIN sentences s ON s.id = sl.sentence_id
          WHERE sl.lexeme_id = l.id AND s.retired_at IS NULL
          ORDER BY CASE WHEN sl.role = 'target' THEN 0 ELSE 1 END, s.id LIMIT 1
        ) AS example_pinyin,
        (
          SELECT s.meaning_ja
          FROM sentence_lexemes sl JOIN sentences s ON s.id = sl.sentence_id
          WHERE sl.lexeme_id = l.id AND s.retired_at IS NULL
          ORDER BY CASE WHEN sl.role = 'target' THEN 0 ELSE 1 END, s.id LIMIT 1
        ) AS example_meaning_ja,
        (
          SELECT s.meaning_en
          FROM sentence_lexemes sl JOIN sentences s ON s.id = sl.sentence_id
          WHERE sl.lexeme_id = l.id AND s.retired_at IS NULL
          ORDER BY CASE WHEN sl.role = 'target' THEN 0 ELSE 1 END, s.id LIMIT 1
        ) AS example_meaning_en
       FROM cards c
       JOIN card_state cs ON cs.card_id = c.id AND cs.learner_id = ?
       JOIN lexemes l ON l.id = c.lexeme_id
       WHERE c.subject_type = 'lexeme'
         ${directionPredicate}
         AND c.scheduler_eligible = 1
         AND c.retired_at IS NULL
         AND ${schedulingPredicate}
         AND NOT EXISTS (
           SELECT 1 FROM attempts a
           WHERE a.learner_id = ? AND a.study_session_id = ? AND a.card_id = c.id
         )
         ${exclusionPredicate}
         ${avoidedLexemePredicate}
       ORDER BY
         ${source === "due" ? "cs.due_at," : ""}
         COALESCE(hsk_level, 2147483647),
         COALESCE(l.frequency_rank, 2147483647),
         l.simplified,
         CASE c.activity_type WHEN 'hanzi_to_meaning' THEN 0 ELSE 1 END,
         c.id
       LIMIT 1`,
    )
    .bind(
      learnerId,
      ...(direction === "mixed" ? [] : [direction]),
      ...(source === "due" ? [now] : []),
      learnerId,
      sessionId,
      ...excludedCardIds,
      ...avoidedLexemeIds,
    )
    .first<StudyCardRow>();
}

async function selectPreferredStudyCard(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
  now: number,
  direction: StudyDirection,
  excludedCardIds: readonly string[],
  avoidedLexemeIds: readonly string[],
): Promise<{ card: StudyCardRow; source: "due" | "new" } | null> {
  const dueAwayFromRecent = await selectStudyCard(
    db,
    learnerId,
    sessionId,
    now,
    "due",
    excludedCardIds,
    direction,
    avoidedLexemeIds,
  );
  if (dueAwayFromRecent) return { card: dueAwayFromRecent, source: "due" };

  // If the only due card is the same lexeme just shown, use a different new
  // card when one exists. The due sibling remains eligible for the next slot.
  const newAwayFromRecent = await selectStudyCard(
    db,
    learnerId,
    sessionId,
    now,
    "new",
    excludedCardIds,
    direction,
    avoidedLexemeIds,
  );
  if (newAwayFromRecent) return { card: newAwayFromRecent, source: "new" };

  const dueFallback = await selectStudyCard(
    db,
    learnerId,
    sessionId,
    now,
    "due",
    excludedCardIds,
    direction,
  );
  if (dueFallback) return { card: dueFallback, source: "due" };
  const newFallback = await selectStudyCard(
    db,
    learnerId,
    sessionId,
    now,
    "new",
    excludedCardIds,
    direction,
  );
  return newFallback ? { card: newFallback, source: "new" } : null;
}

async function recentStudyLexemeIds(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT c.lexeme_id
       FROM attempts a
       JOIN cards c ON c.id = a.card_id
       WHERE a.learner_id = ? AND a.study_session_id = ?
       ORDER BY a.occurred_at DESC, a.device_id DESC, a.device_seq DESC
       LIMIT 2`,
    )
    .bind(learnerId, sessionId)
    .all<{ lexeme_id: string }>();
  return result.results.map(({ lexeme_id }) => lexeme_id);
}

async function currentSchedulerId(db: D1Database): Promise<string> {
  const scheduler = await db
    .prepare("SELECT id FROM scheduler_configs WHERE is_current = 1")
    .first<SchedulerRow>();
  if (!scheduler) throw new Error("no current scheduler configuration is available");
  return scheduler.id;
}

async function loadOwnedStudySession(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
  deviceId: string,
): Promise<StudySessionRow> {
  if (!sessionId.trim() || !deviceId.trim()) {
    throw new InvalidInputError("session and device IDs must be non-empty");
  }
  const session = await loadSession(db, learnerId, sessionId);
  if (!session) throw new ReferenceNotFoundError("study session", sessionId);
  if (session.device_id !== deviceId) {
    throw new ConflictError(`study session ${sessionId} belongs to another device`);
  }
  return session;
}

async function loadSession(
  db: D1Database,
  learnerId: LearnerId,
  id: string,
): Promise<StudySessionRow | null> {
  return db
    .prepare(
      `SELECT id, learner_id, device_id, started_at, ended_at, context_json
       FROM study_sessions WHERE learner_id = ? AND id = ? AND mode = 'study'`,
    )
    .bind(learnerId, id)
    .first<StudySessionRow>();
}

async function existingSessionResult(
  db: D1Database,
  session: StudySessionRow,
  deviceId: string,
): Promise<CreateStudySessionResult> {
  if (session.device_id !== deviceId) {
    throw new ConflictError(`study session ${session.id} belongs to another device`);
  }
  return { disposition: "existing", session: await mapSession(db, session) };
}

async function mapSession(db: D1Database, row: StudySessionRow): Promise<StudySessionView> {
  const context = parseSessionContext(row.context_json);
  const reviewed = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM attempts a JOIN fsrs_reviews r ON r.attempt_id = a.event_id
       WHERE a.learner_id = ? AND a.study_session_id = ?`,
    )
    .bind(row.learner_id, row.id)
    .first<{ count: number }>();
  return {
    id: row.id,
    deviceId: row.device_id,
    maxCards: context.maxCards,
    direction: context.direction,
    reviewedCards: reviewed?.count ?? 0,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

async function completeStudySession(
  db: D1Database,
  row: StudySessionRow,
  view: StudySessionView,
  options: StudyServiceOptions,
): Promise<void> {
  const now = serverTime(options);
  const changeId = `study-session:complete:${row.id}`;
  const aggregateJson = JSON.stringify({ reviewedCards: view.reviewedCards });
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO server_changes
          (change_id, learner_id, entity_type, entity_id, operation, changed_at)
         VALUES (?, ?, 'study_session', ?, 'upsert', ?)`,
      )
      .bind(changeId, row.learner_id, row.id, now),
    db
      .prepare(
        `UPDATE study_sessions SET
          ended_at = ?, aggregate_json = ?,
          server_seq = (SELECT seq FROM server_changes WHERE change_id = ?)
         WHERE learner_id = ? AND id = ? AND ended_at IS NULL`,
      )
      .bind(now, aggregateJson, changeId, row.learner_id, row.id),
  ]);
}

function mapStudyCard(
  row: StudyCardRow,
  source: "due" | "new",
  schedulerConfigId: string,
): StudyCard {
  return {
    cardId: row.card_id,
    activityType: row.activity_type,
    source,
    schedulerConfigId,
    state: {
      dueAt: row.due_at,
      reps: row.reps,
      lapses: row.lapses,
      version: row.version,
    },
    lexeme: {
      simplified: row.simplified,
      traditional: row.traditional,
      pinyin: row.pinyin,
      numericPinyin: row.numeric_pinyin,
      meanings: selectStudyMeanings(row.meanings_json, row.preferred_meanings_json),
      hskLevel: row.hsk_level,
    },
    media:
      row.media_id === null ||
      row.media_delivery_key === null ||
      row.media_license === null ||
      row.media_attribution === null
        ? null
        : {
            id: row.media_id,
            url: `/media/${row.media_delivery_key}`,
            license: row.media_license,
            attribution: row.media_attribution,
          },
    example:
      row.example_chinese === null
        ? null
        : {
            chinese: row.example_chinese,
            pinyin: row.example_pinyin,
            meaningJa: row.example_meaning_ja,
            meaningEn: row.example_meaning_en,
          },
  };
}

function selectStudyMeanings(
  lexemeMeaningsJson: string,
  preferredMeaningsJson: string | null,
): StudyMeaning[] {
  const lexemeMeanings = parseMeanings(lexemeMeaningsJson);
  if (preferredMeaningsJson === null) return lexemeMeanings;

  const value: unknown = JSON.parse(preferredMeaningsJson);
  if (!Array.isArray(value)) {
    throw new Error("persisted preferred reading meanings must be an array of strings");
  }
  const preferredMeanings = value.map((meaning: unknown) => {
    if (typeof meaning !== "string") {
      throw new Error("persisted preferred reading meanings must be an array of strings");
    }
    return meaning;
  });
  return [
    ...preferredMeanings.map((text) => ({ language: "en", text })),
    ...lexemeMeanings.filter(({ language }) => language !== "en"),
  ];
}

function parseMeanings(json: string): StudyMeaning[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("persisted lexeme meanings must be an array");
  return value.map((meaning) => {
    if (typeof meaning === "string") return { language: "und", text: meaning };
    if (
      typeof meaning === "object" &&
      meaning !== null &&
      typeof (meaning as Record<string, unknown>).language === "string" &&
      typeof (meaning as Record<string, unknown>).text === "string"
    ) {
      return meaning as StudyMeaning;
    }
    throw new Error("persisted lexeme meaning has an invalid shape");
  });
}

function parseSessionContext(json: string): SessionContext {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger((value as Record<string, unknown>).maxCards)
  ) {
    throw new Error("persisted study session context is invalid");
  }
  const direction = (value as Record<string, unknown>).direction;
  if (
    direction !== undefined &&
    direction !== "mixed" &&
    direction !== "hanzi_to_meaning" &&
    direction !== "meaning_to_hanzi"
  ) {
    throw new Error("persisted study session direction is invalid");
  }
  return {
    maxCards: (value as { maxCards: number }).maxCards,
    direction: (direction as StudyDirection | undefined) ?? "mixed",
  };
}

function serverTime(options: StudyServiceOptions): number {
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("server time must be a non-negative integer");
  }
  return now;
}
