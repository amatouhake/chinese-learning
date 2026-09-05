import {
  ConflictError,
  InvalidInputError,
  PracticeContractMismatchError,
  ReferenceNotFoundError,
} from "../domain/errors";
import {
  parseGrammarPracticeMetadata,
  parseGrammarTeachingMetadata,
} from "../domain/reading-grammar";
import type {
  CreateGrammarSessionInput,
  CreateReadingSessionInput,
} from "../domain/reading-grammar-validation";
import {
  currentPracticeContractVersion,
  isCurrentPracticeContract,
  legacyPracticeContractVersion,
} from "../domain/practice-contract";
import type {
  GrammarCard,
  GrammarNextResult,
  GrammarTopicStateView,
  GuidedSessionView,
  LearnerId,
  OfflineGrammarPack,
  OfflineReadingPack,
  ReadingCard,
  ReadingGrammarTopic,
  ReadingNextResult,
  ReadingVocabularyHint,
  StudyMeaning,
} from "../domain/types";
import { registerLearnerDevice } from "./learners";

type GuidedMode = "reading" | "grammar";

interface GuidedSessionRow {
  id: string;
  learner_id: string;
  device_id: string;
  mode: GuidedMode;
  started_at: number;
  ended_at: number | null;
  context_json: string;
}

interface GuidedSessionContext {
  maxItems: number;
  focusTopicId: string | null;
  practiceContractVersion: number;
}

interface ReadingCardRow {
  card_id: string;
  sentence_id: string;
  chinese: string;
  pinyin: string | null;
  meaning_ja: string | null;
  meaning_en: string | null;
  source: string;
  source_ref: string | null;
}

interface VocabularyRow {
  lexeme_id: string;
  reading_id: string | null;
  simplified: string;
  traditional: string | null;
  pinyin: string | null;
  numeric_pinyin: string | null;
  meanings_json: string;
  position: number;
  role: string | null;
}

interface TopicRow {
  id: string;
  title: string;
  level: string | null;
  teaching_metadata_json: string;
  status: GrammarTopicStateView["status"];
  introduced_at: number | null;
  last_studied_at: number | null;
  self_confidence: number | null;
  version: number | null;
  server_seq: number | null;
}

interface GrammarCardRow extends TopicRow {
  card_id: string;
  content_revision: number;
}

interface GrammarPracticeVersionRow {
  id: string;
  sentence_id: string;
  practice_json: string;
}

interface ExampleRow {
  sentence_id: string;
  chinese: string;
  pinyin: string | null;
  meaning_ja: string | null;
  meaning_en: string | null;
}

export interface GuidedServiceOptions {
  now?: () => number;
  practiceContractVersion?: number;
}

export interface CreateGuidedSessionResult {
  disposition: "created" | "existing";
  session: GuidedSessionView;
}

export function createReadingSession(
  db: D1Database,
  learnerId: LearnerId,
  input: CreateReadingSessionInput,
  options: GuidedServiceOptions = {},
): Promise<CreateGuidedSessionResult> {
  return createGuidedSession(db, learnerId, "reading", { ...input, topicId: undefined }, options);
}

export async function createGrammarSession(
  db: D1Database,
  learnerId: LearnerId,
  input: CreateGrammarSessionInput,
  options: GuidedServiceOptions = {},
): Promise<CreateGuidedSessionResult> {
  if (input.topicId) {
    const topic = await db
      .prepare("SELECT id FROM grammar_topics WHERE id = ?")
      .bind(input.topicId)
      .first<{ id: string }>();
    if (!topic) throw new ReferenceNotFoundError("grammar topic", input.topicId);
  }
  return createGuidedSession(db, learnerId, "grammar", input, options);
}

export async function getNextReadingCard(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
  deviceId: string,
  options: GuidedServiceOptions = {},
  requestedPracticeContractVersion?: number,
): Promise<ReadingNextResult> {
  const result = await nextGuidedCard(
    db,
    learnerId,
    "reading",
    sessionId,
    deviceId,
    options,
    requestedPracticeContractVersion,
  );
  return { ...result, card: result.card as ReadingCard | null };
}

