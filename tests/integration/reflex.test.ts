import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { FIXED_OWNER_LEARNER_ID } from "../../src/worker/current-learner";

import { ingestAttempt } from "../../src/db/ingestion";
import {
  buildPronunciationImportStatements,
  type PronunciationImportInput,
} from "../../src/db/pronunciation-import";
import { createReflexSession } from "../../src/db/reflex";
import { pullSyncChanges } from "../../src/db/sync";
import { buildV1ImportStatements, type V1SourceLexeme } from "../../src/db/v1-import";
import { DEFAULT_SCHEDULER_CONFIG_ID } from "../../src/domain/fsrs";
import { REFLEX_INTERACTION, presentReflexQuestion } from "../../src/domain/reflex";
import type { AttemptInput, ReflexCard } from "../../src/domain/types";

describe("Reflex automaticity foundation", () => {
  test("prepares introduced canonical material and records non-FSRS automaticity history", async () => {
    const lexemes = fixtureLexemes();
    await applyStatements(
      await buildV1ImportStatements({
        lexemes,
        enrichments: lexemes.map(({ simplified }, index) => ({
          simplified,
          meaning_ja: `反射意味${index + 1}`,
        })),
        vocabularyVersion: "reflex-fixture-vocabulary",
        v1Version: "reflex-fixture-v1",
      }),
    );
    await applyStatements(await buildPronunciationImportStatements(pronunciationInput(lexemes)));

    for (const [index, lexeme] of lexemes.entries()) {
      await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        eventId: `reflex-introduction:${index + 1}`,
        deviceId: `reflex-introduction-device:${index + 1}`,
        deviceSeq: 1,
        occurredAt: `2026-08-30T0${index}:00:00Z`,
        cardId: vocabularyCardId(lexeme.simplified),
        mode: "study",
        activityType: "hanzi_to_meaning",
        responseMs: 700,
        metadata: { interaction: "reveal-and-rate" },
        fsrsReview: { rating: 3, schedulerConfigId: DEFAULT_SCHEDULER_CONFIG_ID },
      });
    }

    const before = await schedulerSnapshot();
    const created = await createReflexSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "reflex-foundation-session",
      deviceId: "reflex-foundation-device",
      maxItems: 4,
    });
    expect(created).toMatchObject({
      disposition: "created",
      session: { maxItems: 4, completedItems: 0, poolSize: 4 },
    });

    const pull = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
      cursor: 0,
      contentRevision: null,
      deviceId: "reflex-foundation-device",
      reflexSessionId: "reflex-foundation-session",
    });
    const cards = pull.reflexPack?.cards ?? [];
    expect(cards).toHaveLength(4);
    expect(new Set(cards.map(({ activityType }) => activityType))).toEqual(
      new Set(["hanzi_to_meaning", "meaning_to_hanzi", "hanzi_to_pinyin", "pinyin_to_hanzi"]),
    );
    for (const card of cards) {
      expect(card.choices).toHaveLength(4);
      expect(new Set(card.choices.map(({ id }) => id)).size).toBe(4);
      expect(new Set(card.choices.map(({ label }) => label)).size).toBe(4);
    }
    const polyphonicId = `lexeme:complete-hsk:${encodeURIComponent("重")}`;
    expect(
      cards.some(
        ({ activityType, lexemeId }) =>
          (activityType === "hanzi_to_meaning" || activityType === "hanzi_to_pinyin") &&
          lexemeId === polyphonicId,
      ),
    ).toBe(false);

    const card = cards[0];
    if (!card) throw new Error("missing prepared Reflex card");
    const presentation = presentReflexQuestion(card, "reflex-foundation-session", 1, 0);
    const selected = presentation.choices.find(({ id }) => id !== card.answerChoiceId);
    if (!selected) throw new Error("missing Reflex distractor");
    const attempt = reflexAttempt(card, presentation.choices, selected.id);

    const inserted = await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, attempt);
    expect(inserted).toMatchObject({
      disposition: "inserted",
      reviewCreated: false,
      cardState: null,
    });
    expect((await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, attempt)).disposition).toBe(
      "duplicate",
    );
    expect(await schedulerSnapshot()).toEqual(before);

    const persisted = await env.DB.prepare(
      `SELECT mode, activity_type, correct, response_ms, metadata_json
       FROM attempts WHERE event_id = ?`,
    )
      .bind(attempt.eventId)
      .first<{
        mode: string;
        activity_type: string;
        correct: number;
        response_ms: number;
        metadata_json: string;
      }>();
    expect(persisted).toMatchObject({
      mode: "reflex",
      activity_type: card.activityType,
      correct: 0,
      response_ms: 3_200,
    });
    expect(JSON.parse(persisted?.metadata_json ?? "{}")).toMatchObject({
      interaction: REFLEX_INTERACTION,
      selectedChoiceId: selected.id,
      answerChoiceId: card.answerChoiceId,
      options: { length: 4 },
    });

    await createReflexSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "reflex-history-session",
      deviceId: "reflex-history-device",
      maxItems: 4,
    });
    const historyPull = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
      cursor: pull.nextCursor,
      contentRevision: pull.currentContentRevision,
      deviceId: "reflex-history-device",
      reflexSessionId: "reflex-history-session",
    });
    expect(
      historyPull.reflexPack?.cards.find(({ cardId }) => cardId === card.cardId)?.history,
    ).toMatchObject({ attempts: 1, incorrect: 1, slow: 1 });

    const tampered = {
      ...attempt,
      eventId: "reflex-tampered-event",
      deviceSeq: 2,
      metadata: {
        ...attempt.metadata,
        round: 2,
        presentationId: `reflex-foundation-session:2:${card.cardId}`,
        options: (attempt.metadata?.options as Array<Record<string, unknown>>).map(
          (option, index) => (index === 0 ? { ...option, label: "tampered" } : option),
        ),
      },
    };
    await expect(ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, tampered)).rejects.toThrow(
      "prepared distractor set",
    );
    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        ...attempt,
        eventId: "reflex-over-bound-event",
        deviceSeq: 2,
        metadata: {
          ...attempt.metadata,
          round: 5,
          presentationId: `reflex-foundation-session:5:${card.cardId}`,
        },
      }),
    ).rejects.toThrow("session bound");

    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        ...attempt,
        eventId: "reflex-reused-round-event",
        deviceSeq: 2,
      }),
    ).rejects.toThrow("canonical next session round");

    for (const round of [2, 3]) {
      const nextPresentation = presentReflexQuestion(
        card,
        "reflex-foundation-session",
        round,
        round - 1,
      );
      await ingestAttempt(
        env.DB,
        FIXED_OWNER_LEARNER_ID,
        reflexAttempt(card, nextPresentation.choices, card.answerChoiceId, {
          eventId: `reflex-foundation-event-${round}`,
          deviceSeq: round,
          round,
        }),
      );
    }

    let waitingWriters = 0;
    let releaseWriters!: () => void;
    const writersReady = new Promise<void>((resolve) => {
      releaseWriters = resolve;
    });
    const beforeUnscheduledWrite = async (): Promise<void> => {
      waitingWriters += 1;
      if (waitingWriters === 2) releaseWriters();
      await writersReady;
    };
    const finalPresentation = presentReflexQuestion(card, "reflex-foundation-session", 4, 3);
    const finalAttempts = [4, 5].map((deviceSeq) =>
      reflexAttempt(card, finalPresentation.choices, card.answerChoiceId, {
        eventId: `reflex-concurrent-final-${deviceSeq}`,
        deviceSeq,
        round: 4,
      }),
    );
    const concurrent = await Promise.allSettled(
      finalAttempts.map((finalAttempt) =>
        ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, finalAttempt, { beforeUnscheduledWrite }),
      ),
    );
    expect(concurrent.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = concurrent.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toContain("session advanced");
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM attempts
         WHERE study_session_id = 'reflex-foundation-session'
           AND json_extract(metadata_json, '$.interaction') = 'reflex-multiple-choice'`,
      ).first<number>("count"),
    ).toBe(4);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM server_changes
         WHERE entity_id IN ('reflex-concurrent-final-4', 'reflex-concurrent-final-5')`,
      ).first<number>("count"),
    ).toBe(1);
    const committedFinalId = await env.DB.prepare(
      `SELECT event_id FROM attempts
       WHERE event_id IN ('reflex-concurrent-final-4', 'reflex-concurrent-final-5')`,
    ).first<string>("event_id");
    const committedFinal = finalAttempts.find(({ eventId }) => eventId === committedFinalId);
    if (!committedFinal) throw new Error("missing committed final Reflex attempt");
    expect((await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, committedFinal)).disposition).toBe(
      "duplicate",
    );
    expect(await schedulerSnapshot()).toEqual(before);

    await retireFixtureLexemes(lexemes);
  });
});

