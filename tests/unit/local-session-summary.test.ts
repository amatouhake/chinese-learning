import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type {
  AttemptInput,
  GuidedSessionView,
  PracticeSessionHistory,
  PronunciationSessionView,
  ReflexAnswerRecord,
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
import { normalizeCachedReflexSession } from "../../src/web/offline-store";
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
    expect(reading.practice === "reading" && reading.evidence.comprehension?.responses).toBe(4);
    expect(grammar.practice === "grammar" && grammar.evidence.correctness.responses).toBe(4);
  });

  test("keeps current ungraded practice distinct from historical ratings", () => {
    const pronunciation = localPronunciationSummary(pronunciationSession(1, 1), [
      {
        ...attempts("pronunciation", 1)[0]!,
        selfRating: undefined,
        metadata: { interaction: "speak-compare" },
      },
    ]);
    const reading = localGuidedSummary(guidedSession("reading", 1, 1), [
      { ...attempts("reading", 1)[0]!, selfRating: undefined },
    ]);
    const grammar = localGuidedSummary(guidedSession("grammar", 1, 1), [
      { ...attempts("grammar", 1)[0]!, selfRating: undefined },
    ]);

    expect(pronunciation.evidence).toMatchObject({
      correctness: null,
      selfReportedRecall: null,
      selfRatings: null,
    });
    expect(reading.practice === "reading" && reading.evidence.comprehension).toBeNull();
    expect(grammar.practice === "grammar" && grammar.evidence.confidence).toBeNull();
  });

  test("keeps Hanzi-to-Pinyin recall out of pronunciation accuracy", () => {
    const base = attempts("pronunciation", 2);
    const summary = localPronunciationSummary(pronunciationSession(2, 2), [
      { ...base[0]!, activityType: "hanzi_to_pinyin", correct: true, selfRating: undefined },
      { ...base[1]!, activityType: "hanzi_to_pinyin", correct: false, selfRating: undefined },
    ]);

    expect(summary.evidence.correctness).toBeNull();
    expect(summary.evidence.selfReportedRecall).toEqual({ responses: 2, remembered: 1 });
    expect(summary.attentionItems[0]?.reasons).toEqual(["自己申告で思い出せなかった"]);
  });

  test("canonical history replaces a partial local projection", () => {
    const partials: PracticeSessionHistory["sessions"] = [
      localPronunciationSummary(pronunciationSession(10, 10), attempts("pronunciation", 4)),
      localGuidedSummary(guidedSession("reading", 10, 10), attempts("reading", 4)),
      localGuidedSummary(guidedSession("grammar", 10, 10), attempts("grammar", 4)),
    ];
    for (const partial of partials) {
      const storage = memoryStorage();
      cachePracticeSummary(partial, storage);
      const canonical = {
        ...partial,
        learnerId: "learner:canonical",
        evidenceCoverage: undefined,
      };
      cachePracticeHistory(
        { generatedAt: canonical.endedAt, sessions: [canonical] } satisfies PracticeSessionHistory,
        storage,
      );
      expect(readPracticeHistoryCache(storage).sessions[0]).toEqual(canonical);
    }
  });

  test("keeps Reading grammar topic titles in offline evidence", () => {
    const summary = localGuidedSummary(guidedSession("reading", 2, 2), [
      {
        ...attempts("reading", 1)[0]!,
        metadata: {
          interaction: "staged-sentence-reading",
          grammarTopicIds: ["grammar:topic:a", "grammar:topic:b"],
          grammarTopics: [
            { id: "grammar:topic:a", title: "「是」の文" },
            { id: "grammar:topic:b", title: "所有を表す「的」" },
          ],
        },
      },
    ]);

    expect(summary.practice).toBe("reading");
    if (summary.practice !== "reading") return;
    expect(summary.evidence.grammarTopics).toEqual([
      { id: "grammar:topic:a", title: "「是」の文" },
      { id: "grammar:topic:b", title: "所有を表す「的」" },
    ]);
    expect(summary.evidence.grammarTopics.map(({ title }) => title)).not.toContain(
      "grammar:topic:a",
    );
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

  test("normalizes only missing legacy Quiz configuration fields", () => {
    const legacy = {
      id: "quiz:legacy-cache",
      deviceId: "device:quiz",
      maxItems: 12,
      completedItems: 4,
      poolSize: 8,
      startedAt: 1,
      endedAt: null,
    } as ReflexSessionView;
    expect(normalizeCachedReflexSession(legacy)).toMatchObject({
      activityType: "mixed",
      choiceCount: 4,
      selectionStrategy: "weak_and_slow_v1",
    });

    expect(
      normalizeCachedReflexSession({
        ...legacy,
        activityType: "pinyin_to_hanzi",
        choiceCount: 9,
        selectionStrategy: "weak_and_slow_v1",
      }),
    ).toMatchObject({
      activityType: "pinyin_to_hanzi",
      choiceCount: 9,
      selectionStrategy: "weak_and_slow_v1",
    });
  });

  test("merges repeated Quiz attention reasons before applying the five-item limit", () => {
    const session: ReflexSessionView = {
      id: "quiz:repeated",
      deviceId: "device:quiz",
      maxItems: 8,
      completedItems: 8,
      poolSize: 6,
      activityType: "hanzi_to_meaning",
      choiceCount: 4,
      selectionStrategy: "weak_and_slow_v1",
      startedAt: 1,
      endedAt: 2,
    };
    const answer = (
      eventId: string,
      cardId: string,
      correct: boolean,
      responseMs: number,
    ): ReflexAnswerRecord => ({
      eventId,
      cardId,
      correct,
      responseMs,
      timingInterrupted: false,
      round: Number(eventId.split(":").at(-1)),
      label: cardId.replace("card:", "词"),
      detail: null,
    });
    const summary = localQuizSummary(
      session,
      [
        answer("event:1", "card:repeated", false, 800),
        answer("event:2", "card:repeated", true, 3_000),
        answer("event:3", "card:repeated", false, 900),
        answer("event:4", "card:2", false, 700),
        answer("event:5", "card:3", false, 700),
        answer("event:6", "card:4", false, 700),
        answer("event:7", "card:5", false, 700),
        answer("event:8", "card:6", false, 700),
      ],
      [],
    );

    expect(summary.attentionItems).toHaveLength(5);
    expect(summary.attentionItems[0]).toMatchObject({
      cardId: "card:repeated",
      reasons: ["誤答", "ゆっくり"],
    });
    expect(summary.attentionItems.filter(({ cardId }) => cardId === "card:repeated")).toHaveLength(
      1,
    );
    expect(summary.attentionItems.map(({ cardId }) => cardId)).not.toContain("card:6");
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
