import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, test } from "vitest";
import { FIXED_OWNER_LEARNER_ID } from "../../src/worker/current-learner";

import { ingestAttempt } from "../../src/db/ingestion";
import { getPracticeSessionSummary } from "../../src/db/practice-sessions";
import {
  createGrammarSession,
  createReadingSession,
  getOfflineGrammarPack,
  getOfflineReadingPack,
} from "../../src/db/reading-grammar";
import { pullSyncChanges } from "../../src/db/sync";
import {
  buildV1ImportStatements,
  type V1ImportInput,
  type V1SourceLexeme,
} from "../../src/db/v1-import";
import { BEGINNER_GRAMMAR_TOPICS } from "../../src/domain/reading-grammar";
import type { AttemptInput } from "../../src/domain/types";

describe("reading and grammar foundation", () => {
  beforeAll(async () => seedReadingGrammar());

  test("serves Chinese-first sentences with exact linked readings and the ordered grammar path", async () => {
    const deviceId = "reading-content-device";
    await createReadingSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "reading-content-session",
      deviceId,
      maxItems: 5,
    });
    const reading = await getOfflineReadingPack(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "reading-content-session",
      deviceId,
    );

    expect(reading.status).toBe("cards");
    expect(reading.cards).toHaveLength(5);
    expect(reading.cards[0]).toMatchObject({
      sentence: {
        chinese: "我是学生。",
        pinyin: "Wǒ shì xuéshēng.",
        meaningJa: "私は学生です。",
      },
      grammarTopics: [
        {
          id: "grammar:foundation:shi-noun-link",
          pattern: "A + 是 + B",
        },
      ],
    });
    expect(reading.cards[0]?.vocabulary).toEqual([
      expect.objectContaining({ simplified: "我", pinyin: "wǒ", numericPinyin: "wo3" }),
      expect.objectContaining({ simplified: "是", pinyin: "shì", numericPinyin: "shi4" }),
      expect.objectContaining({
        simplified: "学生",
        pinyin: "xué sheng",
        numericPinyin: "xue2 sheng5",
      }),
    ]);
    expect(
      reading.cards.every(
        (card) =>
          card.vocabulary.length > 0 &&
          card.vocabulary.every((hint) => hint.readingId.startsWith("reading:")),
      ),
    ).toBe(true);

    await createGrammarSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "grammar-content-session",
      deviceId,
      maxItems: 5,
    });
    const grammar = await getOfflineGrammarPack(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "grammar-content-session",
      deviceId,
    );
    expect(grammar.cards.map((card) => card.topic.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(grammar.cards[0]).toMatchObject({
      topicId: "grammar:foundation:shi-noun-link",
      topic: {
        practice: { prompt: "我___学生。", answerChoiceId: "shi" },
      },
      examples: [
        {
          chinese: "我是学生。",
          pinyin: "Wǒ shì xuéshēng.",
          meaningJa: "私は学生です。",
        },
      ],
    });
  });

  test("a partial import preserves an already-active curated sentence graph", async () => {
    const topic = BEGINNER_GRAMMAR_TOPICS[1];
    const sentenceId = `sentence:v1:${encodeURIComponent(topic.anchorSimplified)}`;
    const sentenceSql = `SELECT chinese, pinyin, meaning_ja, meaning_en, metadata_json,
        content_revision, retired_at
       FROM sentences WHERE id = ?`;
    const linksSql = `SELECT sl.lexeme_id, sl.lexeme_reading_id, sl.position, sl.role,
        sl.content_revision, lr.numeric_pinyin
       FROM sentence_lexemes sl
       JOIN lexeme_readings lr ON lr.id = sl.lexeme_reading_id
       WHERE sl.sentence_id = ?
       ORDER BY sl.position`;
    const beforeSentence = await env.DB.prepare(sentenceSql).bind(sentenceId).first();
    const beforeLinks = await env.DB.prepare(linksSql).bind(sentenceId).all();
    expect(beforeLinks.results).toHaveLength(topic.lexemes.length);

    const partial = readingGrammarInput(
      "reading-grammar-partial-vocabulary",
      "reading-grammar-partial-enrichment",
      [topicEnrichment(topic)],
    );
    partial.lexemes = partial.lexemes.filter(
      ({ simplified }) => simplified === topic.anchorSimplified,
    );
    await applyReadingGrammarImport(partial);

    expect(await env.DB.prepare(sentenceSql).bind(sentenceId).first()).toEqual(beforeSentence);
    expect((await env.DB.prepare(linksSql).bind(sentenceId).all()).results).toEqual(
      beforeLinks.results,
    );
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM cards
         WHERE id IN (?, ?) AND retired_at IS NULL`,
      )
        .bind(`card:${sentenceId}:sentence_reading`, `card:${topic.id}:sentence_reading`)
        .first<{ count: number }>(),
    ).toEqual({ count: 2 });
  });

  test("persists immutable Reading and Grammar attempts without touching FSRS or vocabulary state", async () => {
    const deviceId = "guided-history-device";
    const readingSessionId = "guided-history-reading";
    const grammarSessionId = "guided-history-grammar";
    await createReadingSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: readingSessionId,
      deviceId,
      maxItems: 1,
    });
    await createGrammarSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: grammarSessionId,
      deviceId,
      maxItems: 1,
    });
    const reading = await getOfflineReadingPack(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      readingSessionId,
      deviceId,
    );
    const grammar = await getOfflineGrammarPack(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      grammarSessionId,
      deviceId,
    );
    const readingCard = required(reading.cards[0]);
    const grammarCard = required(grammar.cards[0]);
    const example = required(grammarCard.examples[0]);
    const before = await counts();

    const readingAttempt: AttemptInput = {
      eventId: "guided-history-reading-event",
      deviceId,
      deviceSeq: 1,
      occurredAt: "2026-08-30T01:00:00Z",
      cardId: readingCard.cardId,
      studySessionId: readingSessionId,
      mode: "reading",
      activityType: "sentence_reading",
      responseMs: 8_000,
      metadata: {
        interaction: "staged-sentence-reading",
        sentenceId: readingCard.sentenceId,
        revealOrder: ["vocabulary", "pinyin", "meaning", "grammar"],
      },
    };
    const grammarAttempt: AttemptInput = {
      eventId: "guided-history-grammar-event",
      deviceId,
      deviceSeq: 2,
      occurredAt: "2026-08-30T01:02:00Z",
      cardId: grammarCard.cardId,
      studySessionId: grammarSessionId,
      mode: "grammar",
      activityType: "sentence_reading",
      correct: true,
      responseMs: 6_000,
      metadata: {
        interaction: "grammar-choice",
        topicId: grammarCard.topicId,
        practiceVersionId: grammarCard.practiceVersionId,
        sentenceId: example.sentenceId,
        selectedChoiceId: grammarCard.topic.practice.answerChoiceId,
      },
    };

    expect(await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, readingAttempt)).toMatchObject({
      reviewCreated: false,
    });
    expect(await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, grammarAttempt)).toMatchObject({
      reviewCreated: false,
    });
    expect(await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, grammarAttempt)).toMatchObject({
      disposition: "duplicate",
    });

    const after = await counts();
    expect(after.attempts - before.attempts).toBe(2);
    expect(after.fsrsReviews).toBe(before.fsrsReviews);
    expect(after.cardStates).toBe(before.cardStates);
    expect(
      await env.DB.prepare(
        `SELECT status, introduced_at, last_studied_at, self_confidence, version
         FROM grammar_topic_state WHERE grammar_topic_id = ?`,
      )
        .bind(grammarCard.topicId)
        .first(),
    ).toEqual({
      status: "introduced",
      introduced_at: Date.parse("2026-08-30T01:02:00Z"),
      last_studied_at: Date.parse("2026-08-30T01:02:00Z"),
      self_confidence: null,
      version: 1,
    });

    const pulled = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
      cursor: 0,
      contentRevision: null,
      deviceId,
      readingSessionId,
      grammarSessionId,
    });
    expect(pulled.learnerChanges).toContainEqual(
      expect.objectContaining({
        entityType: "grammar_topic_state",
        state: expect.objectContaining({
          grammarTopicId: grammarCard.topicId,
          status: "introduced",
          selfConfidence: null,
        }),
      }),
    );
    expect(pulled.readingPack?.session.completedItems).toBe(1);
    expect(pulled.grammarPack?.session.completedItems).toBe(1);
    await expect(
      getPracticeSessionSummary(env.DB, FIXED_OWNER_LEARNER_ID, readingSessionId),
    ).resolves.toMatchObject({
      practice: "reading",
      completedItems: 1,
      configuration: { requestedItems: 1 },
      evidence: { comprehension: null },
    });
    await expect(
      getPracticeSessionSummary(env.DB, FIXED_OWNER_LEARNER_ID, grammarSessionId),
    ).resolves.toMatchObject({
      practice: "grammar",
      completedItems: 1,
      configuration: {
        focusTopicId: null,
        requestedItems: 1,
      },
      evidence: {
        correctness: { correct: 1, responses: 1 },
        confidence: null,
      },
    });
  });

  test("keeps a historical Reading comprehension rating readable", async () => {
    const deviceId = "reading-historical-device";
    const sessionId = "reading-historical-session";
    await createReadingSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId,
      deviceId,
      maxItems: 1,
    });
    const card = required(
      (await getOfflineReadingPack(env.DB, FIXED_OWNER_LEARNER_ID, sessionId, deviceId)).cards[0],
    );
    await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
      eventId: "reading-historical-event",
      deviceId,
      deviceSeq: 1,
      occurredAt: "2026-08-30T01:30:00Z",
      cardId: card.cardId,
      studySessionId: sessionId,
      mode: "reading",
      activityType: "sentence_reading",
      selfRating: 2,
      metadata: {
        interaction: "staged-sentence-reading",
        sentenceId: card.sentenceId,
        revealOrder: ["vocabulary", "pinyin", "meaning", "grammar"],
      },
    });
    await getOfflineReadingPack(env.DB, FIXED_OWNER_LEARNER_ID, sessionId, deviceId);

    await expect(
      getPracticeSessionSummary(env.DB, FIXED_OWNER_LEARNER_ID, sessionId),
    ).resolves.toMatchObject({
      practice: "reading",
      evidence: { comprehension: { responses: 1, distribution: { 2: 1 } } },
    });
  });

  test("keeps topic confidence on the canonically latest practice when an older event arrives late", async () => {
    const deviceId = "grammar-late-device";
    const topicId = "grammar:foundation:you-possession";
    const firstSession = "grammar-late-newer-session";
    const lateSession = "grammar-late-older-session";
    await createGrammarSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: firstSession,
      deviceId,
      maxItems: 1,
      topicId,
    });
    await createGrammarSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: lateSession,
      deviceId,
      maxItems: 1,
      topicId,
    });
    const card = required(
      (await getOfflineGrammarPack(env.DB, FIXED_OWNER_LEARNER_ID, firstSession, deviceId))
        .cards[0],
    );
    const example = required(card.examples[0]);
    const base = {
      deviceId,
      cardId: card.cardId,
      mode: "grammar" as const,
      activityType: "sentence_reading" as const,
      correct: true,
      metadata: {
        interaction: "grammar-choice",
        topicId,
        practiceVersionId: card.practiceVersionId,
        sentenceId: example.sentenceId,
        selectedChoiceId: card.topic.practice.answerChoiceId,
      },
    };
    await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
      ...base,
      eventId: "grammar-late-newer",
      deviceSeq: 2,
      occurredAt: "2026-08-30T03:00:00Z",
      studySessionId: firstSession,
      selfRating: 4,
    });
    await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
      ...base,
      eventId: "grammar-late-older",
      deviceSeq: 1,
      occurredAt: "2026-08-30T02:00:00Z",
      studySessionId: lateSession,
      selfRating: 1,
    });

    expect(
      await env.DB.prepare(
        `SELECT status, introduced_at, last_studied_at, self_confidence, version
         FROM grammar_topic_state WHERE grammar_topic_id = ?`,
      )
        .bind(topicId)
        .first(),
    ).toEqual({
      status: "comfortable",
      introduced_at: Date.parse("2026-08-30T02:00:00Z"),
      last_studied_at: Date.parse("2026-08-30T03:00:00Z"),
      self_confidence: 1,
      version: 2,
    });
  });

  test("rejects forged grammar correctness and cross-mode session reuse", async () => {
    const deviceId = "grammar-validation-device";
    const sessionId = "grammar-validation-session";
    await createGrammarSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId,
      deviceId,
      maxItems: 1,
    });
    const card = required(
      (await getOfflineGrammarPack(env.DB, FIXED_OWNER_LEARNER_ID, sessionId, deviceId)).cards[0],
    );
    const example = required(card.examples[0]);
    const forged: AttemptInput = {
      eventId: "grammar-validation-forged",
      deviceId,
      deviceSeq: 1,
      occurredAt: "2026-08-30T05:00:00Z",
      cardId: card.cardId,
      studySessionId: sessionId,
      mode: "grammar",
      activityType: "sentence_reading",
      correct: false,
      selfRating: 2,
      metadata: {
        interaction: "grammar-choice",
        topicId: card.topicId,
        practiceVersionId: card.practiceVersionId,
        sentenceId: example.sentenceId,
        selectedChoiceId: card.topic.practice.answerChoiceId,
      },
    };
    await expect(ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, forged)).rejects.toThrow(
      "grammar correctness disagrees",
    );
    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        ...forged,
        eventId: "grammar-validation-cross-mode",
        mode: "reading",
      }),
    ).rejects.toThrow("belongs to another learning mode");
  });

  test("retires unusable guided cards when a complete revision drops their example", async () => {
    const topic = BEGINNER_GRAMMAR_TOPICS[4];
    const cardId = `card:${topic.id}:sentence_reading`;
    const sentenceCardId = `card:sentence:v1:${encodeURIComponent(topic.anchorSimplified)}:sentence_reading`;
    const beforeVersion = await env.DB.prepare(
      `SELECT id FROM grammar_practice_versions
       WHERE grammar_topic_id = ?
       ORDER BY content_revision DESC LIMIT 1`,
    )
      .bind(topic.id)
      .first<{ id: string }>();
    if (!beforeVersion) throw new Error("missing initial grammar practice version");

    const omitted = readingGrammarInput(
      "reading-grammar-lifecycle-vocabulary",
      "reading-grammar-lifecycle-omitted",
      BEGINNER_GRAMMAR_TOPICS.filter(({ id }) => id !== topic.id).map(topicEnrichment),
    );
    await applyReadingGrammarImport(omitted);

    expect(
      await env.DB.prepare("SELECT retired_at FROM cards WHERE id = ?")
        .bind(cardId)
        .first<{ retired_at: number | null }>(),
    ).toEqual({ retired_at: omitted.createdAt });
    expect(
      await env.DB.prepare("SELECT retired_at FROM cards WHERE id = ?")
        .bind(sentenceCardId)
        .first<{ retired_at: number | null }>(),
    ).toEqual({ retired_at: omitted.createdAt });
    expect(
      await env.DB.prepare("SELECT id FROM grammar_practice_versions WHERE id = ?")
        .bind(beforeVersion.id)
        .first(),
    ).not.toBeNull();

    const deviceId = "grammar-retirement-device";
    const emptySession = "grammar-retirement-empty-session";
    await createGrammarSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: emptySession,
      deviceId,
      maxItems: 1,
      topicId: topic.id,
    });
    expect(
      await getOfflineGrammarPack(env.DB, FIXED_OWNER_LEARNER_ID, emptySession, deviceId),
    ).toMatchObject({
      status: "empty",
      cards: [],
    });

    const restored = readingGrammarInput(
      "reading-grammar-lifecycle-vocabulary",
      "reading-grammar-lifecycle-restored",
    );
    await applyReadingGrammarImport(restored);
    expect(
      await env.DB.prepare("SELECT retired_at FROM cards WHERE id = ?")
        .bind(cardId)
        .first<{ retired_at: number | null }>(),
    ).toEqual({ retired_at: null });
    const restoredSession = "grammar-retirement-restored-session";
    await createGrammarSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: restoredSession,
      deviceId,
      maxItems: 1,
      topicId: topic.id,
    });
    const restoredCard = required(
      (await getOfflineGrammarPack(env.DB, FIXED_OWNER_LEARNER_ID, restoredSession, deviceId))
        .cards[0],
    );
    expect(restoredCard.practiceVersionId).not.toBe(beforeVersion.id);
  });

  test("accepts a delayed grammar attempt against its immutable cached practice version", async () => {
    const topic = BEGINNER_GRAMMAR_TOPICS[0];
    const deviceId = "grammar-version-device";
    const cachedSessionId = "grammar-version-cached-session";
    await createGrammarSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: cachedSessionId,
      deviceId,
      maxItems: 1,
      topicId: topic.id,
    });
    const cachedCard = required(
      (await getOfflineGrammarPack(env.DB, FIXED_OWNER_LEARNER_ID, cachedSessionId, deviceId))
        .cards[0],
    );
    const current = await env.DB.prepare(
      `SELECT teaching_metadata_json, content_revision
       FROM grammar_topics WHERE id = ?`,
    )
      .bind(topic.id)
      .first<{ teaching_metadata_json: string; content_revision: number }>();
    if (!current) throw new Error("missing grammar topic fixture");

    const changedPractice = { ...topic.teaching.practice, answerChoiceId: "you" };
    const changedTeaching = { ...topic.teaching, practice: changedPractice };
    const revisionResult = await env.DB.prepare(
      `INSERT INTO content_revisions (source, source_version, description, created_at)
       VALUES ('integration-test', 'grammar-practice-version-change', 'test fixture', ?)`,
    )
      .bind(timestamp("06:00"))
      .run();
    const changedRevision = Number(revisionResult.meta.last_row_id);
    const changedVersionId = "grammar-practice:test:changed-answer";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO grammar_practice_versions
          (id, grammar_topic_id, sentence_id, practice_json, content_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        changedVersionId,
        topic.id,
        cachedCard.practiceSentenceId,
        JSON.stringify(changedPractice),
        changedRevision,
        timestamp("06:00"),
      ),
      env.DB.prepare(
        `UPDATE grammar_topics
         SET teaching_metadata_json = ?, content_revision = ?
         WHERE id = ?`,
      ).bind(JSON.stringify(changedTeaching), changedRevision, topic.id),
    ]);

    const changedSessionId = "grammar-version-changed-session";
    await createGrammarSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: changedSessionId,
      deviceId,
      maxItems: 1,
      topicId: topic.id,
    });
    const changedCard = required(
      (await getOfflineGrammarPack(env.DB, FIXED_OWNER_LEARNER_ID, changedSessionId, deviceId))
        .cards[0],
    );
    expect(changedCard).toMatchObject({
      practiceVersionId: changedVersionId,
      topic: { practice: { answerChoiceId: "you" } },
    });

    try {
      expect(
        await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
          eventId: "grammar-version-delayed-event",
          deviceId,
          deviceSeq: 1,
          occurredAt: "2026-08-30T05:30:00Z",
          cardId: cachedCard.cardId,
          studySessionId: cachedSessionId,
          mode: "grammar",
          activityType: "sentence_reading",
          correct: true,
          selfRating: 3,
          metadata: {
            interaction: "grammar-choice",
            topicId: topic.id,
            practiceVersionId: cachedCard.practiceVersionId,
            sentenceId: cachedCard.practiceSentenceId,
            selectedChoiceId: topic.teaching.practice.answerChoiceId,
          },
        }),
      ).toMatchObject({ disposition: "inserted", reviewCreated: false });
    } finally {
      await env.DB.prepare(
        `UPDATE grammar_topics
         SET teaching_metadata_json = ?, content_revision = ?
         WHERE id = ?`,
      )
        .bind(current.teaching_metadata_json, current.content_revision, topic.id)
        .run();
    }
  });
});

async function seedReadingGrammar(): Promise<void> {
  await applyReadingGrammarImport(
    readingGrammarInput(
      "reading-grammar-integration-vocabulary",
      "reading-grammar-integration-enrichment",
    ),
  );
}

function readingGrammarInput(
  vocabularyVersion: string,
  v1Version: string,
  enrichments: V1ImportInput["enrichments"] = BEGINNER_GRAMMAR_TOPICS.map(topicEnrichment),
): V1ImportInput {
  return {
    vocabularyVersion,
    v1Version,
    createdAt: Date.parse("2026-08-30T00:00:00Z"),
    lexemes: [
      sourceLexeme("我", "wǒ", "wo3", "I; me; my"),
      sourceLexeme("是", "shì", "shi4", "to be (followed by substantives only)"),
      sourceLexeme("学生", "xué sheng", "xue2 sheng5", "student"),
      sourceLexeme("有", "yǒu", "you3", "to have; there is"),
      sourceLexeme("两", "liǎng", "liang3", "two"),
      sourceLexeme("个", "gè", "ge4", "classifier used before a noun"),
      sourceLexeme("姐姐", "jiě jie", "jie3 jie5", "older sister"),
      sourceLexeme("在", "zài", "zai4", "to be located at"),
      sourceLexeme("家", "jiā", "jia1", "home"),
      sourceLexeme("不", "bù", "bu4", "not"),
      sourceLexeme("喝", "hē", "he1", "to drink"),
      sourceLexeme("咖啡", "kā fēi", "ka1 fei1", "coffee"),
      sourceLexeme("你", "nǐ", "ni3", "you"),
      sourceLexeme("好", "hǎo", "hao3", "good"),
      sourceLexeme("吗", "ma", "ma5", "question particle for yes-no questions"),
    ],
    enrichments,
  };
}

function topicEnrichment(topic: (typeof BEGINNER_GRAMMAR_TOPICS)[number]) {
  return {
    simplified: topic.anchorSimplified,
    meaning_ja: topic.teaching.summaryJa,
    example_zh: topic.expectedSentence.chinese,
    example_pinyin: topic.expectedSentence.pinyin,
    example_ja: topic.expectedSentence.meaningJa,
    example_en: topic.expectedSentence.meaningEn,
  };
}

async function applyReadingGrammarImport(input: V1ImportInput): Promise<void> {
  const statements = await buildV1ImportStatements(input);
  for (let index = 0; index < statements.length; index += 60) {
    await env.DB.batch(
      statements.slice(index, index + 60).map((statement) => env.DB.prepare(statement)),
    );
  }
}

function sourceLexeme(
  simplified: string,
  pinyin: string,
  numeric: string,
  meaning: string,
): V1SourceLexeme {
  return {
    simplified,
    hskLevel: 1,
    forms: [
      {
        traditional: simplified,
        transcriptions: { pinyin, numeric },
        meanings: [meaning],
      },
    ],
  };
}

async function counts(): Promise<{
  attempts: number;
  fsrsReviews: number;
  cardStates: number;
}> {
  const row = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM attempts) AS attempts,
      (SELECT COUNT(*) FROM fsrs_reviews) AS fsrs_reviews,
      (SELECT COUNT(*) FROM card_state) AS card_states`,
  ).first<{ attempts: number; fsrs_reviews: number; card_states: number }>();
  if (!row) throw new Error("missing count row");
  return { attempts: row.attempts, fsrsReviews: row.fsrs_reviews, cardStates: row.card_states };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing test fixture value");
  return value;
}

function timestamp(time: string): number {
  return Date.parse(`2026-08-30T${time}:00Z`);
}
