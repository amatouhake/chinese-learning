import { REFLEX_SLOW_RESPONSE_MS } from "../domain/reflex";
import type {
  AttemptInput,
  FsrsRating,
  GrammarSessionSummary,
  GuidedSessionView,
  PracticeAttentionItem,
  PracticeCorrectnessEvidence,
  PracticeRecallEvidence,
  PracticeRatingEvidence,
  PracticeSessionSummary,
  PronunciationSessionSummary,
  PronunciationSessionView,
  ReadingSessionSummary,
  ReflexAnswerRecord,
  ReflexCard,
  ReflexSessionView,
  StudySessionView,
  VocabularyQuizSessionSummary,
  VocabularyReviewSessionSummary,
} from "../domain/types";
import type { PronunciationActivityType } from "../domain/pronunciation";
import type { StudyReviewRecord } from "./offline-store";
import { readPracticeHistoryCache } from "./practice-history-cache";

const LOCAL_LEARNER = "learner:current-local-cache";

export function localReviewSummary(
  session: StudySessionView,
  reviews: readonly StudyReviewRecord[],
): VocabularyReviewSessionSummary {
  const ratings = ratingEvidence(reviews.map(({ rating }) => rating));
  return {
    ...base(
      session.id,
      "study",
      "vocabulary_review",
      session.startedAt,
      session.endedAt,
      session.reviewedCards,
      session.maxCards,
      reviews.length,
    ),
    mode: "study",
    practice: "vocabulary_review",
    configuration: {
      direction: session.direction,
      requestedItems: session.maxCards,
      actualItems: session.reviewedCards,
    },
    evidence: {
      ratings,
      directions: {
        hanzi_to_meaning: reviews.filter(({ activityType }) => activityType === "hanzi_to_meaning")
          .length,
        meaning_to_hanzi: reviews.filter(({ activityType }) => activityType === "meaning_to_hanzi")
          .length,
      },
      sources: {
        due: reviews.filter(({ source }) => source === "due").length,
        new: reviews.filter(({ source }) => source === "new").length,
      },
    },
    attentionItems: reviews
      .filter(({ rating }) => rating <= 2)
      .map(({ cardId, simplified, pinyin, rating }) => ({
        cardId,
        label: simplified,
        detail: pinyin,
        reasons: [rating === 1 ? "忘れた" : "あやふや"],
      }))
      .slice(0, 5),
  };
}

export function localQuizSummary(
  session: ReflexSessionView,
  answers: readonly ReflexAnswerRecord[],
  cards: readonly ReflexCard[],
): VocabularyQuizSessionSummary {
  const timed = answers.flatMap(({ responseMs }) => (responseMs === null ? [] : [responseMs]));
  const labelByCard = new Map(
    cards.map((card) => [card.cardId, { label: card.prompt, detail: card.promptHint }]),
  );
  return {
    ...base(
      session.id,
      "reflex",
      "vocabulary_quiz",
      session.startedAt,
      session.endedAt,
      session.completedItems,
      session.maxItems,
      answers.length,
    ),
    mode: "reflex",
    practice: "vocabulary_quiz",
    configuration: {
      activityType: session.activityType,
      choiceCount: session.choiceCount,
      requestedItems: session.maxItems,
      selectionStrategy: session.selectionStrategy,
    },
    evidence: {
      correctness: correctness(answers.map(({ correct }) => correct)),
      averageResponseMs: average(timed),
      timedResponses: timed.length,
      timingInterrupted: answers.filter(({ timingInterrupted }) => timingInterrupted).length,
      slowResponses:
        session.choiceCount === 4
          ? timed.filter((value) => value >= REFLEX_SLOW_RESPONSE_MS).length
          : 0,
    },
    attentionItems: quizAttentionItems(session, answers, labelByCard),
  };
}

export function hasCompletedLocalResult(session: { completedItems: number }): boolean {
  return session.completedItems > 0;
}

