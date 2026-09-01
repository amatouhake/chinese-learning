import { describe, expect, test } from "bun:test";

import {
  REFLEX_ACTIVITY_TYPES,
  REFLEX_INTERACTION,
  parseReflexAttemptMetadata,
  presentReflexQuestion,
  reflexHistorySummary,
  selectNextReflexCard,
  selectReflexPool,
} from "../../src/domain/reflex";
import { displayReflexMeaning } from "../../src/db/reflex";
import type { ReflexActivityType, ReflexAnswerRecord, ReflexCard } from "../../src/domain/types";

describe("Reflex automaticity selection", () => {
  test("prefers an exact reading sense over a lexeme-wide Japanese enrichment", () => {
    const lexemeMeanings = JSON.stringify([
      { language: "ja", text: "良い" },
      { language: "en", text: "good" },
    ]);

    expect(displayReflexMeaning(lexemeMeanings, JSON.stringify(["be fond of"]))).toBe("be fond of");
    expect(displayReflexMeaning(lexemeMeanings, null)).toBe("良い");
  });

  test("prioritizes incorrect, slow, recent, and under-practiced history", () => {
    const now = Date.parse("2026-08-31T00:00:00Z");
    const clean = reflexHistorySummary(
      { attempts: 8, incorrect: 0, slow: 0, averageResponseMs: 700, lastTroubleAt: null },
      now,
    );
    const slow = reflexHistorySummary(
      { attempts: 4, incorrect: 0, slow: 3, averageResponseMs: 3_000, lastTroubleAt: now - 1_000 },
      now,
    );
    const incorrect = reflexHistorySummary(
      { attempts: 4, incorrect: 3, slow: 0, averageResponseMs: 900, lastTroubleAt: now - 1_000 },
      now,
    );
    const unseen = reflexHistorySummary(
      { attempts: 0, incorrect: 0, slow: 0, averageResponseMs: null, lastTroubleAt: null },
      now,
    );

    expect(incorrect.priority).toBeGreaterThan(slow.priority);
    expect(slow.priority).toBeGreaterThan(clean.priority);
    expect(unseen.priority).toBeGreaterThan(clean.priority);
  });

  test("builds a bounded deterministic pool with coverage across activated activities", () => {
    const candidates = REFLEX_ACTIVITY_TYPES.flatMap((activity, activityIndex) =>
      [0, 1].map((index) => card(`${activity}:${index}`, activity, activityIndex + index)),
    );
    const selected = selectReflexPool(candidates, "reflex-pool", 4);

    expect(selected).toEqual(selectReflexPool(candidates, "reflex-pool", 4));
    expect(selected).toHaveLength(4);
    expect(new Set(selected.map(({ activityType }) => activityType))).toEqual(
      new Set(REFLEX_ACTIVITY_TYPES),
    );
  });

  test("repeats a current error after a two-item cooldown", () => {
    const cards = [
      card("weak", "hanzi_to_meaning", 0),
      card("other-a", "meaning_to_hanzi", 0),
      card("other-b", "hanzi_to_pinyin", 0),
      card("other-c", "pinyin_to_hanzi", 0),
    ];
    const answers: ReflexAnswerRecord[] = [answer("weak", 1, false, 600)];

    const second = selectNextReflexCard(cards, answers, 2);
    expect(second?.cardId).not.toBe("weak");
    if (!second) throw new Error("missing second Reflex item");
    answers.push(answer(second.cardId, 2, true, 600));
    const third = selectNextReflexCard(cards, answers, 3);
    expect(third?.cardId).not.toBe("weak");
    if (!third) throw new Error("missing third Reflex item");
    answers.push(answer(third.cardId, 3, true, 600));

    expect(selectNextReflexCard(cards, answers, 4)?.cardId).toBe("weak");
  });

  test("rotates option positions across repeat exposures without changing identities", () => {
    const target = card("target", "hanzi_to_meaning", 0);
    const first = presentReflexQuestion(target, "session", 1, 0);
    const repeat = presentReflexQuestion(target, "session", 4, 1);

    expect(first.choices.map(({ id }) => id).sort()).toEqual(
      repeat.choices.map(({ id }) => id).sort(),
    );
    expect(first.choices.findIndex(({ id }) => id === target.answerChoiceId)).not.toBe(
      repeat.choices.findIndex(({ id }) => id === target.answerChoiceId),
    );
  });

  test("requires an auditable four-choice presentation in exact order", () => {
    const metadata = {
      interaction: REFLEX_INTERACTION as typeof REFLEX_INTERACTION,
      presentationId: "session:1:card",
      round: 1,
      prompt: "你",
      promptHint: null,
      answerChoiceId: "card",
      selectedChoiceId: "card",
      choiceCount: 4 as const,
      timingInterrupted: false,
      options: ["card", "b", "c", "d"].map((id, index) => ({
        id,
        label: id,
        position: index + 1,
      })),
    };
    expect(parseReflexAttemptMetadata(metadata)).toEqual(metadata);
    expect(() =>
      parseReflexAttemptMetadata({
        ...metadata,
        options: metadata.options.map((option, index) => ({
          ...option,
          position: index === 0 ? 2 : option.position,
        })),
      }),
    ).toThrow("presentation order");
  });
});

function card(id: string, activityType: ReflexActivityType, priority: number): ReflexCard {
  return {
    cardId: id,
    lexemeId: `lexeme:${id}`,
    readingId: activityType.includes("pinyin") ? `reading:${id}` : null,
    activityType,
    prompt: id,
    promptHint: null,
    answerChoiceId: id,
    choices: [id, `${id}:b`, `${id}:c`, `${id}:d`].map((choiceId) => ({
      id: choiceId,
      label: choiceId,
    })),
    history: {
      attempts: 0,
      incorrect: 0,
      slow: 0,
      averageResponseMs: null,
      lastTroubleAt: null,
      priority,
    },
  };
}

function answer(
  cardId: string,
  round: number,
  correct: boolean,
  responseMs: number,
): ReflexAnswerRecord {
  return {
    eventId: `event:${round}`,
    cardId,
    correct,
    responseMs,
    timingInterrupted: false,
    round,
  };
}