export async function getNextGrammarCard(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
  deviceId: string,
  options: GuidedServiceOptions = {},
  requestedPracticeContractVersion?: number,
): Promise<GrammarNextResult> {
  const result = await nextGuidedCard(
    db,
    learnerId,
    "grammar",
    sessionId,
    deviceId,
    options,
    requestedPracticeContractVersion,
  );
  return { ...result, card: result.card as GrammarCard | null };
}

export async function getOfflineReadingPack(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
  deviceId: string,
  options: GuidedServiceOptions = {},
): Promise<OfflineReadingPack> {
  const result = await offlineGuidedPack(db, learnerId, "reading", sessionId, deviceId, options);
  return { ...result, cards: result.cards as ReadingCard[] };
}

export async function getOfflineGrammarPack(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
  deviceId: string,
  options: GuidedServiceOptions = {},
): Promise<OfflineGrammarPack> {
  const result = await offlineGuidedPack(db, learnerId, "grammar", sessionId, deviceId, options);
  return { ...result, cards: result.cards as GrammarCard[] };
}

async function createGuidedSession(
  db: D1Database,
  learnerId: LearnerId,
  mode: GuidedMode,
  input: CreateGrammarSessionInput,
  options: GuidedServiceOptions,
): Promise<CreateGuidedSessionResult> {
  await registerLearnerDevice(db, learnerId, input.deviceId);
  const existing = await loadSession(db, learnerId, input.sessionId, mode);
  if (existing) return existingSessionResult(db, existing, input);

  const practiceContractVersion =
    input.practiceContractVersion ?? currentPracticeContractVersion(mode);
  requireCurrentContract(mode, practiceContractVersion);

  const now = serverTime(options);
  const changeId = `${mode}-session:start:${input.sessionId}`;
  const context = {
    maxItems: input.maxItems,
    focusTopicId: mode === "grammar" ? (input.topicId ?? null) : null,
    practiceContractVersion,
  } satisfies GuidedSessionContext;
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
           VALUES (?, ?, ?, ?, ?, ?,
             (SELECT seq FROM server_changes WHERE change_id = ?))`,
        )
        .bind(
          input.sessionId,
          learnerId,
          input.deviceId,
          mode,
          now,
          JSON.stringify(context),
          changeId,
        ),
    ]);
  } catch (error) {
    const raced = await loadSession(db, learnerId, input.sessionId, mode);
    if (raced) return existingSessionResult(db, raced, input);
    throw error;
  }
  const created = await loadSession(db, learnerId, input.sessionId, mode);
  if (!created) throw new Error(`created ${mode} session could not be reloaded`);
  return {
    disposition: "created",
    session: await mapSession(db, created, practiceContractVersion),
  };
}

async function nextGuidedCard(
  db: D1Database,
  learnerId: LearnerId,
  mode: GuidedMode,
  sessionId: string,
  deviceId: string,
  options: GuidedServiceOptions,
  requestedPracticeContractVersion?: number,
): Promise<{
  status: "card" | "empty" | "completed";
  session: GuidedSessionView;
  card: ReadingCard | GrammarCard | null;
}> {
  const row = await loadOwnedSession(db, learnerId, sessionId, deviceId, mode);
  const practiceContractVersion =
    requestedPracticeContractVersion ??
    options.practiceContractVersion ??
    currentPracticeContractVersion(mode);
  requireCurrentContract(mode, practiceContractVersion);
  const session = await mapSession(db, row, practiceContractVersion);
  if (row.ended_at !== null || session.completedItems >= session.maxItems) {
    if (row.ended_at === null) await completeSession(db, row, session, options);
    return {
      status: session.completedItems === 0 ? "empty" : "completed",
      session: await mapSession(
        db,
        (await loadSession(db, learnerId, sessionId, mode)) ?? row,
        practiceContractVersion,
      ),
      card: null,
    };
  }
  const selected = await selectCard(db, learnerId, mode, sessionId, session.focusTopicId);
  if (!selected) {
    await completeSession(db, row, session, options);
    return {
      status: session.completedItems === 0 ? "empty" : "completed",
      session: await mapSession(
        db,
        (await loadSession(db, learnerId, sessionId, mode)) ?? row,
        practiceContractVersion,
      ),
      card: null,
    };
  }
  return {
    status: "card",
    session,
    card:
      mode === "reading"
        ? await mapReadingCard(db, learnerId, selected as ReadingCardRow)
        : await mapGrammarCard(db, selected as GrammarCardRow),
  };
}

async function offlineGuidedPack(
  db: D1Database,
  learnerId: LearnerId,
  mode: GuidedMode,
  sessionId: string,
  deviceId: string,
  options: GuidedServiceOptions,
): Promise<{
  status: "cards" | "empty" | "completed";
  practiceContractVersion: number;
  session: GuidedSessionView;
  cards: Array<ReadingCard | GrammarCard>;
}> {
  const row = await loadOwnedSession(db, learnerId, sessionId, deviceId, mode);
  const practiceContractVersion =
    options.practiceContractVersion ?? currentPracticeContractVersion(mode);
  requireCurrentContract(mode, practiceContractVersion);
  let session = await mapSession(db, row, practiceContractVersion);
  if (row.ended_at !== null || session.completedItems >= session.maxItems) {
    if (row.ended_at === null) {
      await completeSession(db, row, session, options);
      session = await mapSession(
        db,
        (await loadSession(db, learnerId, sessionId, mode)) ?? row,
        practiceContractVersion,
      );
    }
    return {
      status: session.completedItems === 0 ? "empty" : "completed",
      practiceContractVersion,
      session,
      cards: [],
    };
  }

  const selectedRows: Array<ReadingCardRow | GrammarCardRow> = [];
  const excludedCardIds: string[] = [];
  const remaining = session.maxItems - session.completedItems;
  for (let index = 0; index < remaining; index += 1) {
    const selected = await selectCard(
      db,
      learnerId,
      mode,
      sessionId,
      session.focusTopicId,
      excludedCardIds,
    );
    if (!selected) break;
    selectedRows.push(selected);
    excludedCardIds.push(selected.card_id);
  }
  if (selectedRows.length === 0) {
    await completeSession(db, row, session, options);
    session = await mapSession(
      db,
      (await loadSession(db, learnerId, sessionId, mode)) ?? row,
      practiceContractVersion,
    );
    return {
      status: session.completedItems === 0 ? "empty" : "completed",
      practiceContractVersion,
      session,
      cards: [],
    };
  }
  const cards = await Promise.all(
    selectedRows.map((selected) =>
      mode === "reading"
        ? mapReadingCard(db, learnerId, selected as ReadingCardRow)
        : mapGrammarCard(db, selected as GrammarCardRow),
    ),
  );
  return { status: "cards", practiceContractVersion, session, cards };
}

function selectCard(
  db: D1Database,
  learnerId: LearnerId,
  mode: GuidedMode,
  sessionId: string,
  focusTopicId: string | null,
  excludedCardIds: readonly string[] = [],
): Promise<ReadingCardRow | GrammarCardRow | null> {
  const exclusion =
    excludedCardIds.length === 0
      ? ""
      : `AND c.id NOT IN (${excludedCardIds.map(() => "?").join(", ")})`;
  if (mode === "reading") {
    return db
      .prepare(
        `SELECT c.id AS card_id, s.id AS sentence_id, s.chinese, s.pinyin,
           s.meaning_ja, s.meaning_en, s.source, s.source_ref
         FROM cards c
         JOIN sentences s ON s.id = c.sentence_id
         WHERE c.subject_type = 'sentence'
           AND c.activity_type = 'sentence_reading'
           AND c.scheduler_eligible = 0
           AND c.retired_at IS NULL
           AND s.retired_at IS NULL
           AND EXISTS (
             SELECT 1 FROM sentence_grammar_topics sgt
             WHERE sgt.sentence_id = s.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM attempts a
             WHERE a.learner_id = ? AND a.study_session_id = ? AND a.card_id = c.id
           )
           ${exclusion}
         ORDER BY
           (SELECT COUNT(*) FROM attempts practice
            WHERE practice.learner_id = ? AND practice.card_id = c.id
              AND practice.mode = 'reading'),
           (SELECT MAX(practice.occurred_at) FROM attempts practice
            WHERE practice.learner_id = ? AND practice.card_id = c.id
              AND practice.mode = 'reading'),
           (SELECT MIN(CAST(json_extract(g.teaching_metadata_json, '$.sequence') AS INTEGER))
            FROM sentence_grammar_topics ordered_sgt
            JOIN grammar_topics g ON g.id = ordered_sgt.grammar_topic_id
            WHERE ordered_sgt.sentence_id = s.id),
           s.id
         LIMIT 1`,
      )
      .bind(learnerId, sessionId, ...excludedCardIds, learnerId, learnerId)
      .first<ReadingCardRow>();
  }
  const focusPredicate = focusTopicId === null ? "" : "AND g.id = ?";
  return db
    .prepare(
      `SELECT c.id AS card_id, g.id, g.title, g.level, g.teaching_metadata_json,
         g.content_revision,
         gs.status, gs.introduced_at, gs.last_studied_at, gs.self_confidence,
         gs.version, gs.server_seq
       FROM cards c
       JOIN grammar_topics g ON g.id = c.grammar_topic_id
       LEFT JOIN grammar_topic_state gs
         ON gs.grammar_topic_id = g.id AND gs.learner_id = ?
       WHERE c.subject_type = 'grammar_topic'
         AND c.activity_type = 'sentence_reading'
         AND c.scheduler_eligible = 0
         AND c.retired_at IS NULL
         ${focusPredicate}
         AND NOT EXISTS (
           SELECT 1 FROM attempts a
           WHERE a.learner_id = ? AND a.study_session_id = ? AND a.card_id = c.id
         )
         ${exclusion}
       ORDER BY
         CASE WHEN gs.grammar_topic_id IS NULL THEN 0 ELSE 1 END,
         CAST(json_extract(g.teaching_metadata_json, '$.sequence') AS INTEGER),
         (SELECT COUNT(*) FROM attempts practice
          WHERE practice.learner_id = ? AND practice.card_id = c.id
            AND practice.mode = 'grammar'),
         gs.last_studied_at,
         g.id
       LIMIT 1`,
    )
    .bind(
      learnerId,
      ...(focusTopicId === null ? [] : [focusTopicId]),
      learnerId,
      sessionId,
      ...excludedCardIds,
      learnerId,
    )
    .first<GrammarCardRow>();
}

async function mapReadingCard(
  db: D1Database,
  learnerId: LearnerId,
  row: ReadingCardRow,
): Promise<ReadingCard> {
  const [vocabularyRows, topicRows] = await Promise.all([
    db
      .prepare(
        `SELECT sl.lexeme_id, sl.lexeme_reading_id AS reading_id, l.simplified,
           l.traditional, r.pinyin, r.numeric_pinyin, l.meanings_json,
           sl.position, sl.role
         FROM sentence_lexemes sl
         JOIN lexemes l ON l.id = sl.lexeme_id
         LEFT JOIN lexeme_readings r ON r.id = sl.lexeme_reading_id
         WHERE sl.sentence_id = ?
         ORDER BY sl.position, sl.lexeme_id`,
      )
      .bind(row.sentence_id)
      .all<VocabularyRow>(),
    db
      .prepare(
        `SELECT g.id, g.title, g.level, g.teaching_metadata_json,
           gs.status, gs.introduced_at, gs.last_studied_at, gs.self_confidence,
           gs.version, gs.server_seq
         FROM sentence_grammar_topics sgt
         JOIN grammar_topics g ON g.id = sgt.grammar_topic_id
         LEFT JOIN grammar_topic_state gs
           ON gs.grammar_topic_id = g.id AND gs.learner_id = ?
         WHERE sgt.sentence_id = ?
         ORDER BY CAST(json_extract(g.teaching_metadata_json, '$.sequence') AS INTEGER), g.id`,
      )
      .bind(learnerId, row.sentence_id)
      .all<TopicRow>(),
  ]);
  return {
    cardId: row.card_id,
    sentenceId: row.sentence_id,
    activityType: "sentence_reading",
    sentence: {
      chinese: row.chinese,
      pinyin: requiredContent(row.pinyin, "sentence pinyin", row.sentence_id),
      meaningJa: requiredContent(row.meaning_ja, "Japanese sentence meaning", row.sentence_id),
      meaningEn: requiredContent(row.meaning_en, "English sentence meaning", row.sentence_id),
      source: row.source,
      sourceRef: row.source_ref,
    },
    vocabulary: vocabularyRows.results.map(mapVocabulary),
    grammarTopics: topicRows.results.map(mapTopic),
  };
}

async function mapGrammarCard(db: D1Database, row: GrammarCardRow): Promise<GrammarCard> {
  const metadata = parseGrammarTeachingMetadata(row.teaching_metadata_json);
  const [examples, practiceVersion] = await Promise.all([
    db
      .prepare(
        `SELECT s.id AS sentence_id, s.chinese, s.pinyin, s.meaning_ja, s.meaning_en
         FROM sentence_grammar_topics sgt
         JOIN sentences s ON s.id = sgt.sentence_id
         WHERE sgt.grammar_topic_id = ? AND s.retired_at IS NULL
         ORDER BY s.id`,
      )
      .bind(row.id)
      .all<ExampleRow>(),
    db
      .prepare(
        `SELECT id, sentence_id, practice_json
         FROM grammar_practice_versions
         WHERE grammar_topic_id = ? AND content_revision = ?`,
      )
      .bind(row.id, row.content_revision)
      .first<GrammarPracticeVersionRow>(),
  ]);
  if (!practiceVersion) {
    throw new Error(`grammar topic ${row.id} has no immutable practice version`);
  }
  if (!examples.results.some(({ sentence_id }) => sentence_id === practiceVersion.sentence_id)) {
    throw new Error(`grammar topic ${row.id} has no active practice sentence`);
  }
  return {
    cardId: row.card_id,
    topicId: row.id,
    practiceVersionId: practiceVersion.id,
    practiceSentenceId: practiceVersion.sentence_id,
    activityType: "sentence_reading",
    topic: {
      ...mapTopic(row),
      sequence: metadata.sequence,
      practice: parseGrammarPracticeMetadata(practiceVersion.practice_json),
    },
    examples: examples.results.map((example) => ({
      sentenceId: example.sentence_id,
      chinese: example.chinese,
      pinyin: requiredContent(example.pinyin, "sentence pinyin", example.sentence_id),
      meaningJa: requiredContent(
        example.meaning_ja,
        "Japanese sentence meaning",
        example.sentence_id,
      ),
      meaningEn: requiredContent(
        example.meaning_en,
        "English sentence meaning",
        example.sentence_id,
      ),
    })),
  };
}

function mapVocabulary(row: VocabularyRow): ReadingVocabularyHint {
  return {
    lexemeId: row.lexeme_id,
    readingId: requiredContent(row.reading_id, "exact sentence reading", row.lexeme_id),
    simplified: row.simplified,
    traditional: row.traditional,
    pinyin: requiredContent(row.pinyin, "exact sentence pinyin", row.lexeme_id),
    numericPinyin: requiredContent(row.numeric_pinyin, "numeric sentence pinyin", row.lexeme_id),
    meanings: parseMeanings(row.meanings_json),
    position: row.position,
    role: row.role,
  };
}

function mapTopic(row: TopicRow): ReadingGrammarTopic {
  const metadata = parseGrammarTeachingMetadata(row.teaching_metadata_json);
  return {
    id: row.id,
    title: row.title,
    level: row.level,
    pattern: metadata.pattern,
    summaryJa: metadata.summaryJa,
    explanationJa: metadata.explanationJa,
    contrastJa: metadata.contrastJa,
    state: mapTopicState(row),
  };
}

function mapTopicState(row: TopicRow): GrammarTopicStateView | null {
  if (row.version === null) return null;
  return {
    grammarTopicId: row.id,
    status: row.status,
    introducedAt: row.introduced_at,
    lastStudiedAt: row.last_studied_at,
    selfConfidence: row.self_confidence,
    version: row.version,
    serverSeq: row.server_seq,
  };
}

async function loadOwnedSession(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
  deviceId: string,
  mode: GuidedMode,
): Promise<GuidedSessionRow> {
  if (!sessionId.trim() || !deviceId.trim()) {
    throw new InvalidInputError("session and device IDs must be non-empty");
  }
  const session = await loadSession(db, learnerId, sessionId, mode);
  if (!session) throw new ReferenceNotFoundError(`${mode} session`, sessionId);
  if (session.device_id !== deviceId) {
    throw new ConflictError(`${mode} session ${sessionId} belongs to another device`);
  }
  return session;
}

function loadSession(
  db: D1Database,
  learnerId: LearnerId,
  id: string,
  mode: GuidedMode,
): Promise<GuidedSessionRow | null> {
  return db
    .prepare(
      `SELECT id, learner_id, device_id, mode, started_at, ended_at, context_json
       FROM study_sessions WHERE learner_id = ? AND id = ? AND mode = ?`,
    )
    .bind(learnerId, id, mode)
    .first<GuidedSessionRow>();
}

async function existingSessionResult(
  db: D1Database,
  row: GuidedSessionRow,
  input: CreateGrammarSessionInput,
): Promise<CreateGuidedSessionResult> {
  if (row.device_id !== input.deviceId) {
    throw new ConflictError(`${row.mode} session ${row.id} belongs to another device`);
  }
  const context = parseSessionContext(row.context_json, row.mode);
  if (
    context.maxItems !== input.maxItems ||
    context.focusTopicId !== (row.mode === "grammar" ? (input.topicId ?? null) : null)
  ) {
    throw new ConflictError(`${row.mode} session ${row.id} already has different settings`);
  }
  return { disposition: "existing", session: await mapSession(db, row) };
}

async function mapSession(
  db: D1Database,
  row: GuidedSessionRow,
  servedPracticeContractVersion?: number,
): Promise<GuidedSessionView> {
  const context = parseSessionContext(row.context_json, row.mode);
  const completed = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM attempts
       WHERE learner_id = ? AND study_session_id = ? AND mode = ?`,
    )
    .bind(row.learner_id, row.id, row.mode)
    .first<{ count: number }>();
  return {
    id: row.id,
    deviceId: row.device_id,
    mode: row.mode,
    practiceContractVersion: servedPracticeContractVersion ?? context.practiceContractVersion,
    maxItems: context.maxItems,
    completedItems: completed?.count ?? 0,
    focusTopicId: context.focusTopicId,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

async function completeSession(
  db: D1Database,
  row: GuidedSessionRow,
  view: GuidedSessionView,
  options: GuidedServiceOptions,
): Promise<void> {
  const now = serverTime(options);
  const changeId = `${row.mode}-session:complete:${row.id}`;
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
      .bind(
        now,
        JSON.stringify({ completedItems: view.completedItems }),
        changeId,
        row.learner_id,
        row.id,
      ),
  ]);
}