export function localPronunciationSummary(
  session: PronunciationSessionView,
  attempts: readonly AttemptInput[],
): PronunciationSessionSummary {
  const activities: Partial<Record<PronunciationActivityType, number>> = {};
  for (const attempt of attempts) {
    const activity = attempt.activityType as PronunciationActivityType;
    activities[activity] = (activities[activity] ?? 0) + 1;
  }
  const objective = attempts.flatMap(({ activityType, correct }) =>
    activityType === "hanzi_to_pinyin" || correct === undefined ? [] : [correct],
  );
  const recall = attempts.flatMap(({ activityType, correct }) =>
    activityType === "hanzi_to_pinyin" && correct !== undefined ? [correct] : [],
  );
  const selfRatings = attempts.flatMap(({ selfRating }) =>
    selfRating === undefined ? [] : [selfRating],
  );
  return {
    ...base(
      session.id,
      "pronunciation",
      "pronunciation",
      session.startedAt,
      session.endedAt,
      session.completedItems,
      session.maxItems,
      attempts.length,
    ),
    mode: "pronunciation",
    practice: "pronunciation",
    configuration: { focus: session.focus, requestedItems: session.maxItems },
    evidence: {
      activities,
      correctness: objective.length > 0 ? correctness(objective) : null,
      selfReportedRecall: recall.length > 0 ? recallEvidence(recall) : null,
      selfRatings: selfRatings.length > 0 ? ratingEvidence(selfRatings) : null,
      skipped: attempts.filter(({ metadata }) => metadata?.interaction === "skip-uncached-audio")
        .length,
    },
    attentionItems: localPronunciationAttention(attempts),
  };
}

export function localGuidedSummary(
  session: GuidedSessionView,
  attempts: readonly AttemptInput[],
): ReadingSessionSummary | GrammarSessionSummary {
  if (session.mode === "reading") {
    return {
      ...base(
        session.id,
        "reading",
        "reading",
        session.startedAt,
        session.endedAt,
        session.completedItems,
        session.maxItems,
        attempts.length,
      ),
      mode: "reading",
      practice: "reading",
      configuration: { requestedItems: session.maxItems },
      evidence: {
        comprehension: optionalRatingEvidence(attempts.map(({ selfRating }) => selfRating ?? null)),
        grammarTopics: localTopics(attempts),
      },
      attentionItems: localAttention(attempts, "過去の理解度評価が低い"),
    };
  }
  return {
    ...base(
      session.id,
      "grammar",
      "grammar",
      session.startedAt,
      session.endedAt,
      session.completedItems,
      session.maxItems,
      attempts.length,
    ),
    mode: "grammar",
    practice: "grammar",
    configuration: { requestedItems: session.maxItems, focusTopicId: session.focusTopicId },
    evidence: {
      correctness: correctness(
        attempts.flatMap(({ correct }) => (correct === undefined ? [] : [correct])),
      ),
      confidence: optionalRatingEvidence(attempts.map(({ selfRating }) => selfRating ?? null)),
      grammarTopics: localTopics(attempts),
    },
    attentionItems: localAttention(attempts, "過去の自信度評価が低い"),
  };
}

function base(
  sessionId: string,
  mode: PracticeSessionSummary["mode"],
  practice: PracticeSessionSummary["practice"],
  startedAt: number,
  endedAt: number | null,
  completedItems: number,
  requestedItems: number,
  recordedItems = completedItems,
) {
  const cachedEnd = readPracticeHistoryCache().sessions.find(
    (item) => item.sessionId === sessionId,
  )?.endedAt;
  return {
    summaryVersion: 1 as const,
    sessionId,
    learnerId: LOCAL_LEARNER,
    mode,
    practice,
    startedAt,
    endedAt: endedAt ?? cachedEnd ?? Date.now(),
    completedItems,
    requestedItems,
    attentionItems: [],
    trend: null,
    ...(recordedItems < completedItems
      ? { evidenceCoverage: { status: "partial" as const, recordedItems } }
      : {}),
  };
}

function correctness(values: readonly boolean[]): PracticeCorrectnessEvidence {
  const correct = values.filter(Boolean).length;
  return {
    responses: values.length,
    correct,
    rate: values.length === 0 ? null : correct / values.length,
  };
}

function recallEvidence(values: readonly boolean[]): PracticeRecallEvidence {
  return {
    responses: values.length,
    remembered: values.filter(Boolean).length,
  };
}

function ratingEvidence(values: readonly (number | null)[]): PracticeRatingEvidence {
  const distribution: Record<FsrsRating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const value of values)
    if (value === 1 || value === 2 || value === 3 || value === 4) distribution[value] += 1;
  return {
    responses: Object.values(distribution).reduce((sum, value) => sum + value, 0),
    distribution,
  };
}

function optionalRatingEvidence(values: readonly (number | null)[]): PracticeRatingEvidence | null {
  const evidence = ratingEvidence(values);
  return evidence.responses === 0 ? null : evidence;
}

