import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { FIXED_OWNER_LEARNER_ID } from "../../src/worker/current-learner";

import { ingestAttempt } from "../../src/db/ingestion";
import {
  buildPronunciationImportStatements,
  type PronunciationImportInput,
} from "../../src/db/pronunciation-import";
import { createReflexSession } from "../../src/db/reflex";
import {
  getPracticeSessionSummary,
  getRecentPracticeSessions,
} from "../../src/db/practice-sessions";
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
        occurredAt: `2026-08-30T${String(index).padStart(2, "0")}:00:00Z`,
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

    const nineChoice = await createReflexSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "quiz-nine-session",
      deviceId: "quiz-nine-device",
      maxItems: 4,
      activityType: "hanzi_to_meaning",
      choiceCount: 9,
    });
    expect(nineChoice.session).toMatchObject({
      activityType: "hanzi_to_meaning",
      choiceCount: 9,
      selectionStrategy: "weak_and_slow_v1",
    });
    const ninePull = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
      cursor: 0,
      contentRevision: null,
      deviceId: "quiz-nine-device",
      reflexSessionId: "quiz-nine-session",
    });
    const nineCards = ninePull.reflexPack?.cards ?? [];
    expect(nineCards).toHaveLength(4);
    expect(nineCards.every(({ activityType }) => activityType === "hanzi_to_meaning")).toBe(true);
    expect(nineCards.every(({ choices }) => choices.length === 9)).toBe(true);
    expect(
      nineCards.every(
        ({ choices }) => new Set(choices.map(({ label }) => label.trim())).size === choices.length,
      ),
    ).toBe(true);
    expect(
      (
        await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
          cursor: 0,
          contentRevision: null,
          deviceId: "quiz-nine-device",
          reflexSessionId: "quiz-nine-session",
        })
      ).reflexPack?.cards,
    ).toEqual(nineCards);
    await expect(
      createReflexSession(env.DB, FIXED_OWNER_LEARNER_ID, {
        sessionId: "quiz-nine-session",
        deviceId: "quiz-nine-device",
        maxItems: 4,
        activityType: "hanzi_to_meaning",
        choiceCount: 4,
      }),
    ).rejects.toThrow("different settings");

    const nineTarget = nineCards[0];
    if (!nineTarget) throw new Error("missing nine-choice target");
    for (let round = 1; round <= 4; round += 1) {
      const presented = presentReflexQuestion(nineTarget, "quiz-nine-session", round, round - 1);
      await ingestAttempt(
        env.DB,
        FIXED_OWNER_LEARNER_ID,
        reflexAttempt(nineTarget, presented.choices, nineTarget.answerChoiceId, {
          eventId: `quiz-nine-event:${round}`,
          deviceId: "quiz-nine-device",
          deviceSeq: round,
          round,
          sessionId: "quiz-nine-session",
          timingInterrupted: round === 1,
        }),
      );
    }
    await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
      cursor: ninePull.nextCursor,
      contentRevision: ninePull.currentContentRevision,
      deviceId: "quiz-nine-device",
      reflexSessionId: "quiz-nine-session",
    });
    const nineSummary = await getPracticeSessionSummary(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "quiz-nine-session",
    );
    expect(nineSummary).toMatchObject({
      practice: "vocabulary_quiz",
      completedItems: 4,
      configuration: { activityType: "hanzi_to_meaning", choiceCount: 9 },
      evidence: {
        correctness: { correct: 4, responses: 4, rate: 1 },
        timedResponses: 3,
        timingInterrupted: 1,
        averageResponseMs: 3_200,
      },
    });
    expect(
      await env.DB.prepare(
        "SELECT response_ms FROM attempts WHERE event_id = 'quiz-nine-event:1'",
      ).first<number | null>("response_ms"),
    ).toBeNull();

    await createReflexSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "quiz-nine-session-2",
      deviceId: "quiz-nine-device-2",
      maxItems: 4,
      activityType: "hanzi_to_meaning",
      choiceCount: 9,
    });
    const comparablePull = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
      cursor: 0,
      contentRevision: null,
      deviceId: "quiz-nine-device-2",
      reflexSessionId: "quiz-nine-session-2",
    });
    const comparableTarget = comparablePull.reflexPack?.cards[0];
    if (!comparableTarget) throw new Error("missing comparable nine-choice target");
    for (let round = 1; round <= 4; round += 1) {
      const presented = presentReflexQuestion(
        comparableTarget,
        "quiz-nine-session-2",
        round,
        round - 1,
      );
      const wrong = presented.choices.find(({ id }) => id !== comparableTarget.answerChoiceId);
      await ingestAttempt(
        env.DB,
        FIXED_OWNER_LEARNER_ID,
        reflexAttempt(
          comparableTarget,
          presented.choices,
          round === 1 && wrong ? wrong.id : comparableTarget.answerChoiceId,
          {
            eventId: `quiz-nine-2-event:${round}`,
            deviceId: "quiz-nine-device-2",
            deviceSeq: round,
            round,
            sessionId: "quiz-nine-session-2",
          },
        ),
      );
    }
    await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
      cursor: comparablePull.nextCursor,
      contentRevision: comparablePull.currentContentRevision,
      deviceId: "quiz-nine-device-2",
      reflexSessionId: "quiz-nine-session-2",
    });
    const recentHistory = await getRecentPracticeSessions(env.DB, FIXED_OWNER_LEARNER_ID, {
      now: () => Date.parse("2026-08-31T04:00:00Z"),
    });
    const comparableSummary = recentHistory.sessions.find(
      ({ sessionId }) => sessionId === "quiz-nine-session-2",
    );
    expect(comparableSummary?.trend).toMatchObject({
      values: [100, 75],
      comparableSessionIds: ["quiz-nine-session", "quiz-nine-session-2"],
    });

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
  }, 20_000);
});