function reflexAttempt(
  card: ReflexCard,
  choices: ReflexCard["choices"],
  selectedChoiceId: string,
  overrides: {
    eventId?: string;
    deviceSeq?: number;
    round?: number;
  } = {},
): AttemptInput {
  const round = overrides.round ?? 1;
  return {
    eventId: overrides.eventId ?? "reflex-foundation-event",
    deviceId: "reflex-foundation-device",
    deviceSeq: overrides.deviceSeq ?? 1,
    occurredAt: "2026-08-31T01:00:00Z",
    cardId: card.cardId,
    studySessionId: "reflex-foundation-session",
    mode: "reflex",
    activityType: card.activityType,
    correct: selectedChoiceId === card.answerChoiceId,
    responseMs: 3_200,
    metadata: {
      interaction: REFLEX_INTERACTION,
      presentationId: `reflex-foundation-session:${round}:${card.cardId}`,
      round,
      prompt: card.prompt,
      promptHint: card.promptHint,
      answerChoiceId: card.answerChoiceId,
      selectedChoiceId,
      options: choices.map((choice, index) => ({ ...choice, position: index + 1 })),
    },
  };
}

function fixtureLexemes(): V1SourceLexeme[] {
  return [
    lexeme("钢琴", "gāng qín", "gang1 qin2", ["piano"]),
    lexeme("台灯", "tái dēng", "tai2 deng1", ["desk lamp"]),
    lexeme("窗帘", "chuāng lián", "chuang1 lian2", ["curtain"]),
    lexeme("牙刷", "yá shuā", "ya2 shua1", ["toothbrush"]),
    lexeme("雨伞", "yǔ sǎn", "yu3 san3", ["umbrella"]),
    {
      ...lexeme("重", "zhòng", "zhong4", ["heavy"]),
      forms: [
        lexeme("重", "zhòng", "zhong4", ["heavy"]).forms[0]!,
        lexeme("重", "chóng", "chong2", ["again"]).forms[0]!,
      ],
    },
  ];
}