function localPronunciationAttention(attempts: readonly AttemptInput[]): PracticeAttentionItem[] {
  return attempts
    .flatMap((attempt) => {
      const reason =
        attempt.activityType === "hanzi_to_pinyin" && attempt.correct === false
          ? "自己申告で思い出せなかった"
          : attempt.correct === false
            ? "誤答"
            : attempt.selfRating !== undefined && attempt.selfRating <= 2
              ? "過去の自己評価が低い"
              : null;
      return reason ? [{ attempt, reason }] : [];
    })
    .map(({ attempt, reason }) => ({
      cardId: attempt.cardId,
      label:
        typeof attempt.metadata?.itemLabel === "string"
          ? attempt.metadata.itemLabel
          : attempt.cardId,
      detail: typeof attempt.metadata?.itemDetail === "string" ? attempt.metadata.itemDetail : null,
      reasons: [reason],
    }))
    .filter(
      (item, index, items) => items.findIndex(({ cardId }) => cardId === item.cardId) === index,
    )
    .slice(0, 5);
}

function localAttention(attempts: readonly AttemptInput[], historicalRatingReason: string) {
  return attempts
    .filter(
      ({ correct, selfRating }) =>
        correct === false || (selfRating !== undefined && selfRating <= 2),
    )
    .map((attempt) => ({
      cardId: attempt.cardId,
      label:
        typeof attempt.metadata?.itemLabel === "string"
          ? attempt.metadata.itemLabel
          : attempt.cardId,
      detail: typeof attempt.metadata?.itemDetail === "string" ? attempt.metadata.itemDetail : null,
      reasons: [attempt.correct === false ? "誤答" : historicalRatingReason],
    }))
    .filter(
      (item, index, items) => items.findIndex(({ cardId }) => cardId === item.cardId) === index,
    )
    .slice(0, 5);
}

function localTopics(attempts: readonly AttemptInput[]) {
  const topics = new Map<string, string>();
  for (const { metadata } of attempts) {
    if (typeof metadata?.topicId === "string")
      topics.set(
        metadata.topicId,
        typeof metadata.topicTitle === "string" ? metadata.topicTitle : metadata.topicId,
      );
    if (Array.isArray(metadata?.grammarTopicIds)) {
      for (const id of metadata.grammarTopicIds) {
        if (typeof id === "string" && !topics.has(id)) topics.set(id, "文法トピック");
      }
    }
    if (Array.isArray(metadata?.grammarTopics)) {
      for (const topic of metadata.grammarTopics) {
        if (typeof topic !== "object" || topic === null || Array.isArray(topic)) continue;
        const record = topic as Record<string, unknown>;
        if (typeof record.id === "string" && typeof record.title === "string") {
          topics.set(record.id, record.title);
        }
      }
    }
  }
  return [...topics].map(([id, title]) => ({ id, title }));
}

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function quizAttentionItems(
  session: ReflexSessionView,
  answers: readonly ReflexAnswerRecord[],
  labelByCard: ReadonlyMap<string, { label: string; detail: string | null }>,
) {
  const items = new Map<
    string,
    {
      cardId: string;
      label: string;
      detail: string | null;
      incorrect: boolean;
      slow: boolean;
    }
  >();
  for (const answer of answers) {
    const incorrect = !answer.correct;
    const slow =
      session.choiceCount === 4 &&
      answer.responseMs !== null &&
      answer.responseMs >= REFLEX_SLOW_RESPONSE_MS;
    if (!incorrect && !slow) continue;
    const fallback = labelByCard.get(answer.cardId);
    const existing = items.get(answer.cardId);
    if (existing) {
      existing.incorrect ||= incorrect;
      existing.slow ||= slow;
      if (existing.label === answer.cardId && answer.label !== undefined) {
        existing.label = answer.label;
        existing.detail = answer.detail ?? fallback?.detail ?? null;
      }
      continue;
    }
    items.set(answer.cardId, {
      cardId: answer.cardId,
      label: answer.label ?? fallback?.label ?? answer.cardId,
      detail: answer.detail ?? fallback?.detail ?? null,
      incorrect,
      slow,
    });
  }
  return [...items.values()].slice(0, 5).map(({ incorrect, slow, ...item }) => ({
    ...item,
    reasons: [...(incorrect ? ["誤答"] : []), ...(slow ? ["ゆっくり"] : [])],
  }));
}
