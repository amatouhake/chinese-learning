import { QUIZ_SELECTION_STRATEGY, REFLEX_SLOW_RESPONSE_MS } from "../domain/reflex";
import { ReferenceNotFoundError } from "../domain/errors";
import type {
  ActivityType,
  FsrsRating,
  GrammarSessionSummary,
  LearnerId,
  PracticeAttentionItem,
  PracticeCorrectnessEvidence,
  PracticeMode,
  PracticeRatingEvidence,
  PracticeSessionHistory,
  PracticeSessionSummary,
  PracticeSessionTrend,
  PronunciationSessionSummary,
  QuizActivity,
  QuizChoiceCount,
  ReadingSessionSummary,
  StudyDirection,
  VocabularyQuizSessionSummary,
  VocabularyReviewSessionSummary,
} from "../domain/types";
import type { PronunciationActivityType, PronunciationFocus } from "../domain/pronunciation";

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 50;
const TREND_SCAN_LIMIT = 100;

interface SessionRow {
  id: string;
  learner_id: string;
  mode: PracticeMode;
  started_at: number;
  ended_at: number;
  context_json: string;
}

interface AttemptRow {
  study_session_id: string;
  event_id: string;
  card_id: string;
  occurred_at: number;
  mode: PracticeMode;
  activity_type: ActivityType;
  correct: number | null;
  self_rating: number | null;
  response_ms: number | null;
  metadata_json: string;
  fsrs_rating: number | null;
  label: string;
  detail: string | null;
}

interface TopicRow {
  id: string;
  title: string;
}

export interface PracticeHistoryOptions {
  limit?: number;
  now?: () => number;
}

