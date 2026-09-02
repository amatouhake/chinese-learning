import type { PracticeSessionHistory, PracticeSessionSummary } from "../domain/types";
import type { StorageLike } from "./study-storage";

const HISTORY_CACHE_KEY = "chinese-learning.practice-history-cache.v1";

export function readPracticeHistoryCache(
  storage: StorageLike = localStorage,
): PracticeSessionHistory {
  try {
    const value: unknown = JSON.parse(storage.getItem(HISTORY_CACHE_KEY) ?? "null");
    if (!isRecord(value) || !Array.isArray(value.sessions)) return emptyHistory();
    return {
      generatedAt:
        typeof value.generatedAt === "number" && Number.isSafeInteger(value.generatedAt)
          ? value.generatedAt
          : 0,
      sessions: value.sessions.filter(isSummary),
    };
  } catch {
    return emptyHistory();
  }
}

export function cachePracticeHistory(
  history: PracticeSessionHistory,
  storage: StorageLike = localStorage,
): void {
  write(
    {
      generatedAt: history.generatedAt,
      sessions: mergeSummaries(history.sessions, readPracticeHistoryCache(storage).sessions),
    },
    storage,
  );
}

export function cachePracticeSummary(
  summary: PracticeSessionSummary,
  storage: StorageLike = localStorage,
): void {
  const cached = readPracticeHistoryCache(storage);
  write(
    {
      generatedAt: Math.max(cached.generatedAt, summary.endedAt),
      sessions: mergeSummaries([summary], cached.sessions),
    },
    storage,
  );
}

function mergeSummaries(
  preferred: readonly PracticeSessionSummary[],
  fallback: readonly PracticeSessionSummary[],
): PracticeSessionSummary[] {
  const sessions = new Map<string, PracticeSessionSummary>();
  for (const summary of fallback) sessions.set(summary.sessionId, summary);
  for (const summary of preferred) sessions.set(summary.sessionId, summary);
  return [...sessions.values()]
    .sort(
      (left, right) =>
        right.endedAt - left.endedAt || right.sessionId.localeCompare(left.sessionId),
    )
    .slice(0, 50);
}

function write(history: PracticeSessionHistory, storage: StorageLike): void {
  try {
    storage.setItem(HISTORY_CACHE_KEY, JSON.stringify(history));
  } catch {
    // The canonical history remains in D1; cache pressure must not block practice.
  }
}

function isSummary(value: unknown): value is PracticeSessionSummary {
  if (
    !isRecord(value) ||
    value.summaryVersion !== 1 ||
    !isText(value.sessionId) ||
    !isText(value.learnerId) ||
    !isInteger(value.startedAt) ||
    !isInteger(value.endedAt) ||
    !isInteger(value.completedItems) ||
    !isInteger(value.requestedItems) ||
    !Array.isArray(value.attentionItems) ||
    !value.attentionItems.every(isAttentionItem) ||
    !isTrend(value.trend) ||
    !isEvidenceCoverage(value.evidenceCoverage, value.completedItems) ||
    !isRecord(value.configuration) ||
    !isRecord(value.evidence)
  ) {
    return false;
  }
  const configuration = value.configuration;
  const evidence = value.evidence;
  switch (value.practice) {
    case "vocabulary_review":
      return (
        value.mode === "study" &&
        isStudyDirection(configuration.direction) &&
        isInteger(configuration.requestedItems) &&
        isInteger(configuration.actualItems) &&
        isRatingEvidence(evidence.ratings) &&
        isCountRecord(evidence.directions, ["hanzi_to_meaning", "meaning_to_hanzi"]) &&
        isCountRecord(evidence.sources, ["due", "new"])
      );
    case "vocabulary_quiz":
      return (
        value.mode === "reflex" &&
        isQuizActivity(configuration.activityType) &&
        (configuration.choiceCount === 4 || configuration.choiceCount === 9) &&
        isInteger(configuration.requestedItems) &&
        configuration.selectionStrategy === "weak_and_slow_v1" &&
        isCorrectnessEvidence(evidence.correctness) &&
        isNullableInteger(evidence.averageResponseMs) &&
        isInteger(evidence.timedResponses) &&
        isInteger(evidence.timingInterrupted) &&
        isInteger(evidence.slowResponses)
      );
    case "pronunciation":
      return (
        value.mode === "pronunciation" &&
        isText(configuration.focus) &&
        isInteger(configuration.requestedItems) &&
        isRecord(evidence.activities) &&
        (evidence.correctness === null || isCorrectnessEvidence(evidence.correctness)) &&
        (evidence.selfRatings === null || isRatingEvidence(evidence.selfRatings)) &&
        isInteger(evidence.skipped)
      );
    case "reading":
      return (
        value.mode === "reading" &&
        isInteger(configuration.requestedItems) &&
        isRatingEvidence(evidence.comprehension) &&
        isTopicList(evidence.grammarTopics)
      );
    case "grammar":
      return (
        value.mode === "grammar" &&
        isInteger(configuration.requestedItems) &&
        (configuration.focusTopicId === null || isText(configuration.focusTopicId)) &&
        isCorrectnessEvidence(evidence.correctness) &&
        isRatingEvidence(evidence.confidence) &&
        isTopicList(evidence.grammarTopics)
      );
    default:
      return false;
  }
}

function isEvidenceCoverage(value: unknown, completedItems: number): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      value.status === "partial" &&
      isInteger(value.recordedItems) &&
      value.recordedItems >= 0 &&
      value.recordedItems < completedItems)
  );
}

function isAttentionItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    isText(value.cardId) &&
    isText(value.label) &&
    (value.detail === null || isText(value.detail)) &&
    Array.isArray(value.reasons) &&
    value.reasons.every(isText)
  );
}

function isTrend(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      isText(value.label) &&
      value.unit === "percent" &&
      Array.isArray(value.values) &&
      value.values.every(isInteger) &&
      Array.isArray(value.comparableSessionIds) &&
      value.comparableSessionIds.every(isText))
  );
}

function isRatingEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    isInteger(value.responses) &&
    isCountRecord(value.distribution, ["1", "2", "3", "4"])
  );
}

function isCorrectnessEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    isInteger(value.responses) &&
    isInteger(value.correct) &&
    (value.rate === null || typeof value.rate === "number")
  );
}

function isCountRecord(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => isInteger(value[key]));
}

function isTopicList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((topic) => isRecord(topic) && isText(topic.id) && isText(topic.title))
  );
}

function isStudyDirection(value: unknown): boolean {
  return value === "mixed" || value === "hanzi_to_meaning" || value === "meaning_to_hanzi";
}

function isQuizActivity(value: unknown): boolean {
  return isStudyDirection(value) || value === "hanzi_to_pinyin" || value === "pinyin_to_hanzi";
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableInteger(value: unknown): boolean {
  return value === null || isInteger(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyHistory(): PracticeSessionHistory {
  return { generatedAt: 0, sessions: [] };
}
