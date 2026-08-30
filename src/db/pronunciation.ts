import { ConflictError, InvalidInputError, ReferenceNotFoundError } from "../domain/errors";
import {
  activitiesForFocus,
  deriveTonePair,
  normalizeNumericPinyin,
  singleTone,
  TONES,
  untonedPinyin,
  type PronunciationActivityType,
  type PronunciationFocus,
  type Tone,
} from "../domain/pronunciation";
import type { CreatePronunciationSessionInput } from "../domain/pronunciation-validation";
import type {
  OfflinePronunciationPack,
  PronunciationCard,
  PronunciationChoice,
  PronunciationNextResult,
  PronunciationSessionView,
} from "../domain/types";

interface PronunciationSessionRow {
  id: string;
  device_id: string;
  started_at: number;
  ended_at: number | null;
  context_json: string;
}

interface PronunciationSessionContext {
  focus: PronunciationFocus;
  maxItems: number;
}

interface PronunciationCardRow {
  card_id: string;
  activity_type: PronunciationActivityType;
  lexeme_id: string;
  reading_id: string;
  pinyin: string;
  numeric_pinyin: string;
  normalized_syllables_json: string;
  sense_scope: string | null;
  simplified: string;
  traditional: string | null;
  hsk_level: number | null;
  media_id: string | null;
  delivery_key: string | null;
  license: string | null;
  attribution: string | null;
}

interface DistractorRow {
  reading_id: string;
  simplified: string;
  sense_scope: string | null;
}

export interface PronunciationServiceOptions {
  now?: () => number;
}

export interface CreatePronunciationSessionResult {
  disposition: "created" | "existing";
  session: PronunciationSessionView;
}