function lexeme(
  simplified: string,
  pinyin: string,
  numeric: string,
  meanings: string[],
): V1SourceLexeme {
  return {
    simplified,
    hskLevel: 1,
    forms: [{ traditional: simplified, transcriptions: { pinyin, numeric }, meanings }],
  };
}

function pronunciationInput(lexemes: V1SourceLexeme[]): PronunciationImportInput {
  return {
    lexemes,
    vocabularyVersion: "reflex-fixture-vocabulary",
    audioVersion: "reflex-fixture-audio",
    audioItems: lexemes.map(({ simplified }) => ({ simplified, status: "missing" })),
  };
}

function vocabularyCardId(simplified: string): string {
  return `card:lexeme:complete-hsk:${encodeURIComponent(simplified)}:hanzi_to_meaning`;
}

async function schedulerSnapshot(): Promise<unknown> {
  const [reviews, states] = await Promise.all([
    env.DB.prepare(
      `SELECT attempt_id, card_id, rating, scheduler_config_id
       FROM fsrs_reviews WHERE attempt_id LIKE 'reflex-%' ORDER BY attempt_id`,
    ).all(),
    env.DB.prepare(
      `SELECT card_id, due_at, stability, difficulty, reps, lapses, state, version
       FROM card_state WHERE card_id LIKE 'card:lexeme:complete-hsk:%'
       ORDER BY card_id`,
    ).all(),
  ]);
  return { reviews: reviews.results, states: states.results };
}

async function applyStatements(statements: string[]): Promise<void> {
  await env.DB.batch(
    statements
      .filter((statement) => !statement.startsWith("PRAGMA"))
      .map((statement) => env.DB.prepare(statement)),
  );
}

async function retireFixtureLexemes(lexemes: V1SourceLexeme[]): Promise<void> {
  const ids = lexemes.map(
    ({ simplified }) => `lexeme:complete-hsk:${encodeURIComponent(simplified)}`,
  );
  await env.DB.prepare(
    `UPDATE cards SET retired_at = 1
     WHERE lexeme_id IN (${ids.map(() => "?").join(", ")})
        OR lexeme_reading_id IN (
          SELECT id FROM lexeme_readings WHERE lexeme_id IN (${ids.map(() => "?").join(", ")})
        )`,
  )
    .bind(...ids, ...ids)
    .run();
}