function reflexAttempt(
  card: ReflexCard,
  choices: ReflexCard["choices"],
  selectedChoiceId: string,
  overrides: {
    eventId?: string;
    deviceId?: string;
    deviceSeq?: number;
    round?: number;
    sessionId?: string;
    timingInterrupted?: boolean;
  } = {},
): AttemptInput {
  const round = overrides.round ?? 1;
  return {
    eventId: overrides.eventId ?? "reflex-foundation-event",
    deviceId: overrides.deviceId ?? "reflex-foundation-device",
    deviceSeq: overrides.deviceSeq ?? 1,
    occurredAt: "2026-08-31T01:00:00Z",
    cardId: card.cardId,
    studySessionId: overrides.sessionId ?? "reflex-foundation-session",
    mode: "reflex",
    activityType: card.activityType,
    correct: selectedChoiceId === card.answerChoiceId,
    ...(overrides.timingInterrupted ? {} : { responseMs: 3_200 }),
    metadata: {
      interaction: REFLEX_INTERACTION,
      presentationId: `${overrides.sessionId ?? "reflex-foundation-session"}:${round}:${card.cardId}`,
      round,
      prompt: card.prompt,
      promptHint: card.promptHint,
      answerChoiceId: card.answerChoiceId,
      selectedChoiceId,
      choiceCount: choices.length,
      timingInterrupted: overrides.timingInterrupted ?? false,
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
    lexeme("杯子", "bēi zi", "bei1 zi5", ["cup"]),
    lexeme("电脑", "diàn nǎo", "dian4 nao3", ["computer"]),
    lexeme("钥匙", "yào shi", "yao4 shi5", ["key"]),
    lexeme("书包", "shū bāo", "shu1 bao1", ["schoolbag"]),
    lexeme("手表", "shǒu biǎo", "shou3 biao3", ["watch"]),
    lexeme("椅子", "yǐ zi", "yi3 zi5", ["chair"]),
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
