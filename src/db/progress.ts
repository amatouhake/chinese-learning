import { PRONUNCIATION_ACTIVITY_TYPES } from "../domain/pronunciation";
import { REFLEX_SLOW_RESPONSE_MS } from "../domain/reflex";
import type {
  ActivityType,
  FsrsRating,
  LearnerId,
  PracticeMode,
  ProgressCorrectness,
  ProgressSelfReportedRecall,
  ProgressSelfRatings,
  ProgressSnapshot,
  ProgressTroubleItem,
  ProgressWindow,
} from "../domain/types";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RECENT_DAYS = 30;
const SNAPSHOT_VERSION = 1 as const;
const TROUBLE_LIMIT = 8;
const PER_MODE_TROUBLE_LIMIT = 5;
const PRACTICE_TROUBLE_CANDIDATES_PER_MODE = 15;

export interface ProgressSnapshotOptions {
  now?: () => number;
}

interface MetadataRow {
  timezone: string;
  server_seq: number | null;
  changed_at: number | null;
  latest_attempt_received_at: number | null;
  latest_attempt_occurred_at: number | null;
}

interface VocabularyCountsRow {
  total: number;
  due_now: number;
  new_cards: number;
  learning: number;
  review: number;
}

interface ModeSummaryRow {
  mode: PracticeMode;
  activity_type: ActivityType;
  quiz_choice_count: number | null;
  attempts: number;
  distinct_items: number;
  correctness_responses: number;
  correct_answers: number;
  self_rating_responses: number;
  average_self_rating: number | null;
  self_1: number;
  self_2: number;
  self_3: number;
  self_4: number;
  response_time_responses: number;
  average_response_ms: number | null;
  slow_responses: number;
  skips: number;
  last_practiced_at: number | null;
  last_fsrs_review_at: number | null;
  fsrs_1: number;
  fsrs_2: number;
  fsrs_3: number;
  fsrs_4: number;
}

interface ActivityMarkerRow {
  occurred_at: number;
  study_session_id: string | null;
  mode: PracticeMode;
  answered: number;
  scheduled_review: number;
}

interface GrammarTopicRow {
  id: string;
  title: string;
  status: "introduced" | "learning" | "comfortable" | null;
  self_confidence: number | null;
  last_studied_at: number | null;
}

interface TroubleRow {
  card_id: string;
  mode: PracticeMode;
  activity_type: ActivityType;
  quiz_choice_count: number | null;
  label: string;
  detail: string | null;
  recent_attempts: number;
  errors: number;
  self_reported_recall_misses: number;
  slow_responses: number;
  response_time_responses: number;
  average_response_ms: number | null;
  self_ratings: number;
  average_self_rating: number | null;
  low_self_ratings: number;
  fsrs_1: number;
  fsrs_2: number;
  fsrs_3: number;
  fsrs_4: number;
  lapses: number;
  due_at: number | null;
  last_practiced_at: number | null;
}

type ProgressQueryRow =
  | MetadataRow
  | VocabularyCountsRow
  | ModeSummaryRow
  | ActivityMarkerRow
  | GrammarTopicRow
  | TroubleRow;

interface RankedTroubleItem {
  item: ProgressTroubleItem;
  priority: number;
}

