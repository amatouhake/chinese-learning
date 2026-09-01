import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type {
  AttemptInput,
  GuidedSessionView,
  PracticeSessionHistory,
  PronunciationSessionView,
  ReflexSessionView,
} from "../../src/domain/types";
import {
  localGuidedSummary,
  localPronunciationSummary,
  localQuizSummary,
} from "../../src/web/local-session-summary";
import {
  cachePracticeHistory,
  cachePracticeSummary,
  readPracticeHistoryCache,
} from "../../src/web/practice-history-cache";
import type { StorageLike } from "../../src/web/study-storage";

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const localStorage = memoryStorage();

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
});

afterAll(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("local session summaries", () => {
  test("preserves legacy completed counts and marks missing evidence partial", () => {
    const pronunciation = localPronunciationSummary(
      pronunciationSession(10, 10),
      attempts("pronunciation", 4),
    );
    const reading = localGuidedSummary(guidedSession("reading", 10, 10), attempts("reading", 4));
    const grammar = localGuidedSummary(guidedSession("grammar", 10, 10), attempts("grammar", 4));

    for (const summary of [pronunciation, reading, grammar]) {
      expect(summary.completedItems).toBe(10);
      expect(summary.evidenceCoverage).toEqual({ status: "partial", recordedItems: 4 });
    }
    expect(pronunciation.evidence.selfRatings?.responses).toBe(4);
    expect(reading.practice === "reading" && reading.evidence.comprehension.responses).toBe(4);
    expect(grammar.practice === "grammar" && grammar.evidence.correctness.responses).toBe(4);
  });

  test("canonical history replaces a partial local projection", () => {
    const storage = memoryStorage();
    const partial = localPronunciationSummary(
      pronunciationSession(10, 10),
      attempts("pronunciation", 4),
    );
    cachePracticeSummary(partial, storage);
    const canonical = {
      ...partial,
      learnerId: "learner:canonical",
      evidenceCoverage: undefined,
      evidence: {
        ...partial.evidence,
        selfRatings: { responses: 10, distribution: { 1: 1, 2: 2, 3: 4, 4: 3 } },
      },
    };

    cachePracticeHistory(
      { generatedAt: canonical.endedAt, sessions: [canonical] } satisfies PracticeSessionHistory,
      storage,
    );
    expect(readPracticeHistoryCache(storage).sessions[0]).toEqual(canonical);
  });

  test("uses durable Quiz answer labels after prepared cards are removed", () => {
    const session: ReflexSessionView = {
      id: "quiz:completed",
      deviceId: "device:quiz",
      maxItems: 1,
      completedItems: 1,
      poolSize: 1,
      activityType: "meaning_to_hanzi",
      choiceCount: 9,
      selectionStrategy: "weak_and_slow_v1",
      startedAt: 1,
      endedAt: 2,
    };
    const summary = localQuizSummary(
      session,
      [
        {
          eventId: "event:quiz",
          cardId: "card:vocabulary:opaque",
          correct: false,
          responseMs: 5_000,
          timingInterrupted: false,
          round: 1,
          label: "觉得",
          detail: "jué de · 思う",
        },
      ],
      [],
    );

    expect(summary.attentionItems).toEqual([
      {
        cardId: "card:vocabulary:opaque",
        label: "觉得",
        detail: "jué de · 思う",
        reasons: ["誤答"],
      },
    ]);
    expect(summary.evidence.slowResponses).toBe(0);
  });
});

function pronunciationSession(completedItems: number, maxItems: number): PronunciationSessionView {
  return {
    id: "pronunciation:legacy",
    deviceId: "device:legacy",
    focus: "speaking",
    maxItems,
    completedItems,
    startedAt: 1,
    endedAt: 2,
  };
}

function guidedSession(
  mode: "reading" | "grammar",
  completedItems: number,
  maxItems: number,
): GuidedSessionView {
  return {
    id: `${mode}:legacy`,
    deviceId: "device:legacy",
    mode,
    maxItems,
    completedItems,
    focusTopicId: mode === "grammar" ? "grammar:把" : null,
    startedAt: 1,
    endedAt: 2,
  };
}

function attempts(mode: "pronunciation" | "reading" | "grammar", count: number): AttemptInput[] {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `${mode}:event:${index}`,
    deviceId: "device:legacy",
    deviceSeq: index + 1,
    occurredAt: new Date(index + 1).toISOString(),
    cardId: `${mode}:card:${index}`,
    studySessionId: `${mode}:legacy`,
    mode,
    activityType:
      mode === "pronunciation"
        ? "pronunciation_production"
        : mode === "reading"
          ? "sentence_reading"
          : "hanzi_to_meaning",
    ...(mode === "grammar" ? { correct: index % 2 === 0 } : {}),
    selfRating: ((index % 4) + 1) as 1 | 2 | 3 | 4,
    metadata: { itemLabel: `item ${index}` },
  }));
}

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