function parseSessionContext(json: string, mode: GuidedMode): GuidedSessionContext {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Number.isSafeInteger((value as Record<string, unknown>).maxItems) ||
    !(
      (value as Record<string, unknown>).focusTopicId === null ||
      typeof (value as Record<string, unknown>).focusTopicId === "string"
    )
  ) {
    throw new Error("persisted guided session context is invalid");
  }
  const record = value as Record<string, unknown>;
  return {
    maxItems: record.maxItems as number,
    focusTopicId: record.focusTopicId as string | null,
    practiceContractVersion:
      Number.isSafeInteger(record.practiceContractVersion) &&
      (record.practiceContractVersion as number) >= 1
        ? (record.practiceContractVersion as number)
        : legacyPracticeContractVersion(mode),
  };
}

function requireCurrentContract(mode: GuidedMode, version: number): void {
  if (!isCurrentPracticeContract(mode, version)) {
    throw new PracticeContractMismatchError(
      `the ${mode} practice format has been updated; reload the app before preparing new cards`,
    );
  }
}

function parseMeanings(json: string): StudyMeaning[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("persisted lexeme meanings must be an array");
  return value.map((meaning) => {
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

function requiredContent(value: string | null, field: string, id: string): string {
  if (value === null || value.trim().length === 0) {
    throw new Error(`${field} is missing for ${id}`);
  }
  return value;
}

function serverTime(options: GuidedServiceOptions): number {
  const now = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("server time must be a non-negative integer");
  }
  return now;
}