export async function getRecentPracticeSessions(
  db: D1Database,
  learnerId: LearnerId,
  options: PracticeHistoryOptions = {},
): Promise<PracticeSessionHistory> {
  const limit = boundedLimit(options.limit);
  const sessions = await db
    .prepare(
      `SELECT id, learner_id, mode, started_at, ended_at, context_json
       FROM study_sessions
       WHERE learner_id = ? AND ended_at IS NOT NULL
       ORDER BY ended_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(learnerId, TREND_SCAN_LIMIT)
    .all<SessionRow>();
  const summaries = await summarizeRows(db, learnerId, sessions.results);
  attachComparableQuizTrends(summaries);
  return {
    generatedAt: generatedAt(options.now),
    sessions: summaries.slice(0, limit),
  };
}

export async function getPracticeSessionSummary(
  db: D1Database,
  learnerId: LearnerId,
  sessionId: string,
): Promise<PracticeSessionSummary> {
  const row = await db
    .prepare(
      `SELECT id, learner_id, mode, started_at, ended_at, context_json
       FROM study_sessions
       WHERE learner_id = ? AND id = ? AND ended_at IS NOT NULL`,
    )
    .bind(learnerId, sessionId)
    .first<SessionRow>();
  if (!row) throw new ReferenceNotFoundError("completed practice session", sessionId);
  const [summary] = await summarizeRows(db, learnerId, [row]);
  if (!summary) throw new Error("completed practice session summary is missing");
  return summary;
}

async function summarizeRows(
  db: D1Database,
  learnerId: LearnerId,
  sessions: readonly SessionRow[],
): Promise<PracticeSessionSummary[]> {
  if (sessions.length === 0) return [];
  const placeholders = sessions.map(() => "?").join(", ");
  const [attemptsResult, topicsResult] = await db.batch<AttemptRow | TopicRow>([
    db
      .prepare(
        `SELECT
           a.study_session_id, a.event_id, a.card_id, a.occurred_at, a.mode,
           a.activity_type, a.correct, a.self_rating, a.response_ms, a.metadata_json,
           review.rating AS fsrs_rating,
           COALESCE(direct_lexeme.simplified, reading_lexeme.simplified,
             sentence.chinese, grammar.title, a.card_id) AS label,
           COALESCE(reading.pinyin, (
             SELECT preferred.pinyin FROM lexeme_readings preferred
             WHERE preferred.lexeme_id = direct_lexeme.id
               AND preferred.is_preferred = 1 AND preferred.retired_at IS NULL
             ORDER BY preferred.id LIMIT 1
           )) AS detail
         FROM attempts a
         JOIN cards card ON card.id = a.card_id
         LEFT JOIN fsrs_reviews review ON review.attempt_id = a.event_id
         LEFT JOIN lexemes direct_lexeme ON direct_lexeme.id = card.lexeme_id
         LEFT JOIN lexeme_readings reading ON reading.id = card.lexeme_reading_id
         LEFT JOIN lexemes reading_lexeme ON reading_lexeme.id = reading.lexeme_id
         LEFT JOIN sentences sentence ON sentence.id = card.sentence_id
         LEFT JOIN grammar_topics grammar ON grammar.id = card.grammar_topic_id
         WHERE a.learner_id = ? AND a.study_session_id IN (${placeholders})
         ORDER BY a.occurred_at, a.device_id, a.device_seq, a.event_id`,
      )
      .bind(learnerId, ...sessions.map(({ id }) => id)),
    db.prepare("SELECT id, title FROM grammar_topics ORDER BY id"),
  ]);
  const attempts = attemptsResult?.results as AttemptRow[] | undefined;
  const topics = topicsResult?.results as TopicRow[] | undefined;
  if (!attempts || !topics) throw new Error("practice summary evidence query is incomplete");
  const attemptsBySession = new Map<string, AttemptRow[]>();
  for (const attempt of attempts) {
    const existing = attemptsBySession.get(attempt.study_session_id) ?? [];
    existing.push(attempt);
    attemptsBySession.set(attempt.study_session_id, existing);
  }
  const topicTitles = new Map(topics.map(({ id, title }) => [id, title]));
  return sessions.map((session) =>
    summarizeSession(session, attemptsBySession.get(session.id) ?? [], topicTitles),
  );
}

function summarizeSession(
  session: SessionRow,
  attempts: readonly AttemptRow[],
  topicTitles: ReadonlyMap<string, string>,
): PracticeSessionSummary {
  switch (session.mode) {
    case "study":
      return summarizeReview(session, attempts);
    case "reflex":
      return summarizeQuiz(session, attempts);
    case "pronunciation":
      return summarizePronunciation(session, attempts);
    case "reading":
      return summarizeReading(session, attempts, topicTitles);
    case "grammar":
      return summarizeGrammar(session, attempts, topicTitles);
  }
}

function summarizeReview(
  session: SessionRow,
  attempts: readonly AttemptRow[],
): VocabularyReviewSessionSummary {
  const context = recordContext(session.context_json);
  const requestedItems = integerField(context, "maxCards");
  const direction = studyDirection(context.direction);
  const ratings = ratingEvidence(attempts.map(({ fsrs_rating }) => fsrs_rating));
  return {
    ...baseSummary(session, attempts, requestedItems, "vocabulary_review"),
    mode: "study",
    practice: "vocabulary_review",
    configuration: { direction, requestedItems, actualItems: attempts.length },
    evidence: {
      ratings,
      directions: {
        hanzi_to_meaning: count(
          attempts,
          ({ activity_type }) => activity_type === "hanzi_to_meaning",
        ),
        meaning_to_hanzi: count(
          attempts,
          ({ activity_type }) => activity_type === "meaning_to_hanzi",
        ),
      },
      sources: {
        due: count(attempts, (attempt) => metadata(attempt).queueSource === "due"),
        new: count(attempts, (attempt) => metadata(attempt).queueSource === "new"),
      },
    },
    attentionItems: attentionItems(attempts, (attempt) => {
      if (attempt.fsrs_rating === 1) return "忘れた";
      if (attempt.fsrs_rating === 2) return "あやふや";
      return null;
    }),
  };
}

function summarizeQuiz(
  session: SessionRow,
  attempts: readonly AttemptRow[],
): VocabularyQuizSessionSummary {
  const context = recordContext(session.context_json);
  const requestedItems = integerField(context, "maxItems");
  const choiceCount = quizChoiceCount(context.choiceCount ?? 4);
  const activityType = quizActivity(context.activityType ?? "mixed");
  const timed = attempts.filter(({ response_ms }) => response_ms !== null);
  const timingInterrupted = count(
    attempts,
    (attempt) => metadata(attempt).timingInterrupted === true,
  );
  return {
    ...baseSummary(session, attempts, requestedItems, "vocabulary_quiz"),
    mode: "reflex",
    practice: "vocabulary_quiz",
    configuration: {
      activityType,
      choiceCount,
      requestedItems,
      selectionStrategy: QUIZ_SELECTION_STRATEGY,
    },
    evidence: {
      correctness: correctnessEvidence(attempts),
      averageResponseMs: average(timed.map(({ response_ms }) => response_ms!)),
      timedResponses: timed.length,
      timingInterrupted,
      slowResponses: count(
        timed,
        ({ response_ms }) =>
          choiceCount === 4 && response_ms !== null && response_ms >= REFLEX_SLOW_RESPONSE_MS,
      ),
    },
    attentionItems: attentionItems(attempts, (attempt) => {
      if (attempt.correct === 0) return "誤答";
      if (
        choiceCount === 4 &&
        attempt.response_ms !== null &&
        attempt.response_ms >= REFLEX_SLOW_RESPONSE_MS
      )
        return "ゆっくり";
      return null;
    }),
  };
}

function summarizePronunciation(
  session: SessionRow,
  attempts: readonly AttemptRow[],
): PronunciationSessionSummary {
  const context = recordContext(session.context_json);
  const requestedItems = integerField(context, "maxItems");
  const activities: Partial<Record<PronunciationActivityType, number>> = {};
  for (const attempt of attempts) {
    const activity = attempt.activity_type as PronunciationActivityType;
    activities[activity] = (activities[activity] ?? 0) + 1;
  }
  const correctnessRows = attempts.filter(({ correct }) => correct !== null);
  const selfRatingRows = attempts.filter(({ self_rating }) => self_rating !== null);
  return {
    ...baseSummary(session, attempts, requestedItems, "pronunciation"),
    mode: "pronunciation",
    practice: "pronunciation",
    configuration: { focus: pronunciationFocus(context.focus), requestedItems },
    evidence: {
      activities,
      correctness: correctnessRows.length > 0 ? correctnessEvidence(correctnessRows) : null,
      selfRatings:
        selfRatingRows.length > 0
          ? ratingEvidence(selfRatingRows.map(({ self_rating }) => self_rating))
          : null,
      skipped: count(
        attempts,
        (attempt) => metadata(attempt).interaction === "skip-uncached-audio",
      ),
    },
    attentionItems: attentionItems(attempts, (attempt) => {
      if (attempt.correct === 0) return "誤答";
      if (attempt.self_rating !== null && attempt.self_rating <= 2) return "要練習";
      return null;
    }),
  };
}

function summarizeReading(
  session: SessionRow,
  attempts: readonly AttemptRow[],
  topicTitles: ReadonlyMap<string, string>,
): ReadingSessionSummary {
  const context = recordContext(session.context_json);
  const requestedItems = integerField(context, "maxItems");
  return {
    ...baseSummary(session, attempts, requestedItems, "reading"),
    mode: "reading",
    practice: "reading",
    configuration: { requestedItems },
    evidence: {
      comprehension: ratingEvidence(attempts.map(({ self_rating }) => self_rating)),
      grammarTopics: encounteredTopics(attempts, topicTitles),
    },
    attentionItems: attentionItems(attempts, (attempt) =>
      attempt.self_rating !== null && attempt.self_rating <= 2 ? "読み直す" : null,
    ),
  };
}

function summarizeGrammar(
  session: SessionRow,
  attempts: readonly AttemptRow[],
  topicTitles: ReadonlyMap<string, string>,
): GrammarSessionSummary {
  const context = recordContext(session.context_json);
  const requestedItems = integerField(context, "maxItems");
  return {
    ...baseSummary(session, attempts, requestedItems, "grammar"),
    mode: "grammar",
    practice: "grammar",
    configuration: {
      requestedItems,
      focusTopicId: nullableText(context.focusTopicId),
    },
    evidence: {
      correctness: correctnessEvidence(attempts),
      confidence: ratingEvidence(attempts.map(({ self_rating }) => self_rating)),
      grammarTopics: encounteredTopics(attempts, topicTitles),
    },
    attentionItems: attentionItems(attempts, (attempt) => {
      if (attempt.correct === 0) return "誤答";
      if (attempt.self_rating !== null && attempt.self_rating <= 2) return "要確認";
      return null;
    }),
  };
}

function baseSummary(
  session: SessionRow,
  attempts: readonly AttemptRow[],
  requestedItems: number,
  practice: PracticeSessionSummary["practice"],
): Omit<PracticeSessionSummary, "mode" | "configuration" | "evidence"> {
  return {
    summaryVersion: 1,
    sessionId: session.id,
    learnerId: session.learner_id,
    mode: session.mode,
    practice,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    completedItems: attempts.length,
    requestedItems,
    attentionItems: [],
    trend: null,
  } as Omit<PracticeSessionSummary, "mode" | "configuration" | "evidence">;
}

function attachComparableQuizTrends(summaries: PracticeSessionSummary[]): void {
  const chronological = [...summaries].reverse();
  for (let index = 0; index < chronological.length; index += 1) {
    const current = chronological[index];
    if (current?.practice !== "vocabulary_quiz") continue;
    const comparable = chronological
      .slice(0, index + 1)
      .filter(
        (candidate): candidate is VocabularyQuizSessionSummary =>
          candidate.practice === "vocabulary_quiz" &&
          candidate.configuration.activityType === current.configuration.activityType &&
          candidate.configuration.choiceCount === current.configuration.choiceCount &&
          candidate.configuration.requestedItems === current.configuration.requestedItems &&
          candidate.evidence.correctness.rate !== null,
      )
      .slice(-5);
    current.trend = trendFromQuiz(comparable);
  }
}

function trendFromQuiz(
  sessions: readonly VocabularyQuizSessionSummary[],
): PracticeSessionTrend | null {
  if (sessions.length < 2) return null;
  return {
    label: "最近の同じ設定",
    unit: "percent",
    values: sessions.map(({ evidence }) => Math.round((evidence.correctness.rate ?? 0) * 100)),
    comparableSessionIds: sessions.map(({ sessionId }) => sessionId),
  };
}

function correctnessEvidence(attempts: readonly AttemptRow[]): PracticeCorrectnessEvidence {
  const responses = attempts.filter(({ correct }) => correct !== null);
  const correct = count(responses, ({ correct: value }) => value === 1);
  return {
    responses: responses.length,
    correct,
    rate: responses.length === 0 ? null : correct / responses.length,
  };
}

function ratingEvidence(values: readonly (number | null)[]): PracticeRatingEvidence {
  const distribution: Record<FsrsRating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const value of values) {
    if (value === 1 || value === 2 || value === 3 || value === 4) distribution[value] += 1;
  }
  return {
    responses: Object.values(distribution).reduce((total, value) => total + value, 0),
    distribution,
  };
}

function attentionItems(
  attempts: readonly AttemptRow[],
  reason: (attempt: AttemptRow) => string | null,
): PracticeAttentionItem[] {
  const result = new Map<string, PracticeAttentionItem>();
  for (const attempt of attempts) {
    const value = reason(attempt);
    if (!value) continue;
    const existing = result.get(attempt.card_id);
    if (existing) {
      if (!existing.reasons.includes(value)) existing.reasons.push(value);
    } else {
      result.set(attempt.card_id, {
        cardId: attempt.card_id,
        label: attempt.label,
        detail: attempt.detail,
        reasons: [value],
      });
    }
  }
  return [...result.values()].slice(0, 5);
}

function encounteredTopics(
  attempts: readonly AttemptRow[],
  topicTitles: ReadonlyMap<string, string>,
): Array<{ id: string; title: string }> {
  const ids = new Set<string>();
  for (const attempt of attempts) {
    const body = metadata(attempt);
    if (typeof body.topicId === "string") ids.add(body.topicId);
    if (Array.isArray(body.grammarTopicIds)) {
      for (const id of body.grammarTopicIds) if (typeof id === "string") ids.add(id);
    }
  }
  return [...ids].map((id) => ({ id, title: topicTitles.get(id) ?? id }));
}

function recordContext(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("persisted practice session context is invalid");
  }
  return value as Record<string, unknown>;
}

function metadata(attempt: AttemptRow): Record<string, unknown> {
  const value: unknown = JSON.parse(attempt.metadata_json);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function studyDirection(value: unknown): StudyDirection {
  if (value === "mixed" || value === "hanzi_to_meaning" || value === "meaning_to_hanzi")
    return value;
  throw new Error("persisted study direction is invalid");
}

function quizActivity(value: unknown): QuizActivity {
  if (
    value === "mixed" ||
    value === "hanzi_to_meaning" ||
    value === "meaning_to_hanzi" ||
    value === "hanzi_to_pinyin" ||
    value === "pinyin_to_hanzi"
  )
    return value;
  throw new Error("persisted quiz activity is invalid");
}

function quizChoiceCount(value: unknown): QuizChoiceCount {
  if (value === 4 || value === 9) return value;
  throw new Error("persisted quiz choice count is invalid");
}

function pronunciationFocus(value: unknown): PronunciationFocus {
  if (
    value === "mixed" ||
    value === "pinyin" ||
    value === "tones" ||
    value === "listening" ||
    value === "speaking"
  )
    return value;
  throw new Error("persisted pronunciation focus is invalid");
}

function integerField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`persisted ${field} is invalid`);
  return value as number;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new Error("persisted optional text is invalid");
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HISTORY_LIMIT) {
    throw new Error(`history limit must be an integer from 1 to ${MAX_HISTORY_LIMIT}`);
  }
  return value;
}

function generatedAt(now: (() => number) | undefined): number {
  const value = now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("history time must be non-negative");
  return value;
}

function count<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.reduce((total, value) => total + Number(predicate(value)), 0);
}

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}