export async function createPronunciationSession(
  db: D1Database,
  input: CreatePronunciationSessionInput,
  options: PronunciationServiceOptions = {},
): Promise<CreatePronunciationSessionResult> {
  const existing = await loadSession(db, input.sessionId);
  if (existing) return existingSessionResult(db, existing, input);

  const now = serverTime(options);
  const changeId = `pronunciation-session:start:${input.sessionId}`;
  const contextJson = JSON.stringify({
    focus: input.focus,
    maxItems: input.maxItems,
  } satisfies PronunciationSessionContext);

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
           VALUES (?, ?, 'pronunciation', ?, ?,
             (SELECT seq FROM server_changes WHERE change_id = ?))`,
        )
        .bind(input.sessionId, input.deviceId, now, contextJson, changeId),
    ]);
  } catch (error) {
    const raced = await loadSession(db, input.sessionId);
    if (raced) return existingSessionResult(db, raced, input);
    throw error;
  }

  const created = await loadSession(db, input.sessionId);
  if (!created) throw new Error("created pronunciation session could not be reloaded");
  return { disposition: "created", session: await mapSession(db, created) };
}

export async function getNextPronunciationCard(
  db: D1Database,
  sessionId: string,
  deviceId: string,
  options: PronunciationServiceOptions = {},
): Promise<PronunciationNextResult> {
  const session = await loadOwnedSession(db, sessionId, deviceId);
  const sessionView = await mapSession(db, session);
  if (session.ended_at !== null || sessionView.completedItems >= sessionView.maxItems) {
    if (session.ended_at === null) await completeSession(db, session, sessionView, options);
    return {
      status: sessionView.completedItems === 0 ? "empty" : "completed",
      session: await mapSession(db, (await loadSession(db, sessionId)) ?? session),
      card: null,
    };
  }

  const selected = await selectForFocus(
    db,
    sessionId,
    sessionView.focus,
    sessionView.completedItems,
  );
  if (!selected) {
    await completeSession(db, session, sessionView, options);
    return {
      status: sessionView.completedItems === 0 ? "empty" : "completed",
      session: await mapSession(db, (await loadSession(db, sessionId)) ?? session),
      card: null,
    };
  }

  return {
    status: "card",
    session: sessionView,
    card: await mapCard(db, selected),
  };
}

export async function getOfflinePronunciationPack(
  db: D1Database,
  sessionId: string,
  deviceId: string,
  options: PronunciationServiceOptions = {},
): Promise<OfflinePronunciationPack> {
  const session = await loadOwnedSession(db, sessionId, deviceId);
  let sessionView = await mapSession(db, session);
  if (session.ended_at !== null || sessionView.completedItems >= sessionView.maxItems) {
    if (session.ended_at === null) {
      await completeSession(db, session, sessionView, options);
      sessionView = await mapSession(db, (await loadSession(db, sessionId)) ?? session);
    }
    return {
      status: sessionView.completedItems === 0 ? "empty" : "completed",
      session: sessionView,
      cards: [],
    };
  }

  const rows: PronunciationCardRow[] = [];
  const excludedCardIds: string[] = [];
  const excludedLexemeIds: string[] = [];
  const remaining = sessionView.maxItems - sessionView.completedItems;
  for (let index = 0; index < remaining; index += 1) {
    const selected = await selectForFocus(
      db,
      sessionId,
      sessionView.focus,
      sessionView.completedItems + index,
      excludedCardIds,
      excludedLexemeIds,
    );
    if (!selected) break;
    rows.push(selected);
    excludedCardIds.push(selected.card_id);
    excludedLexemeIds.push(selected.lexeme_id);
  }

  if (rows.length === 0) {
    await completeSession(db, session, sessionView, options);
    sessionView = await mapSession(db, (await loadSession(db, sessionId)) ?? session);
    return {
      status: sessionView.completedItems === 0 ? "empty" : "completed",
      session: sessionView,
      cards: [],
    };
  }
  return {
    status: "cards",
    session: sessionView,
    cards: await Promise.all(rows.map((row) => mapCard(db, row))),
  };
}

async function selectForFocus(
  db: D1Database,
  sessionId: string,
  focus: PronunciationFocus,
  completedItems: number,
  excludedCardIds: readonly string[] = [],
  excludedLexemeIds: readonly string[] = [],
): Promise<PronunciationCardRow | null> {
  const activities = activitiesForFocus(focus);
  const rotated = activities.map(
    (_, index) => activities[(completedItems + index) % activities.length]!,
  );
  for (const excludeUsedLexemes of [true, false]) {
    for (const activity of rotated) {
      const card = await selectCard(
        db,
        sessionId,
        activity,
        excludeUsedLexemes,
        excludedCardIds,
        excludeUsedLexemes ? excludedLexemeIds : [],
      );
      if (card) return card;
    }
  }
  return null;
}

async function selectCard(
  db: D1Database,
  sessionId: string,
  activity: PronunciationActivityType,
  excludeUsedLexemes: boolean,
  excludedCardIds: readonly string[] = [],
  excludedLexemeIds: readonly string[] = [],
): Promise<PronunciationCardRow | null> {
  const cardExclusion =
    excludedCardIds.length === 0
      ? ""
      : `AND c.id NOT IN (${excludedCardIds.map(() => "?").join(", ")})`;
  const lexemeExclusion =
    excludedLexemeIds.length === 0
      ? ""
      : `AND l.id NOT IN (${excludedLexemeIds.map(() => "?").join(", ")})`;
  return db
    .prepare(
      `SELECT
        c.id AS card_id,
        c.activity_type,
        l.id AS lexeme_id,
        r.id AS reading_id,
        r.pinyin,
        r.numeric_pinyin,
        r.normalized_syllables_json,
        r.sense_scope,
        l.simplified,
        l.traditional,
        (
          SELECT MIN(CAST(substr(t.label, 7) AS INTEGER))
          FROM lexeme_tags lt JOIN tags t ON t.id = lt.tag_id
          WHERE lt.lexeme_id = l.id AND t.kind = 'hsk-2.0'
        ) AS hsk_level,
        m.id AS media_id,
        m.delivery_key,
        m.license,
        m.attribution
       FROM cards c
       JOIN lexeme_readings r ON r.id = c.lexeme_reading_id
       JOIN lexemes l ON l.id = r.lexeme_id
       LEFT JOIN lexeme_reading_media rm
         ON rm.lexeme_reading_id = r.id AND rm.role = 'word_pronunciation'
       LEFT JOIN media_assets m ON m.id = rm.media_asset_id
       WHERE c.subject_type = 'lexeme_reading'
         AND c.activity_type = ?
         AND c.scheduler_eligible = 0
         AND c.retired_at IS NULL
         AND r.retired_at IS NULL
         AND (
           c.activity_type NOT IN ('audio_to_hanzi', 'audio_to_meaning')
           OR (
             m.id IS NOT NULL
             AND 1 = (
               SELECT COUNT(*) FROM lexeme_readings audio_sibling
               WHERE audio_sibling.lexeme_id = r.lexeme_id
                 AND audio_sibling.retired_at IS NULL
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM attempts a
           WHERE a.study_session_id = ? AND a.card_id = c.id
         )
         ${cardExclusion}
         ${lexemeExclusion}
         AND (
           ? = 0 OR NOT EXISTS (
             SELECT 1
             FROM attempts a2
             JOIN cards c2 ON c2.id = a2.card_id
             JOIN lexeme_readings r2 ON r2.id = c2.lexeme_reading_id
             WHERE a2.study_session_id = ? AND r2.lexeme_id = r.lexeme_id
           )
         )
       ORDER BY
         (SELECT COUNT(*) FROM attempts practice
          WHERE practice.card_id = c.id AND practice.mode = 'pronunciation'),
         (SELECT MAX(practice.occurred_at) FROM attempts practice
          WHERE practice.card_id = c.id AND practice.mode = 'pronunciation'),
         (SELECT COUNT(*) FROM lexeme_readings sibling
          WHERE sibling.lexeme_id = r.lexeme_id AND sibling.retired_at IS NULL),
         COALESCE(hsk_level, 2147483647),
         COALESCE(l.frequency_rank, 2147483647),
         l.simplified,
         r.id,
         c.id
       LIMIT 1`,
    )
    .bind(
      activity,
      sessionId,
      ...excludedCardIds,
      ...excludedLexemeIds,
      Number(excludeUsedLexemes),
      sessionId,
    )
    .first<PronunciationCardRow>();
}

async function mapCard(db: D1Database, row: PronunciationCardRow): Promise<PronunciationCard> {
  const syllables = parseSyllables(row.normalized_syllables_json, row.numeric_pinyin);
  const meanings = parseReadingMeanings(row.sense_scope);
  const { choices, answerChoiceId } = await buildChoices(db, row, meanings, syllables);
  return {
    cardId: row.card_id,
    readingId: row.reading_id,
    activityType: row.activity_type,
    lexeme: {
      simplified: row.simplified,
      traditional: row.traditional,
      meanings,
      hskLevel: row.hsk_level,
    },
    reading: {
      pinyin: row.pinyin,
      numericPinyin: row.numeric_pinyin,
      untonedPinyin: untonedPinyin(syllables),
      syllables,
      tone: singleTone(syllables),
      tonePair: deriveTonePair(syllables),
    },
    media:
      row.media_id === null ||
      row.delivery_key === null ||
      row.license === null ||
      row.attribution === null
        ? null
        : {
            id: row.media_id,
            url: `/media/${row.delivery_key}`,
            license: row.license,
            attribution: row.attribution,
          },
    choices,
    answerChoiceId,
  };
}

async function buildChoices(
  db: D1Database,
  row: PronunciationCardRow,
  meanings: string[],
  syllables: ReturnType<typeof normalizeNumericPinyin>,
): Promise<{ choices: PronunciationChoice[]; answerChoiceId: string | null }> {
  if (row.activity_type === "tone_identification") {
    const tone = singleTone(syllables);
    if (tone === null) throw new Error(`single-tone card has no tone: ${row.card_id}`);
    return {
      choices: ([1, 2, 3, 4, 5] as Tone[]).map((value) => ({
        id: `tone:${value}`,
        label: value === 5 ? "Neutral" : `Tone ${value}`,
      })),
      answerChoiceId: `tone:${tone}`,
    };
  }
  if (row.activity_type === "tone_pair_identification") {
    const pair = deriveTonePair(syllables);
    if (pair === null) throw new Error(`tone-pair card has no pair: ${row.card_id}`);
    const choices: PronunciationChoice[] = [];
    for (const first of [1, 2, 3, 4, 5] as Tone[]) {
      for (const second of [1, 2, 3, 4, 5] as Tone[]) {
        choices.push({ id: `tone-pair:${first}-${second}`, label: `${first}–${second}` });
      }
    }
    return { choices, answerChoiceId: `tone-pair:${pair[0]}-${pair[1]}` };
  }
  if (row.activity_type === "hanzi_to_pinyin" || row.activity_type === "pronunciation_production") {
    return { choices: [], answerChoiceId: null };
  }

  const meaningChoice = row.activity_type === "audio_to_meaning";
  const correctLabel = meaningChoice ? (meanings[0] ?? row.pinyin) : row.simplified;
  const distractors = await db
    .prepare(
      `SELECT r.id AS reading_id, l.simplified, r.sense_scope
       FROM lexeme_readings r JOIN lexemes l ON l.id = r.lexeme_id
       WHERE r.id <> ? AND r.retired_at IS NULL
       ORDER BY COALESCE(l.frequency_rank, 2147483647), l.simplified, r.id
       LIMIT 40`,
    )
    .bind(row.reading_id)
    .all<DistractorRow>();
  const choices: PronunciationChoice[] = [{ id: row.reading_id, label: correctLabel }];
  const labels = new Set([correctLabel]);
  for (const distractor of distractors.results) {
    const label = meaningChoice
      ? (parseReadingMeanings(distractor.sense_scope)[0] ?? distractor.simplified)
      : distractor.simplified;
    if (labels.has(label)) continue;
    labels.add(label);
    choices.push({ id: distractor.reading_id, label });
    if (choices.length === 4) break;
  }
  choices.sort(
    (left, right) =>
      stableHash(`${row.card_id}\0${left.id}`) - stableHash(`${row.card_id}\0${right.id}`),
  );
  return { choices, answerChoiceId: row.reading_id };
}

async function loadOwnedSession(
  db: D1Database,
  sessionId: string,
  deviceId: string,
): Promise<PronunciationSessionRow> {
  if (!sessionId.trim() || !deviceId.trim()) {
    throw new InvalidInputError("session and device IDs must be non-empty");
  }
  const session = await loadSession(db, sessionId);
  if (!session) throw new ReferenceNotFoundError("pronunciation session", sessionId);
  if (session.device_id !== deviceId) {
    throw new ConflictError(`pronunciation session ${sessionId} belongs to another device`);
  }
  return session;
}

async function loadSession(db: D1Database, id: string): Promise<PronunciationSessionRow | null> {
  return db
    .prepare(
      `SELECT id, device_id, started_at, ended_at, context_json
       FROM study_sessions WHERE id = ? AND mode = 'pronunciation'`,
    )
    .bind(id)
    .first<PronunciationSessionRow>();
}

async function existingSessionResult(
  db: D1Database,
  session: PronunciationSessionRow,
  input: CreatePronunciationSessionInput,
): Promise<CreatePronunciationSessionResult> {
  if (session.device_id !== input.deviceId) {
    throw new ConflictError(`pronunciation session ${session.id} belongs to another device`);
  }
  return { disposition: "existing", session: await mapSession(db, session) };
}

async function mapSession(
  db: D1Database,
  row: PronunciationSessionRow,
): Promise<PronunciationSessionView> {
  const context = parseSessionContext(row.context_json);
  const completed = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM attempts
       WHERE study_session_id = ? AND mode = 'pronunciation'`,
    )
    .bind(row.id)
    .first<{ count: number }>();
  return {
    id: row.id,
    deviceId: row.device_id,
    focus: context.focus,
    maxItems: context.maxItems,
    completedItems: completed?.count ?? 0,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

async function completeSession(
  db: D1Database,
  row: PronunciationSessionRow,
  view: PronunciationSessionView,
  options: PronunciationServiceOptions,
): Promise<void> {
  const now = serverTime(options);
  const changeId = `pronunciation-session:complete:${row.id}`;
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
        `UPDATE study_sessions SET
          ended_at = ?, aggregate_json = ?,
          server_seq = (SELECT seq FROM server_changes WHERE change_id = ?)
         WHERE id = ? AND ended_at IS NULL`,
      )
      .bind(now, JSON.stringify({ completedItems: view.completedItems }), changeId, row.id),
  ]);
}