export async function getProgressSnapshot(
  db: D1Database,
  learnerId: LearnerId,
  options: ProgressSnapshotOptions = {},
): Promise<ProgressSnapshot> {
  const generatedAt = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(generatedAt) || generatedAt < 0) {
    throw new Error("progress snapshot time must be a non-negative integer");
  }
  const recentCutoff = generatedAt - RECENT_DAYS * DAY_MS;

  const results = await db.batch<ProgressQueryRow>([
    db
      .prepare(
        `SELECT
         timezone,
         (SELECT seq FROM server_changes
          WHERE learner_id IS NULL OR learner_id = ?
          ORDER BY seq DESC LIMIT 1) AS server_seq,
         (SELECT changed_at FROM server_changes
          WHERE learner_id IS NULL OR learner_id = ?
          ORDER BY seq DESC LIMIT 1) AS changed_at,
         (SELECT MAX(received_at) FROM attempts WHERE learner_id = ?)
           AS latest_attempt_received_at,
         (SELECT MAX(occurred_at) FROM attempts WHERE learner_id = ?)
           AS latest_attempt_occurred_at
       FROM learner_settings WHERE learner_id = ?`,
      )
      .bind(learnerId, learnerId, learnerId, learnerId, learnerId),
    db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN cs.reps > 0 AND cs.due_at <= ? THEN 1 ELSE 0 END), 0)
             AS due_now,
           COALESCE(SUM(CASE WHEN cs.reps = 0 THEN 1 ELSE 0 END), 0) AS new_cards,
           COALESCE(SUM(CASE WHEN cs.state IN (1, 3) THEN 1 ELSE 0 END), 0) AS learning,
           COALESCE(SUM(CASE WHEN cs.state = 2 THEN 1 ELSE 0 END), 0) AS review
         FROM cards c JOIN card_state cs ON cs.card_id = c.id AND cs.learner_id = ?
         WHERE c.subject_type = 'lexeme'
           AND c.activity_type IN ('hanzi_to_meaning', 'meaning_to_hanzi')
           AND c.scheduler_eligible = 1 AND c.retired_at IS NULL`,
      )
      .bind(generatedAt, learnerId),
    db
      .prepare(
        `SELECT
           a.mode,
           a.activity_type,
           CASE WHEN a.mode = 'reflex'
             THEN COALESCE(json_extract(a.metadata_json, '$.choiceCount'), 4)
             ELSE NULL
           END AS quiz_choice_count,
           COUNT(*) AS attempts,
           COUNT(DISTINCT CASE
             WHEN a.mode = 'pronunciation'
               AND json_extract(a.metadata_json, '$.interaction') = 'skip-uncached-audio'
             THEN NULL ELSE a.card_id
           END) AS distinct_items,
           SUM(CASE WHEN a.correct IS NOT NULL THEN 1 ELSE 0 END) AS correctness_responses,
           SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) AS correct_answers,
           SUM(CASE WHEN a.self_rating IS NOT NULL THEN 1 ELSE 0 END) AS self_rating_responses,
           AVG(a.self_rating) AS average_self_rating,
           SUM(CASE WHEN a.self_rating = 1 THEN 1 ELSE 0 END) AS self_1,
           SUM(CASE WHEN a.self_rating = 2 THEN 1 ELSE 0 END) AS self_2,
           SUM(CASE WHEN a.self_rating = 3 THEN 1 ELSE 0 END) AS self_3,
           SUM(CASE WHEN a.self_rating = 4 THEN 1 ELSE 0 END) AS self_4,
           SUM(CASE
             WHEN a.response_ms IS NOT NULL
               AND NOT (
                 a.mode = 'pronunciation'
                 AND json_extract(a.metadata_json, '$.interaction') = 'skip-uncached-audio'
               )
             THEN 1 ELSE 0 END) AS response_time_responses,
           AVG(CASE
             WHEN a.mode = 'pronunciation'
               AND json_extract(a.metadata_json, '$.interaction') = 'skip-uncached-audio'
             THEN NULL ELSE a.response_ms
           END) AS average_response_ms,
           SUM(CASE
             WHEN a.mode = 'reflex'
               AND COALESCE(json_extract(a.metadata_json, '$.choiceCount'), 4) = 4
               AND a.response_ms >= ?
             THEN 1 ELSE 0
           END) AS slow_responses,
           SUM(CASE
             WHEN a.mode = 'pronunciation'
               AND json_extract(a.metadata_json, '$.interaction') = 'skip-uncached-audio'
             THEN 1 ELSE 0 END) AS skips,
           MAX(a.occurred_at) AS last_practiced_at,
           SUM(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS fsrs_1,
           SUM(CASE WHEN r.rating = 2 THEN 1 ELSE 0 END) AS fsrs_2,
           SUM(CASE WHEN r.rating = 3 THEN 1 ELSE 0 END) AS fsrs_3,
           SUM(CASE WHEN r.rating = 4 THEN 1 ELSE 0 END) AS fsrs_4,
           MAX(CASE WHEN r.attempt_id IS NOT NULL THEN a.occurred_at END)
             AS last_fsrs_review_at
         FROM attempts a LEFT JOIN fsrs_reviews r ON r.attempt_id = a.event_id
         WHERE a.learner_id = ? AND a.occurred_at >= ? AND a.occurred_at <= ?
         GROUP BY a.mode, a.activity_type, quiz_choice_count
         ORDER BY a.mode, a.activity_type, quiz_choice_count`,
      )
      .bind(REFLEX_SLOW_RESPONSE_MS, learnerId, recentCutoff, generatedAt),
    db
      .prepare(
        `SELECT
           a.occurred_at,
           a.study_session_id,
           a.mode,
           CASE
             WHEN a.mode = 'pronunciation'
               AND json_extract(a.metadata_json, '$.interaction') = 'skip-uncached-audio'
             THEN 0 ELSE 1
           END AS answered,
           CASE WHEN r.attempt_id IS NULL THEN 0 ELSE 1 END AS scheduled_review
         FROM attempts a LEFT JOIN fsrs_reviews r ON r.attempt_id = a.event_id
         WHERE a.learner_id = ? AND a.occurred_at >= ? AND a.occurred_at <= ?
         ORDER BY a.occurred_at, a.event_id`,
      )
      .bind(learnerId, recentCutoff, generatedAt),
    db
      .prepare(
        `SELECT g.id, g.title, state.status, state.self_confidence, state.last_studied_at
       FROM grammar_topics g
       LEFT JOIN grammar_topic_state state
         ON state.grammar_topic_id = g.id AND state.learner_id = ?
       ORDER BY CAST(json_extract(g.teaching_metadata_json, '$.sequence') AS INTEGER), g.id`,
      )
      .bind(learnerId),
    db
      .prepare(
        `SELECT
           c.id AS card_id,
           'study' AS mode,
           c.activity_type,
           l.simplified AS label,
           (SELECT reading.pinyin FROM lexeme_readings reading
             WHERE reading.lexeme_id = l.id AND reading.is_preferred = 1
               AND reading.retired_at IS NULL
             ORDER BY reading.id LIMIT 1) AS detail,
           COUNT(a.event_id) AS recent_attempts,
           0 AS errors,
           0 AS self_reported_recall_misses,
           0 AS slow_responses,
           SUM(CASE WHEN a.response_ms IS NOT NULL THEN 1 ELSE 0 END) AS response_time_responses,
           AVG(a.response_ms) AS average_response_ms,
           0 AS self_ratings,
           NULL AS average_self_rating,
           0 AS low_self_ratings,
           SUM(CASE WHEN review.rating = 1 THEN 1 ELSE 0 END) AS fsrs_1,
           SUM(CASE WHEN review.rating = 2 THEN 1 ELSE 0 END) AS fsrs_2,
           SUM(CASE WHEN review.rating = 3 THEN 1 ELSE 0 END) AS fsrs_3,
           SUM(CASE WHEN review.rating = 4 THEN 1 ELSE 0 END) AS fsrs_4,
           cs.lapses,
           cs.due_at,
           MAX(a.occurred_at) AS last_practiced_at
         FROM cards c
         JOIN card_state cs ON cs.card_id = c.id AND cs.learner_id = ?
         JOIN lexemes l ON l.id = c.lexeme_id
         LEFT JOIN attempts a ON a.learner_id = ? AND a.card_id = c.id AND a.mode = 'study'
           AND a.occurred_at >= ? AND a.occurred_at <= ?
         LEFT JOIN fsrs_reviews review ON review.attempt_id = a.event_id
         WHERE c.subject_type = 'lexeme'
           AND c.activity_type IN ('hanzi_to_meaning', 'meaning_to_hanzi')
           AND c.scheduler_eligible = 1 AND c.retired_at IS NULL AND cs.reps > 0
         GROUP BY c.id, c.activity_type, l.id, l.simplified, cs.lapses, cs.due_at
         HAVING cs.lapses > 0
           OR SUM(CASE WHEN review.rating IN (1, 2) THEN 1 ELSE 0 END) > 0
         ORDER BY
           (cs.lapses * 3
             + SUM(CASE WHEN review.rating = 1 THEN 4 ELSE 0 END)
             + SUM(CASE WHEN review.rating = 2 THEN 2 ELSE 0 END)) DESC,
           last_practiced_at DESC,
           c.id
         LIMIT 40`,
      )
      .bind(learnerId, learnerId, recentCutoff, generatedAt),
    db
      .prepare(
        `WITH trouble AS (
         SELECT
           c.id AS card_id,
           a.mode,
           a.activity_type,
           CASE WHEN a.mode = 'reflex'
             THEN COALESCE(json_extract(a.metadata_json, '$.choiceCount'), 4)
             ELSE NULL
           END AS quiz_choice_count,
           CASE c.subject_type
             WHEN 'lexeme' THEN lexeme.simplified
             WHEN 'lexeme_reading' THEN reading_lexeme.simplified
             WHEN 'sentence' THEN sentence.chinese
             WHEN 'grammar_topic' THEN grammar.title
           END AS label,
           CASE c.subject_type
             WHEN 'lexeme' THEN (
               SELECT preferred.pinyin FROM lexeme_readings preferred
               WHERE preferred.lexeme_id = lexeme.id AND preferred.is_preferred = 1
                 AND preferred.retired_at IS NULL
               ORDER BY preferred.id LIMIT 1
             )
             WHEN 'lexeme_reading' THEN reading.pinyin
             WHEN 'sentence' THEN sentence.pinyin
             WHEN 'grammar_topic' THEN grammar.level
           END AS detail,
           COUNT(*) AS recent_attempts,
           SUM(CASE
             WHEN a.correct = 0
               AND NOT (
                 a.mode = 'pronunciation'
                 AND a.activity_type = 'hanzi_to_pinyin'
               )
             THEN 1 ELSE 0 END
           ) AS errors,
           SUM(CASE
             WHEN a.mode = 'pronunciation'
               AND a.activity_type = 'hanzi_to_pinyin'
               AND a.correct = 0
             THEN 1 ELSE 0 END
           ) AS self_reported_recall_misses,
           SUM(CASE
             WHEN a.mode = 'reflex'
               AND COALESCE(json_extract(a.metadata_json, '$.choiceCount'), 4) = 4
               AND a.response_ms >= ? THEN 1 ELSE 0
           END) AS slow_responses,
           SUM(CASE WHEN a.response_ms IS NOT NULL THEN 1 ELSE 0 END) AS response_time_responses,
           AVG(a.response_ms) AS average_response_ms,
           SUM(CASE WHEN a.self_rating IS NOT NULL THEN 1 ELSE 0 END) AS self_ratings,
           AVG(a.self_rating) AS average_self_rating,
           SUM(CASE WHEN a.self_rating IN (1, 2) THEN 1 ELSE 0 END) AS low_self_ratings,
           0 AS fsrs_1,
           0 AS fsrs_2,
           0 AS fsrs_3,
           0 AS fsrs_4,
           0 AS lapses,
           NULL AS due_at,
           MAX(a.occurred_at) AS last_practiced_at,
           (SUM(CASE
             WHEN a.correct = 0
               AND NOT (
                 a.mode = 'pronunciation'
                 AND a.activity_type = 'hanzi_to_pinyin'
               )
             THEN 4 ELSE 0 END
           )
             + SUM(CASE
               WHEN a.mode = 'pronunciation'
                 AND a.activity_type = 'hanzi_to_pinyin'
                 AND a.correct = 0 THEN 3 ELSE 0 END
             )
             + SUM(CASE WHEN a.self_rating IN (1, 2) THEN 3 ELSE 0 END)
             + SUM(CASE
               WHEN a.mode = 'reflex'
                 AND COALESCE(json_extract(a.metadata_json, '$.choiceCount'), 4) = 4
                 AND a.response_ms >= ? THEN 2 ELSE 0
             END)) AS priority
         FROM attempts a
         JOIN cards c ON c.id = a.card_id
         LEFT JOIN lexemes lexeme ON lexeme.id = c.lexeme_id
         LEFT JOIN lexeme_readings reading ON reading.id = c.lexeme_reading_id
         LEFT JOIN lexemes reading_lexeme ON reading_lexeme.id = reading.lexeme_id
         LEFT JOIN sentences sentence ON sentence.id = c.sentence_id
         LEFT JOIN grammar_topics grammar ON grammar.id = c.grammar_topic_id
         WHERE a.learner_id = ? AND a.occurred_at >= ? AND a.occurred_at <= ?
           AND a.mode <> 'study'
           AND NOT (
             a.mode = 'pronunciation'
             AND json_extract(a.metadata_json, '$.interaction') = 'skip-uncached-audio'
           )
         GROUP BY c.id, a.mode, a.activity_type, quiz_choice_count, label, detail
         HAVING SUM(CASE
             WHEN a.correct = 0
               AND NOT (
                 a.mode = 'pronunciation'
                 AND a.activity_type = 'hanzi_to_pinyin'
               )
             THEN 1 ELSE 0 END
           ) > 0
           OR SUM(CASE
             WHEN a.mode = 'pronunciation'
               AND a.activity_type = 'hanzi_to_pinyin'
               AND a.correct = 0
             THEN 1 ELSE 0 END
           ) > 0
           OR SUM(CASE WHEN a.self_rating IN (1, 2) THEN 1 ELSE 0 END) > 0
           OR SUM(CASE
             WHEN a.mode = 'reflex'
               AND COALESCE(json_extract(a.metadata_json, '$.choiceCount'), 4) = 4
               AND a.response_ms >= ? THEN 1 ELSE 0
           END) > 0
         ), ranked AS (
           SELECT trouble.*,
             ROW_NUMBER() OVER (
               PARTITION BY mode
               ORDER BY priority DESC, last_practiced_at DESC, card_id
             ) AS mode_rank
           FROM trouble
         )
         SELECT * FROM ranked
         WHERE mode_rank <= ?
         ORDER BY priority DESC, last_practiced_at DESC, card_id`,
      )
      .bind(
        REFLEX_SLOW_RESPONSE_MS,
        REFLEX_SLOW_RESPONSE_MS,
        learnerId,
        recentCutoff,
        generatedAt,
        REFLEX_SLOW_RESPONSE_MS,
        PRACTICE_TROUBLE_CANDIDATES_PER_MODE,
      ),
  ]);

  const metadata = rows<MetadataRow>(results[0])[0];
  const vocabularyCounts = rows<VocabularyCountsRow>(results[1])[0];
  if (!metadata || !vocabularyCounts) throw new Error("progress metadata is unavailable");
  const summaries = rows<ModeSummaryRow>(results[2]);
  const markers = rows<ActivityMarkerRow>(results[3]);
  const grammarTopics = rows<GrammarTopicRow>(results[4]);
  const rankedTrouble = [
    ...rows<TroubleRow>(results[5]).map(rankVocabularyTrouble),
    ...rows<TroubleRow>(results[6]).map(rankPracticeTrouble),
  ].sort(compareRankedTrouble);
  const troublesomeItems = selectCrossModeTrouble(rankedTrouble);

  const vocabularySummary = combineSummaries(summaries.filter(({ mode }) => mode === "study"));
  const pronunciationSummaries = summaries.filter(({ mode }) => mode === "pronunciation");
  const readingSummary = combineSummaries(summaries.filter(({ mode }) => mode === "reading"));
  const grammarSummary = combineSummaries(summaries.filter(({ mode }) => mode === "grammar"));
  const reflexSummaries = summaries.filter(({ mode }) => mode === "reflex");
  const reflexByChoiceCount = ([4, 9] as const).map((choiceCount) => {
    const summary = combineSummaries(
      reflexSummaries.filter(({ quiz_choice_count }) => quiz_choice_count === choiceCount),
    );
    return {
      choiceCount,
      recentResponses: summary.attempts,
      correctness: correctness(summary),
      latency: {
        averageResponseMs: roundNullable(summary.averageResponseMs, 0),
        slowResponses: choiceCount === 4 ? summary.slowResponses : null,
        slowThresholdMs: choiceCount === 4 ? REFLEX_SLOW_RESPONSE_MS : null,
      },
      lastPracticedAt: summary.lastPracticedAt,
    };
  });

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    generatedAt,
    timezone: metadata.timezone,
    dataThrough: {
      serverSeq: metadata.server_seq,
      changedAt: metadata.changed_at,
      latestAttemptReceivedAt: metadata.latest_attempt_received_at,
      latestAttemptOccurredAt: metadata.latest_attempt_occurred_at,
    },
    overall: {
      last7Days: buildWindow(markers, generatedAt, 7, metadata.timezone),
      last30Days: buildWindow(markers, generatedAt, 30, metadata.timezone),
    },
    vocabulary: {
      totalScheduledCards: vocabularyCounts.total,
      dueNow: vocabularyCounts.due_now,
      new: vocabularyCounts.new_cards,
      learning: vocabularyCounts.learning,
      review: vocabularyCounts.review,
      recentScheduledReviews: fsrsTotal(vocabularySummary),
      recentRatings: fsrsDistribution(vocabularySummary),
      lastReviewedAt: vocabularySummary.lastFsrsReviewAt,
      troublesomeCards: troubleForMode(rankedTrouble, "study"),
    },
    pronunciation: {
      recentResponses: pronunciationSummaries.reduce(
        (total, row) => total + row.attempts - row.skips,
        0,
      ),
      recentSkips: pronunciationSummaries.reduce((total, row) => total + row.skips, 0),
      byActivity: PRONUNCIATION_ACTIVITY_TYPES.map((activityType) => {
        const summary = pronunciationSummaries.find((row) => row.activity_type === activityType);
        return {
          activityType,
          responses: summary ? summary.attempts - summary.skips : 0,
          skips: summary?.skips ?? 0,
          distinctItems: summary?.distinct_items ?? 0,
          correctness:
            activityType === "hanzi_to_pinyin" || !summary ? null : optionalCorrectness(summary),
          selfReportedRecall:
            activityType === "hanzi_to_pinyin" && summary ? optionalRecall(summary) : null,
          selfRatings: summary ? optionalSelfRatings(summary) : null,
          averageResponseMs: roundNullable(summary?.average_response_ms ?? null, 0),
          lastPracticedAt: summary?.last_practiced_at ?? null,
        };
      }),
      troublesomeItems: troubleForMode(rankedTrouble, "pronunciation"),
    },
    reading: {
      recentResponses: readingSummary.attempts,
      recentSentences: readingSummary.distinctItems,
      comprehension: optionalCombinedSelfRatings(readingSummary),
      lastPracticedAt: readingSummary.lastPracticedAt,
      difficultSentences: troubleForMode(rankedTrouble, "reading"),
    },
    grammar: {
      topicCounts: grammarTopicCounts(grammarTopics),
      topics: grammarTopics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        status: topic.status,
        confidence: roundNullable(topic.self_confidence, 3),
        lastStudiedAt: topic.last_studied_at,
      })),
      recentResponses: grammarSummary.attempts,
      correctness: correctness(grammarSummary),
      confidence: optionalCombinedSelfRatings(grammarSummary),
      lastPracticedAt: grammarSummary.lastPracticedAt,
      troublesomeTopics: troubleForMode(rankedTrouble, "grammar"),
    },
    reflex: {
      recentResponses: reflexByChoiceCount.reduce(
        (total, summary) => total + summary.recentResponses,
        0,
      ),
      byChoiceCount: reflexByChoiceCount,
      lastPracticedAt: maximumNullable(
        reflexByChoiceCount[0].lastPracticedAt,
        reflexByChoiceCount[1].lastPracticedAt,
      ),
      troublesomeItems: troubleForMode(rankedTrouble, "reflex"),
    },
    troublesomeItems,
  };
}

interface CombinedSummary {
  attempts: number;
  distinctItems: number;
  correctnessResponses: number;
  correctAnswers: number;
  selfRatingResponses: number;
  selfRatingSum: number;
  selfDistribution: Record<FsrsRating, number>;
  responseTimeResponses: number;
  responseTimeSum: number;
  slowResponses: number;
  fsrsDistribution: Record<FsrsRating, number>;
  lastPracticedAt: number | null;
  lastFsrsReviewAt: number | null;
  averageResponseMs: number | null;
}

function combineSummaries(items: readonly ModeSummaryRow[]): CombinedSummary {
  const combined: CombinedSummary = {
    attempts: 0,
    distinctItems: 0,
    correctnessResponses: 0,
    correctAnswers: 0,
    selfRatingResponses: 0,
    selfRatingSum: 0,
    selfDistribution: ratingRecord(),
    responseTimeResponses: 0,
    responseTimeSum: 0,
    slowResponses: 0,
    fsrsDistribution: ratingRecord(),
    lastPracticedAt: null,
    lastFsrsReviewAt: null,
    averageResponseMs: null,
  };
  for (const item of items) {
    combined.attempts += item.attempts;
    combined.distinctItems += item.distinct_items;
    combined.correctnessResponses += item.correctness_responses;
    combined.correctAnswers += item.correct_answers;
    combined.selfRatingResponses += item.self_rating_responses;
    combined.selfRatingSum += (item.average_self_rating ?? 0) * item.self_rating_responses;
    combined.responseTimeResponses += item.response_time_responses;
    combined.responseTimeSum += (item.average_response_ms ?? 0) * item.response_time_responses;
    combined.slowResponses += item.slow_responses;
    combined.selfDistribution[1] += item.self_1;
    combined.selfDistribution[2] += item.self_2;
    combined.selfDistribution[3] += item.self_3;
    combined.selfDistribution[4] += item.self_4;
    combined.fsrsDistribution[1] += item.fsrs_1;
    combined.fsrsDistribution[2] += item.fsrs_2;
    combined.fsrsDistribution[3] += item.fsrs_3;
    combined.fsrsDistribution[4] += item.fsrs_4;
    combined.lastPracticedAt = maximumNullable(combined.lastPracticedAt, item.last_practiced_at);
    combined.lastFsrsReviewAt = maximumNullable(
      combined.lastFsrsReviewAt,
      item.last_fsrs_review_at,
    );
  }
  combined.averageResponseMs =
    combined.responseTimeResponses === 0
      ? null
      : combined.responseTimeSum / combined.responseTimeResponses;
  return combined;
}

function buildWindow(
  markers: readonly ActivityMarkerRow[],
  generatedAt: number,
  days: 7 | 30,
  timezone: string,
): ProgressWindow {
  const cutoff = generatedAt - days * DAY_MS;
  const selected = markers.filter(
    ({ occurred_at }) => occurred_at >= cutoff && occurred_at <= generatedAt,
  );
  const activeDays = new Set<string>();
  const sessions = new Set<string>();
  const byMode = emptyModeCounts();
  for (const marker of selected) {
    activeDays.add(calendarDay(marker.occurred_at, timezone));
    if (marker.study_session_id !== null) sessions.add(marker.study_session_id);
    byMode[marker.mode] += 1;
  }
  return {
    days,
    attempts: selected.length,
    answeredAttempts: selected.reduce((total, marker) => total + marker.answered, 0),
    scheduledReviews: selected.reduce((total, marker) => total + marker.scheduled_review, 0),
    activeDays: activeDays.size,
    sessions: sessions.size,
    byMode,
  };
}

function grammarTopicCounts(
  topics: readonly GrammarTopicRow[],
): ProgressSnapshot["grammar"]["topicCounts"] {
  return {
    total: topics.length,
    notIntroduced: topics.filter(({ status }) => status === null).length,
    introduced: topics.filter(({ status }) => status === "introduced").length,
    learning: topics.filter(({ status }) => status === "learning").length,
    comfortable: topics.filter(({ status }) => status === "comfortable").length,
  };
}

function correctness(summary: CombinedSummary): ProgressCorrectness {
  return {
    responses: summary.correctnessResponses,
    correct: summary.correctAnswers,
    rate:
      summary.correctnessResponses === 0
        ? null
        : round(summary.correctAnswers / summary.correctnessResponses, 3),
  };
}

function optionalCorrectness(summary: ModeSummaryRow): ProgressCorrectness | null {
  if (summary.correctness_responses === 0) return null;
  return {
    responses: summary.correctness_responses,
    correct: summary.correct_answers,
    rate: round(summary.correct_answers / summary.correctness_responses, 3),
  };
}

function optionalRecall(summary: ModeSummaryRow): ProgressSelfReportedRecall | null {
  if (summary.correctness_responses === 0) return null;
  return {
    responses: summary.correctness_responses,
    remembered: summary.correct_answers,
  };
}

function selfRatings(summary: CombinedSummary): ProgressSelfRatings {
  return {
    responses: summary.selfRatingResponses,
    average:
      summary.selfRatingResponses === 0
        ? null
        : round(summary.selfRatingSum / summary.selfRatingResponses, 2),
    low: summary.selfDistribution[1] + summary.selfDistribution[2],
    distribution: { ...summary.selfDistribution },
  };
}

function optionalCombinedSelfRatings(summary: CombinedSummary): ProgressSelfRatings | null {
  return summary.selfRatingResponses === 0 ? null : selfRatings(summary);
}

function optionalSelfRatings(summary: ModeSummaryRow): ProgressSelfRatings | null {
  if (summary.self_rating_responses === 0) return null;
  return {
    responses: summary.self_rating_responses,
    average: roundNullable(summary.average_self_rating, 2),
    low: summary.self_1 + summary.self_2,
    distribution: {
      1: summary.self_1,
      2: summary.self_2,
      3: summary.self_3,
      4: summary.self_4,
    },
  };
}

function fsrsDistribution(summary: CombinedSummary): Record<FsrsRating, number> {
  return { ...summary.fsrsDistribution };
}

function fsrsTotal(summary: CombinedSummary): number {
  return Object.values(summary.fsrsDistribution).reduce((total, count) => total + count, 0);
}

function rankVocabularyTrouble(row: TroubleRow): RankedTroubleItem {
  const ratings = troubleRatings(row);
  const reasons: string[] = [];
  if (ratings[1] > 0) reasons.push(`${ratings[1]} Again rating${plural(ratings[1])} recently`);
  if (ratings[2] > 0) reasons.push(`${ratings[2]} Hard rating${plural(ratings[2])} recently`);
  if (row.lapses > 0) reasons.push(`${row.lapses} lifetime lapse${plural(row.lapses)}`);
  return {
    priority: ratings[1] * 4 + ratings[2] * 2 + row.lapses * 3,
    item: {
      id: `study:${row.card_id}`,
      cardId: row.card_id,
      mode: "study",
      activityType: row.activity_type,
      label: row.label,
      detail: row.detail,
      recentAttempts: row.recent_attempts,
      lastPracticedAt: row.last_practiced_at,
      reasons,
      evidence: {
        fsrsRatings: ratings,
        lapses: row.lapses,
        ...(row.due_at === null ? {} : { dueAt: row.due_at }),
      },
    },
  };
}

function rankPracticeTrouble(row: TroubleRow): RankedTroubleItem {
  const reasons: string[] = [];
  const choiceCount =
    row.mode === "reflex" && (row.quiz_choice_count === 4 || row.quiz_choice_count === 9)
      ? row.quiz_choice_count
      : null;
  if (row.errors > 0)
    reasons.push(`${row.errors} incorrect response${plural(row.errors)} recently`);
  if (row.self_reported_recall_misses > 0) {
    reasons.push(
      `${row.self_reported_recall_misses} self-reported recall miss${plural(row.self_reported_recall_misses)} recently`,
    );
  }
  if (row.mode === "reflex" && row.slow_responses > 0) {
    reasons.push(
      `${row.slow_responses} response${plural(row.slow_responses)} at or above ${REFLEX_SLOW_RESPONSE_MS / 1_000}s`,
    );
  }
  if (row.low_self_ratings > 0) {
    const kind =
      row.mode === "reading"
        ? "historical low comprehension rating"
        : row.mode === "grammar"
          ? "historical low confidence rating"
          : "historical low self-rating";
    reasons.push(`${row.low_self_ratings} ${kind}${plural(row.low_self_ratings)}`);
  }
  return {
    priority:
      row.errors * 4 +
      row.self_reported_recall_misses * 3 +
      row.slow_responses * 2 +
      row.low_self_ratings * 3,
    item: {
      id: `${row.mode}:${row.card_id}${choiceCount === null ? "" : `:${choiceCount}`}`,
      cardId: row.card_id,
      mode: row.mode,
      activityType: row.activity_type,
      ...(choiceCount === null ? {} : { choiceCount }),
      label: row.label,
      detail: row.detail,
      recentAttempts: row.recent_attempts,
      lastPracticedAt: row.last_practiced_at,
      reasons,
      evidence: {
        ...(row.errors > 0 ? { errors: row.errors } : {}),
        ...(row.self_reported_recall_misses > 0
          ? { selfReportedRecallMisses: row.self_reported_recall_misses }
          : {}),
        ...(row.slow_responses > 0 ? { slowResponses: row.slow_responses } : {}),
        ...(row.response_time_responses > 0
          ? { averageResponseMs: roundNullable(row.average_response_ms, 0) }
          : {}),
        ...(row.self_ratings > 0
          ? {
              selfRatings: row.self_ratings,
              averageSelfRating: roundNullable(row.average_self_rating, 2),
            }
          : {}),
      },
    },
  };
}

function selectCrossModeTrouble(ranked: readonly RankedTroubleItem[]): ProgressTroubleItem[] {
  const selected: RankedTroubleItem[] = [];
  const used = new Set<string>();
  for (const mode of ["study", "pronunciation", "reading", "grammar", "reflex"] as const) {
    const candidate = ranked.find(({ item }) => item.mode === mode);
    if (!candidate) continue;
    selected.push(candidate);
    used.add(candidate.item.id);
  }
  for (const candidate of ranked) {
    if (selected.length >= TROUBLE_LIMIT) break;
    if (used.has(candidate.item.id)) continue;
    selected.push(candidate);
    used.add(candidate.item.id);
  }
  return selected.sort(compareRankedTrouble).map(({ item }) => item);
}

function troubleForMode(
  ranked: readonly RankedTroubleItem[],
  mode: PracticeMode,
): ProgressTroubleItem[] {
  return ranked
    .filter(({ item }) => item.mode === mode)
    .slice(0, PER_MODE_TROUBLE_LIMIT)
    .map(({ item }) => item);
}

function compareRankedTrouble(left: RankedTroubleItem, right: RankedTroubleItem): number {
  return (
    right.priority - left.priority ||
    (right.item.lastPracticedAt ?? -1) - (left.item.lastPracticedAt ?? -1) ||
    left.item.id.localeCompare(right.item.id)
  );
}

function troubleRatings(row: TroubleRow): Record<FsrsRating, number> {
  return { 1: row.fsrs_1, 2: row.fsrs_2, 3: row.fsrs_3, 4: row.fsrs_4 };
}

function rows<T extends ProgressQueryRow>(result: D1Result<ProgressQueryRow> | undefined): T[] {
  if (!result) throw new Error("progress query result is missing");
  return result.results as T[];
}

function ratingRecord(): Record<FsrsRating, number> {
  return { 1: 0, 2: 0, 3: 0, 4: 0 };
}

function emptyModeCounts(): Record<PracticeMode, number> {
  return { study: 0, reflex: 0, pronunciation: 0, reading: 0, grammar: 0 };
}

function calendarDay(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function maximumNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function roundNullable(value: number | null, digits: number): number | null {
  return value === null ? null : round(value, digits);
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}
