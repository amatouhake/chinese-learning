import { ConflictError, ReferenceNotFoundError } from "../domain/errors";
import {
  DEFAULT_REFLEX_POOL_SIZE,
  REFLEX_SLOW_RESPONSE_MS,
  reflexHistorySummary,
  selectReflexPool,
  type CreateReflexSessionInput,
} from "../domain/reflex";
import type {
  OfflineReflexPack,
  ReflexActivityType,
  ReflexCard,
  ReflexChoice,
  ReflexSessionView,
  PronunciationMedia,
  StudyMeaning,
} from "../domain/types";

interface ReflexCandidateRow {
  card_id: string;
  activity_type: ReflexActivityType;
  lexeme_id: string;
  reading_id: string | null;
  simplified: string;
  pinyin: string | null;
  sense_scope: string | null;
  meanings_json: string;
  attempts: number;
  incorrect: number;
  slow: number;
  average_response_ms: number | null;
  last_trouble_at: number | null;
  media_id: string | null;
  media_delivery_key: string | null;
  media_license: string | null;
  media_attribution: string | null;
}

interface ReflexSessionRow {
  id: string;
  device_id: string;
  started_at: number;
  ended_at: number | null;
  context_json: string;
}

interface ReflexSessionContext {
  maxItems: number;
  cards: ReflexCard[];
}

interface CandidateModel {
  row: ReflexCandidateRow;
  prompt: string;
  promptHint: string | null;
  choiceLabel: string;
  ambiguityKey: string;
}

export interface ReflexServiceOptions {
  now?: () => number;
}

export interface CreateReflexSessionResult {
  disposition: "created" | "existing";
  session: ReflexSessionView;
}