function parseSessionContext(json: string): PronunciationSessionContext {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted pronunciation session context is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.focus !== "string" ||
    !(["mixed", "pinyin", "tones", "listening", "speaking"] as string[]).includes(record.focus) ||
    !Number.isSafeInteger(record.maxItems)
  ) {
    throw new Error("persisted pronunciation session context is invalid");
  }
  return {
    focus: record.focus as PronunciationFocus,
    maxItems: record.maxItems as number,
  };
}

function parseReadingMeanings(json: string | null): string[] {
  if (json === null) return [];
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("persisted reading senses must be an array of strings");
  }
  return value;
}

function parseSyllables(json: string, numericPinyin: string) {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("persisted pronunciation syllables are invalid");
  const persisted = parsed.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("persisted pronunciation syllables are invalid");
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "syllable" && key !== "tone") ||
      typeof record.syllable !== "string" ||
      !(record.tone === null || TONES.includes(record.tone as Tone))
    ) {
      throw new Error("persisted pronunciation syllables are invalid");
    }
    const canonical = normalizeNumericPinyin(
      `${record.syllable}${record.tone === null ? "" : record.tone}`,
    );
    if (canonical.length !== 1 || canonical[0]?.tone !== record.tone) {
      throw new Error("persisted pronunciation syllables are invalid");
    }
    return canonical[0];
  });
  const normalized = normalizeNumericPinyin(numericPinyin);
  if (JSON.stringify(persisted) !== JSON.stringify(normalized)) {
    throw new Error("persisted pronunciation syllables disagree with numeric pinyin");
  }
  return normalized;
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function serverTime(options: PronunciationServiceOptions): number {
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("server time must be a non-negative integer");
  }
  return now;
}