export async function createReflexSession(
  db: D1Database,
  input: CreateReflexSessionInput,
  options: ReflexServiceOptions = {},
): Promise<CreateReflexSessionResult> {
  const existing = await loadSession(db, input.sessionId);
  if (existing) return existingSessionResult(db, existing, input.deviceId);

  const now = serverTime(options);
  const candidates = await buildCandidateCards(db, now);
  const cards = selectReflexPool(
    candidates,
    input.sessionId,
    Math.min(DEFAULT_REFLEX_POOL_SIZE, input.maxItems),
  );
  const contextJson = JSON.stringify({
    maxItems: input.maxItems,
    cards,
  } satisfies ReflexSessionContext);
  const changeId = `reflex-session:start:${input.sessionId}`;

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO server_changes
            (change_id, entity_type, entity_id, operation, changed_at)
           VALUES (?, 'study_session', ?, 'upsert', ?)`,
        )
        .bind(changeId, input.sessionId, now),
      db
        .prepare(
          `INSERT INTO study_sessions
            (id, device_id, mode, started_at, context_json, server_seq)
           VALUES (?, ?, 'reflex', ?, ?,
             (SELECT seq FROM server_changes WHERE change_id = ?))`,
        )
        .bind(input.sessionId, input.deviceId, now, contextJson, changeId),
    ]);
  } catch (error) {
    const raced = await loadSession(db, input.sessionId);
    if (raced) return existingSessionResult(db, raced, input.deviceId);
    throw error;
  }

  const created = await loadSession(db, input.sessionId);
  if (!created) throw new Error("created reflex session could not be reloaded");
  return { disposition: "created", session: await mapSession(db, created) };
}

export async function getOfflineReflexPack(
  db: D1Database,
  sessionId: string,
  deviceId: string,
  options: ReflexServiceOptions = {},
): Promise<OfflineReflexPack> {
  const row = await loadOwnedSession(db, sessionId, deviceId);
  const context = parseContext(row.context_json);
  let session = await mapSession(db, row);
  if (
    row.ended_at !== null ||
    session.completedItems >= session.maxItems ||
    context.cards.length === 0
  ) {
    if (row.ended_at === null) {
      await completeSession(db, row, session, options);
      session = await mapSession(db, (await loadSession(db, sessionId)) ?? row);
    }
    return {
      status: session.completedItems === 0 ? "empty" : "completed",
      session,
      cards: [],
    };
  }
  return { status: "cards", session, cards: context.cards };
}

export async function getPreparedReflexItem(
  db: D1Database,
  sessionId: string,
  cardId: string,
): Promise<{
  card: ReflexCard;
  maxItems: number;
  completedItems: number;
  endedAt: number | null;
} | null> {
  const row = await loadSession(db, sessionId);
  if (!row) return null;
  const context = parseContext(row.context_json);
  const card = context.cards.find((candidate) => candidate.cardId === cardId);
  if (!card) return null;
  return {
    card,
    maxItems: context.maxItems,
    completedItems: await canonicalAttemptCount(db, sessionId),
    endedAt: row.ended_at,
  };
}

async function buildCandidateCards(db: D1Database, now: number): Promise<ReflexCard[]> {
  const result = await db
    .prepare(
      `SELECT
         c.id AS card_id,
         c.activity_type,
         l.id AS lexeme_id,
         r.id AS reading_id,
         l.simplified,
         r.pinyin,
         r.sense_scope,
         l.meanings_json,
         (
           SELECT m.id
           FROM lexeme_readings media_reading
           JOIN lexeme_reading_media media_link
             ON media_link.lexeme_reading_id = media_reading.id
            AND media_link.role = 'word_pronunciation'
           JOIN media_assets m ON m.id = media_link.media_asset_id
           WHERE media_reading.id = COALESCE(
             r.id,
             (
               SELECT preferred_reading.id
               FROM lexeme_readings preferred_reading
               WHERE preferred_reading.lexeme_id = l.id
                 AND preferred_reading.is_preferred = 1
                 AND preferred_reading.retired_at IS NULL
               ORDER BY preferred_reading.id
               LIMIT 1
             )
           )
             AND 1 = (
               SELECT COUNT(*) FROM lexeme_readings active_reading
               WHERE active_reading.lexeme_id = l.id
                 AND active_reading.retired_at IS NULL
             )
           LIMIT 1
         ) AS media_id,
         (
           SELECT m.delivery_key
           FROM lexeme_readings media_reading
           JOIN lexeme_reading_media media_link
             ON media_link.lexeme_reading_id = media_reading.id
            AND media_link.role = 'word_pronunciation'
           JOIN media_assets m ON m.id = media_link.media_asset_id
           WHERE media_reading.id = COALESCE(
             r.id,
             (
               SELECT preferred_reading.id
               FROM lexeme_readings preferred_reading
               WHERE preferred_reading.lexeme_id = l.id
                 AND preferred_reading.is_preferred = 1
                 AND preferred_reading.retired_at IS NULL
               ORDER BY preferred_reading.id
               LIMIT 1
             )
           )
             AND 1 = (
               SELECT COUNT(*) FROM lexeme_readings active_reading
               WHERE active_reading.lexeme_id = l.id
                 AND active_reading.retired_at IS NULL
             )
           LIMIT 1
         ) AS media_delivery_key,
         (
           SELECT m.license
           FROM lexeme_readings media_reading
           JOIN lexeme_reading_media media_link
             ON media_link.lexeme_reading_id = media_reading.id
            AND media_link.role = 'word_pronunciation'
           JOIN media_assets m ON m.id = media_link.media_asset_id
           WHERE media_reading.id = COALESCE(
             r.id,
             (
               SELECT preferred_reading.id
               FROM lexeme_readings preferred_reading
               WHERE preferred_reading.lexeme_id = l.id
                 AND preferred_reading.is_preferred = 1
                 AND preferred_reading.retired_at IS NULL
               ORDER BY preferred_reading.id
               LIMIT 1
             )
           )
             AND 1 = (
               SELECT COUNT(*) FROM lexeme_readings active_reading
               WHERE active_reading.lexeme_id = l.id
                 AND active_reading.retired_at IS NULL
             )
           LIMIT 1
         ) AS media_license,
         (
           SELECT m.attribution
           FROM lexeme_readings media_reading
           JOIN lexeme_reading_media media_link
             ON media_link.lexeme_reading_id = media_reading.id
            AND media_link.role = 'word_pronunciation'
           JOIN media_assets m ON m.id = media_link.media_asset_id
           WHERE media_reading.id = COALESCE(
             r.id,
             (
               SELECT preferred_reading.id
               FROM lexeme_readings preferred_reading
               WHERE preferred_reading.lexeme_id = l.id
                 AND preferred_reading.is_preferred = 1
                 AND preferred_reading.retired_at IS NULL
               ORDER BY preferred_reading.id
               LIMIT 1
             )
           )
             AND 1 = (
               SELECT COUNT(*) FROM lexeme_readings active_reading
               WHERE active_reading.lexeme_id = l.id
                 AND active_reading.retired_at IS NULL
             )
           LIMIT 1
         ) AS media_attribution,
         COUNT(a.event_id) AS attempts,
         COALESCE(SUM(CASE WHEN a.correct = 0 THEN 1 ELSE 0 END), 0) AS incorrect,
         COALESCE(SUM(CASE WHEN a.response_ms >= ? THEN 1 ELSE 0 END), 0) AS slow,
         AVG(a.response_ms) AS average_response_ms,
         MAX(CASE
           WHEN a.correct = 0 OR a.response_ms >= ? THEN a.occurred_at
           ELSE NULL
         END) AS last_trouble_at
       FROM cards c
       LEFT JOIN lexeme_readings r ON r.id = c.lexeme_reading_id
       JOIN lexemes l ON l.id = COALESCE(c.lexeme_id, r.lexeme_id)
       LEFT JOIN attempts a ON a.card_id = c.id AND a.mode = 'reflex'
         AND json_extract(a.metadata_json, '$.interaction') = 'reflex-multiple-choice'
       WHERE c.activity_type IN (
           'hanzi_to_meaning', 'meaning_to_hanzi', 'hanzi_to_pinyin', 'pinyin_to_hanzi'
         )
         AND c.retired_at IS NULL
         AND (r.id IS NULL OR r.retired_at IS NULL)
         AND EXISTS (
           SELECT 1
           FROM cards introduced
           JOIN card_state introduced_state ON introduced_state.card_id = introduced.id
           WHERE introduced.lexeme_id = l.id
             AND introduced.activity_type IN ('hanzi_to_meaning', 'meaning_to_hanzi')
             AND introduced_state.reps > 0
         )
         AND (
           c.activity_type IN ('meaning_to_hanzi', 'pinyin_to_hanzi')
           OR 1 = (
             SELECT COUNT(*) FROM lexeme_readings sibling
             WHERE sibling.lexeme_id = l.id AND sibling.retired_at IS NULL
           )
         )
       GROUP BY c.id, c.activity_type, l.id, r.id, l.simplified, r.pinyin,
         r.sense_scope, l.meanings_json
       ORDER BY c.activity_type, c.id`,
    )
    .bind(REFLEX_SLOW_RESPONSE_MS, REFLEX_SLOW_RESPONSE_MS)
    .all<ReflexCandidateRow>();

  const models = result.results.map(toCandidateModel);
  const ambiguityCounts = new Map<string, number>();
  for (const model of models) {
    ambiguityCounts.set(model.ambiguityKey, (ambiguityCounts.get(model.ambiguityKey) ?? 0) + 1);
  }

  const cards: ReflexCard[] = [];
  for (const target of models) {
    if (
      (target.row.activity_type === "meaning_to_hanzi" ||
        target.row.activity_type === "pinyin_to_hanzi") &&
      ambiguityCounts.get(target.ambiguityKey) !== 1
    ) {
      continue;
    }
    const choices = buildChoices(target, models);
    if (choices.length !== 4) continue;
    cards.push({
      cardId: target.row.card_id,
      lexemeId: target.row.lexeme_id,
      readingId: target.row.reading_id,
      activityType: target.row.activity_type,
      prompt: target.prompt,
      promptHint: target.promptHint,
      answerChoiceId: target.row.card_id,
      choices,
      media: mediaFromRow(target.row),
      history: reflexHistorySummary(
        {
          attempts: target.row.attempts,
          incorrect: target.row.incorrect,
          slow: target.row.slow,
          averageResponseMs: target.row.average_response_ms,
          lastTroubleAt: target.row.last_trouble_at,
        },
        now,
      ),
    });
  }
  return cards;
}

function mediaFromRow(row: ReflexCandidateRow): PronunciationMedia | null {
  if (
    row.media_id === null ||
    row.media_delivery_key === null ||
    row.media_license === null ||
    row.media_attribution === null
  ) {
    return null;
  }
  return {
    id: row.media_id,
    url: `/media/${row.media_delivery_key}`,
    license: row.media_license,
    attribution: row.media_attribution,
  };
}

function toCandidateModel(row: ReflexCandidateRow): CandidateModel {
  const meaning = displayReflexMeaning(row.meanings_json, row.sense_scope);
  switch (row.activity_type) {
    case "hanzi_to_meaning":
      return {
        row,
        prompt: row.simplified,
        promptHint: row.pinyin,
        choiceLabel: meaning,
        ambiguityKey: `${row.activity_type}\0${row.lexeme_id}`,
      };
    case "meaning_to_hanzi":
      return {
        row,
        prompt: meaning,
        promptHint: "この意味に合う漢字を選ぶ",
        choiceLabel: row.simplified,
        ambiguityKey: `${row.activity_type}\0${normalizeLabel(meaning)}`,
      };
    case "hanzi_to_pinyin":
      if (!row.pinyin) throw new Error(`reflex reading card has no pinyin: ${row.card_id}`);
      return {
        row,
        prompt: row.simplified,
        promptHint: meaning,
        choiceLabel: row.pinyin,
        ambiguityKey: `${row.activity_type}\0${row.lexeme_id}`,
      };
    case "pinyin_to_hanzi":
      if (!row.pinyin) throw new Error(`reflex reading card has no pinyin: ${row.card_id}`);
      return {
        row,
        prompt: row.pinyin,
        promptHint: meaning,
        choiceLabel: row.simplified,
        ambiguityKey: `${row.activity_type}\0${normalizeLabel(row.pinyin)}\0${normalizeLabel(meaning)}`,
      };
  }
}

function buildChoices(target: CandidateModel, models: readonly CandidateModel[]): ReflexChoice[] {
  const choices: ReflexChoice[] = [{ id: target.row.card_id, label: target.choiceLabel }];
  const labels = new Set([normalizeLabel(target.choiceLabel)]);
  const distractors = models
    .filter(
      (candidate) =>
        candidate.row.activity_type === target.row.activity_type &&
        candidate.row.card_id !== target.row.card_id &&
        candidate.row.lexeme_id !== target.row.lexeme_id,
    )
    .sort(
      (left, right) =>
        stableHash(`${target.row.card_id}\0${left.row.card_id}`) -
          stableHash(`${target.row.card_id}\0${right.row.card_id}`) ||
        left.row.card_id.localeCompare(right.row.card_id),
    );
  for (const distractor of distractors) {
    const normalized = normalizeLabel(distractor.choiceLabel);
    if (labels.has(normalized)) continue;
    labels.add(normalized);
    choices.push({ id: distractor.row.card_id, label: distractor.choiceLabel });
    if (choices.length === 4) break;
  }
  return choices;
}

async function loadOwnedSession(
  db: D1Database,
  sessionId: string,
  deviceId: string,
): Promise<ReflexSessionRow> {
  const row = await loadSession(db, sessionId);
  if (!row) throw new ReferenceNotFoundError("reflex session", sessionId);
  if (row.device_id !== deviceId) {
    throw new ConflictError(`reflex session ${sessionId} belongs to another device`);
  }
  return row;
}

function loadSession(db: D1Database, sessionId: string): Promise<ReflexSessionRow | null> {
  return db
    .prepare(
      `SELECT id, device_id, started_at, ended_at, context_json
       FROM study_sessions WHERE id = ? AND mode = 'reflex'`,
    )
    .bind(sessionId)
    .first<ReflexSessionRow>();
}

async function existingSessionResult(
  db: D1Database,
  row: ReflexSessionRow,
  deviceId: string,
): Promise<CreateReflexSessionResult> {
  if (row.device_id !== deviceId) {
    throw new ConflictError(`reflex session ${row.id} belongs to another device`);
  }
  return { disposition: "existing", session: await mapSession(db, row) };
}

async function mapSession(db: D1Database, row: ReflexSessionRow): Promise<ReflexSessionView> {
  const context = parseContext(row.context_json);
  return {
    id: row.id,
    deviceId: row.device_id,
    maxItems: context.maxItems,
    completedItems: await canonicalAttemptCount(db, row.id),
    poolSize: context.cards.length,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

async function completeSession(
  db: D1Database,
  row: ReflexSessionRow,
  session: ReflexSessionView,
  options: ReflexServiceOptions,
): Promise<void> {
  const now = serverTime(options);
  const changeId = `reflex-session:complete:${row.id}`;
  const result = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END), 0) AS correct,
         AVG(response_ms) AS average_response_ms
       FROM attempts WHERE study_session_id = ? AND mode = 'reflex'
         AND json_extract(metadata_json, '$.interaction') = 'reflex-multiple-choice'`,
    )
    .bind(row.id)
    .first<{ correct: number; average_response_ms: number | null }>();
  const aggregate = JSON.stringify({
    completedItems: session.completedItems,
    correct: result?.correct ?? 0,
    averageResponseMs: result?.average_response_ms ?? null,
  });
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO server_changes
          (change_id, entity_type, entity_id, operation, changed_at)
         VALUES (?, 'study_session', ?, 'upsert', ?)`,
      )
      .bind(changeId, row.id, now),
    db
      .prepare(
        `UPDATE study_sessions SET ended_at = ?, aggregate_json = ?,
          server_seq = (SELECT seq FROM server_changes WHERE change_id = ?)
         WHERE id = ? AND ended_at IS NULL`,
      )
      .bind(now, aggregate, changeId, row.id),
  ]);
}

async function canonicalAttemptCount(db: D1Database, sessionId: string): Promise<number> {
  return (
    (await db
      .prepare(
        `SELECT COUNT(*) AS count FROM attempts
         WHERE study_session_id = ? AND mode = 'reflex'
           AND json_extract(metadata_json, '$.interaction') = 'reflex-multiple-choice'`,
      )
      .bind(sessionId)
      .first<number>("count")) ?? 0
  );
}

function parseContext(json: string): ReflexSessionContext {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger((value as Record<string, unknown>).maxItems) ||
    !Array.isArray((value as Record<string, unknown>).cards)
  ) {
    throw new Error("persisted reflex session context is invalid");
  }
  return value as ReflexSessionContext;
}

export function displayReflexMeaning(meaningsJson: string, senseScope: string | null): string {
  const lexemeMeanings = parseMeanings(meaningsJson);
  if (senseScope !== null) {
    const value: unknown = JSON.parse(senseScope);
    if (Array.isArray(value)) {
      const meanings = value.filter((item): item is string => typeof item === "string");
      if (meanings.length > 0) return meanings.join("; ");
    }
  }
  const japanese = lexemeMeanings.find(({ language }) => language === "ja")?.text;
  if (japanese) return japanese;
  const english = lexemeMeanings
    .filter(({ language }) => language === "en")
    .map(({ text }) => text);
  if (english.length > 0) return english.join("; ");
  const fallback = lexemeMeanings[0]?.text;
  if (!fallback) throw new Error("reflex candidate has no displayable meaning");
  return fallback;
}

function parseMeanings(json: string): StudyMeaning[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("persisted meanings must be an array");
  return value.map((meaning) => {
    if (
      typeof meaning === "object" &&
      meaning !== null &&
      typeof (meaning as Record<string, unknown>).language === "string" &&
      typeof (meaning as Record<string, unknown>).text === "string"
    ) {
      return meaning as StudyMeaning;
    }
    if (typeof meaning === "string") return { language: "und", text: meaning };
    throw new Error("persisted meaning has an invalid shape");
  });
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replaceAll(/\s+/gu, " ");
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function serverTime(options: ReflexServiceOptions): number {
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("server time must be non-negative");
  return now;
}
