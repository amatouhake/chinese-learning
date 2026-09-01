import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { FIXED_OWNER_LEARNER_ID } from "../../src/worker/current-learner";

import { ingestAttempt } from "../../src/db/ingestion";
import { registerLearnerDevice } from "../../src/db/learners";
import { getProgressSnapshot } from "../../src/db/progress";
import {
  buildV1ImportStatements,
  type V1ImportInput,
  type V1SourceLexeme,
} from "../../src/db/v1-import";
import { DEFAULT_SCHEDULER_CONFIG_ID } from "../../src/domain/fsrs";
import { BEGINNER_GRAMMAR_TOPICS } from "../../src/domain/reading-grammar";
import type { ActivityType, AttemptInput, PracticeMode } from "../../src/domain/types";

const NOW = Date.parse("2026-08-31T12:00:00Z");

describe("canonical progress snapshot", () => {
  test("returns an explicit empty state for a new user", async () => {
    const snapshot = await getProgressSnapshot(env.DB, FIXED_OWNER_LEARNER_ID, { now: () => NOW });

    expect(snapshot).toMatchObject({
      snapshotVersion: 1,
      generatedAt: NOW,
      timezone: "Asia/Tokyo",
      dataThrough: {
        serverSeq: null,
        changedAt: null,
        latestAttemptReceivedAt: null,
        latestAttemptOccurredAt: null,
      },
      overall: {
        last7Days: { attempts: 0, answeredAttempts: 0, activeDays: 0, sessions: 0 },
        last30Days: { attempts: 0, answeredAttempts: 0, activeDays: 0, sessions: 0 },
      },
      vocabulary: { totalScheduledCards: 0, dueNow: 0, new: 0 },
      reading: { recentResponses: 0, recentSentences: 0 },
      reflex: { recentResponses: 0 },
      troublesomeItems: [],
    });
    expect(snapshot.pronunciation.byActivity).toHaveLength(7);
    expect(snapshot.pronunciation.byActivity.every(({ responses }) => responses === 0)).toBe(true);
  });

  test("reports due/new FSRS state and keeps mixed ratings distinct", async () => {
    await applyImport(
      vocabularyInput("progress-vocabulary", [
        sourceLexeme("爱", "ài", "ai4", "to love"),
        sourceLexeme("好", "hǎo", "hao3", "good"),
      ]),
    );
    const cards = await env.DB.prepare(
      `SELECT id, activity_type FROM cards
       WHERE subject_type = 'lexeme' AND scheduler_eligible = 1
       ORDER BY id`,
    ).all<{ id: string; activity_type: "hanzi_to_meaning" | "meaning_to_hanzi" }>();
    expect(cards.results).toHaveLength(4);

    for (const [index, card] of cards.results.entries()) {
      await ingestAttempt(
        env.DB,
        FIXED_OWNER_LEARNER_ID,
        scheduledAttempt({
          eventId: `mixed-rating-${index + 1}`,
          cardId: card.id,
          activityType: card.activity_type,
          deviceId: `mixed-rating-device-${index + 1}`,
          occurredAt: NOW - 2 * 24 * 60 * 60 * 1_000 + index * 60_000,
          rating: (index + 1) as 1 | 2 | 3 | 4,
        }),
        { now: () => NOW - 60_000 + index },
      );
    }

    const snapshot = await getProgressSnapshot(env.DB, FIXED_OWNER_LEARNER_ID, { now: () => NOW });
    expect(snapshot.vocabulary).toMatchObject({
      totalScheduledCards: 4,
      new: 0,
      recentScheduledReviews: 4,
      recentRatings: { 1: 1, 2: 1, 3: 1, 4: 1 },
    });
    expect(snapshot.vocabulary.dueNow).toBeGreaterThan(0);
    expect(snapshot.vocabulary.learning + snapshot.vocabulary.review).toBe(4);
    expect(snapshot.overall.last7Days.scheduledReviews).toBe(4);
    expect(snapshot.troublesomeItems.some(({ mode }) => mode === "study")).toBe(true);
  });

  test("keeps activity semantics separate and surfaces explainable cross-mode trouble", async () => {
    await applyImport(readingGrammarInput());
    const fixture = await prepareMixedModeFixture();

    await insertCanonicalAttempt({
      eventId: "pronunciation-objective-correct",
      deviceSeq: 1,
      occurredAt: Date.parse("2026-08-30T14:30:00Z"),
      receivedAt: Date.parse("2026-08-30T14:31:00Z"),
      cardId: fixture.objectiveCardId,
      studySessionId: "progress-pronunciation-session",
      mode: "pronunciation",
      activityType: "tone_identification",
      correct: true,
      responseMs: 900,
      metadata: { interaction: "choice" },
    });
    await insertCanonicalAttempt({
      eventId: "pronunciation-objective-error",
      deviceSeq: 2,
      occurredAt: Date.parse("2026-08-30T15:30:00Z"),
      receivedAt: Date.parse("2026-08-30T15:31:00Z"),
      cardId: fixture.objectiveCardId,
      studySessionId: "progress-pronunciation-session",
      mode: "pronunciation",
      activityType: "tone_identification",
      correct: false,
      responseMs: 1_100,
      metadata: { interaction: "choice" },
    });
    for (const [index, selfRating] of [2, 4].entries()) {
      await insertCanonicalAttempt({
        eventId: `pronunciation-production-${index + 1}`,
        deviceSeq: index + 3,
        occurredAt: NOW - (5 - index) * 60 * 60 * 1_000,
        receivedAt: NOW - (4 - index) * 60 * 60 * 1_000,
        cardId: fixture.productionCardId,
        studySessionId: "progress-pronunciation-session",
        mode: "pronunciation",
        activityType: "pronunciation_production",
        selfRating,
        responseMs: 1_300,
        metadata: { interaction: "speak-compare-self-rate" },
      });
    }
    await insertCanonicalAttempt({
      eventId: "pronunciation-audio-skip",
      deviceSeq: 5,
      occurredAt: NOW - 2 * 60 * 60 * 1_000,
      receivedAt: NOW - 60 * 60 * 1_000,
      cardId: fixture.audioCardId,
      studySessionId: "progress-pronunciation-session",
      mode: "pronunciation",
      activityType: "audio_to_hanzi",
      metadata: { interaction: "skip-uncached-audio" },
    });

    for (const [index, selfRating] of [1, 2].entries()) {
      await insertCanonicalAttempt({
        eventId: `reading-low-${index + 1}`,
        deviceSeq: index + 1,
        occurredAt: NOW - (30 - index) * 60 * 60 * 1_000,
        receivedAt: NOW - (29 - index) * 60 * 60 * 1_000,
        cardId: fixture.readingCardId,
        studySessionId: "progress-reading-session",
        mode: "reading",
        activityType: "sentence_reading",
        selfRating,
        responseMs: 7_000,
        metadata: { interaction: "staged-sentence-reading" },
      });
    }
    for (const [index, values] of [
      { correct: false, selfRating: 2 },
      { correct: true, selfRating: 3 },
    ].entries()) {
      await insertCanonicalAttempt({
        eventId: `grammar-practice-${index + 1}`,
        deviceSeq: index + 1,
        occurredAt: NOW - (20 - index) * 60 * 60 * 1_000,
        receivedAt: NOW - (19 - index) * 60 * 60 * 1_000,
        cardId: fixture.grammarCardId,
        studySessionId: "progress-grammar-session",
        mode: "grammar",
        activityType: "sentence_reading",
        correct: values.correct,
        selfRating: values.selfRating,
        responseMs: 4_000,
        metadata: { interaction: "grammar-choice" },
      });
    }
    for (const [index, values] of [
      { correct: false, responseMs: 3_200 },
      { correct: true, responseMs: 1_800 },
    ].entries()) {
      await insertCanonicalAttempt({
        eventId: `reflex-response-${index + 1}`,
        deviceSeq: index + 1,
        occurredAt: NOW - (10 - index) * 60 * 60 * 1_000,
        receivedAt: NOW - (9 - index) * 60 * 60 * 1_000,
        cardId: fixture.reflexCardId,
        studySessionId: "progress-reflex-session",
        mode: "reflex",
        activityType: fixture.reflexActivity,
        correct: values.correct,
        responseMs: values.responseMs,
        metadata: { interaction: "reflex-multiple-choice", round: index + 1 },
      });
    }

    const stateBefore = await canonicalLearningState();
    const snapshot = await getProgressSnapshot(env.DB, FIXED_OWNER_LEARNER_ID, { now: () => NOW });
    const stateAfter = await canonicalLearningState();

    const objective = snapshot.pronunciation.byActivity.find(
      ({ activityType }) => activityType === "tone_identification",
    );
    const production = snapshot.pronunciation.byActivity.find(
      ({ activityType }) => activityType === "pronunciation_production",
    );
    const audio = snapshot.pronunciation.byActivity.find(
      ({ activityType }) => activityType === "audio_to_hanzi",
    );
    expect(objective).toMatchObject({
      responses: 2,
      correctness: { responses: 2, correct: 1, rate: 0.5 },
      selfRatings: null,
    });
    expect(production).toMatchObject({
      responses: 2,
      correctness: null,
      selfRatings: { responses: 2, average: 3, low: 1 },
    });
    expect(audio).toMatchObject({
      responses: 0,
      skips: 1,
      distinctItems: 0,
      correctness: null,
      averageResponseMs: null,
    });
    expect(snapshot.pronunciation).toMatchObject({ recentResponses: 4, recentSkips: 1 });

    expect(snapshot.reading).toMatchObject({
      recentResponses: 2,
      recentSentences: 1,
      comprehension: { responses: 2, average: 1.5, low: 2 },
    });
    expect(snapshot.reading.difficultSentences[0]?.reasons.join(" ")).toContain(
      "low comprehension",
    );
    expect(snapshot.grammar).toMatchObject({
      recentResponses: 2,
      correctness: { responses: 2, correct: 1, rate: 0.5 },
      confidence: { responses: 2, average: 2.5, low: 1 },
      topicCounts: { learning: 1 },
    });
    expect(snapshot.reflex).toMatchObject({
      recentResponses: 2,
      correctness: { responses: 2, correct: 1, rate: 0.5 },
      latency: { averageResponseMs: 2_500, slowResponses: 1, slowThresholdMs: 2_500 },
    });
    expect(new Set(snapshot.troublesomeItems.map(({ mode }) => mode))).toEqual(
      new Set(["study", "pronunciation", "reading", "grammar", "reflex"]),
    );
    expect(snapshot.overall.last7Days.activeDays).toBeGreaterThanOrEqual(2);
    expect(snapshot.overall.last30Days.sessions).toBe(4);
    expect(stateAfter).toEqual(stateBefore);
  });

  test("uses occurrence time for activity and receipt order for freshness, including delayed events", async () => {
    await applyImport(
      vocabularyInput("delayed-progress", [sourceLexeme("迟", "chí", "chi2", "late")]),
    );
    const baseline = await getProgressSnapshot(env.DB, FIXED_OWNER_LEARNER_ID, { now: () => NOW });
    const card = await vocabularyCardFor("迟");
    const delayedOccurredAt = NOW - 45 * 24 * 60 * 60 * 1_000;
    await insertCanonicalAttempt({
      eventId: "delayed-offline-event",
      deviceSeq: 3,
      occurredAt: delayedOccurredAt,
      receivedAt: NOW,
      cardId: card.id,
      mode: "reflex",
      activityType: card.activity_type,
      correct: false,
      responseMs: 3_500,
      metadata: { interaction: "offline-import" },
    });

    const response = await exports.default.fetch(
      new Request("http://127.0.0.1/api/progress", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const live = (await response.json()) as { dataThrough: { latestAttemptReceivedAt: number } };
    expect(live.dataThrough.latestAttemptReceivedAt).toBe(NOW);

    const snapshot = await getProgressSnapshot(env.DB, FIXED_OWNER_LEARNER_ID, { now: () => NOW });
    expect(snapshot.overall.last30Days.attempts).toBe(baseline.overall.last30Days.attempts);
    expect(snapshot.reflex.recentResponses).toBe(baseline.reflex.recentResponses);
    expect(snapshot.dataThrough).toMatchObject({
      changedAt: NOW,
      latestAttemptReceivedAt: NOW,
      latestAttemptOccurredAt: baseline.dataThrough.latestAttemptOccurredAt,
    });
  });

  test("reflects deterministic current card state after a late FSRS review replay", async () => {
    await applyImport(
      vocabularyInput("late-review-progress", [sourceLexeme("晚", "wǎn", "wan3", "late")]),
    );
    const card = await vocabularyCardFor("晚");
    const before = await getProgressSnapshot(env.DB, FIXED_OWNER_LEARNER_ID, { now: () => NOW });
    await ingestAttempt(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      scheduledAttempt({
        eventId: "newer-review",
        cardId: card.id,
        activityType: card.activity_type,
        deviceId: "server-review-device",
        occurredAt: NOW - DAY,
        rating: 3,
      }),
      { now: () => NOW - 2_000 },
    );
    const replayed = await ingestAttempt(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      scheduledAttempt({
        eventId: "late-older-review",
        cardId: card.id,
        activityType: card.activity_type,
        deviceId: "offline-review-device",
        occurredAt: NOW - 2 * DAY,
        rating: 1,
      }),
      { now: () => NOW - 1_000 },
    );

    const snapshot = await getProgressSnapshot(env.DB, FIXED_OWNER_LEARNER_ID, { now: () => NOW });
    const troublesome = snapshot.vocabulary.troublesomeCards.find(
      ({ cardId }) => cardId === card.id,
    );
    expect(snapshot.vocabulary.recentRatings).toEqual({
      1: before.vocabulary.recentRatings[1] + 1,
      2: before.vocabulary.recentRatings[2],
      3: before.vocabulary.recentRatings[3] + 1,
      4: before.vocabulary.recentRatings[4],
    });
    expect(snapshot.vocabulary.new).toBe(before.vocabulary.new - 1);
    expect(snapshot.vocabulary.lastReviewedAt).toBe(NOW - DAY);
    expect(troublesome?.evidence.dueAt).toBe(replayed.cardState?.dueAt);
    expect(snapshot.dataThrough.latestAttemptReceivedAt).toBe(
      Math.max(before.dataThrough.latestAttemptReceivedAt ?? 0, NOW - 1_000),
    );
  });

  test("does not treat Reflex history on a scheduled card as FSRS evidence", async () => {
    await applyImport(
      vocabularyInput("reflex-fsrs-boundary", [sourceLexeme("界", "jiè", "jie4", "boundary")]),
    );
    const card = await vocabularyCardFor("界");
    const reviewedAt = NOW - 2 * DAY;
    await ingestAttempt(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      scheduledAttempt({
        eventId: "boundary-fsrs-review",
        cardId: card.id,
        activityType: card.activity_type,
        deviceId: "boundary-fsrs-device",
        occurredAt: reviewedAt,
        rating: 1,
      }),
      { now: () => NOW - 2_000 },
    );
    await insertCanonicalAttempt({
      eventId: "boundary-reflex-response",
      deviceSeq: 999,
      occurredAt: NOW - 60 * 60 * 1_000,
      receivedAt: NOW - 1_000,
      cardId: card.id,
      mode: "reflex",
      activityType: card.activity_type,
      correct: false,
      responseMs: 3_100,
      metadata: { interaction: "offline-import" },
    });

    const snapshot = await getProgressSnapshot(env.DB, FIXED_OWNER_LEARNER_ID, { now: () => NOW });
    const trouble = snapshot.vocabulary.troublesomeCards.find(({ cardId }) => cardId === card.id);
    expect(trouble).toMatchObject({
      recentAttempts: 1,
      lastPracticedAt: reviewedAt,
      evidence: { fsrsRatings: { 1: 1, 2: 0, 3: 0, 4: 0 } },
    });
  });

  test("preserves cross-mode trouble coverage when one mode has more than the global candidate cap", async () => {
    const stressLexemes = Array.from({ length: 31 }, (_, index) =>
      sourceLexeme(
        `测压${String.fromCodePoint(0x3400 + index)}`,
        "cè yā",
        "ce4 ya1",
        `stress fixture ${index}`,
      ),
    );
    await applyImport(vocabularyInput("progress-trouble-cap", stressLexemes));
    const cards = await env.DB.prepare(
      `SELECT c.id, c.activity_type
       FROM cards c JOIN lexemes l ON l.id = c.lexeme_id
       WHERE l.simplified LIKE '测压%'
       ORDER BY c.id LIMIT 61`,
    ).all<{ id: string; activity_type: "hanzi_to_meaning" | "meaning_to_hanzi" }>();
    expect(cards.results).toHaveLength(61);

    for (const [index, card] of cards.results.entries()) {
      await insertCanonicalAttempt({
        eventId: `trouble-cap-reflex-${index}`,
        deviceSeq: 2_000 + index,
        occurredAt: NOW - (index + 1) * 1_000,
        receivedAt: NOW - 500,
        cardId: card.id,
        mode: "reflex",
        activityType: card.activity_type,
        correct: false,
        responseMs: 3_000,
        metadata: { interaction: "offline-import" },
      });
    }

    const sentenceCard = await env.DB.prepare(
      `SELECT id FROM cards WHERE subject_type = 'sentence' ORDER BY id LIMIT 1`,
    ).first<{ id: string }>();
    if (!sentenceCard) throw new Error("fixture has no sentence card");
    await insertCanonicalAttempt({
      eventId: "trouble-cap-reading",
      deviceSeq: 3_000,
      occurredAt: NOW - 500,
      receivedAt: NOW,
      cardId: sentenceCard.id,
      mode: "reading",
      activityType: "sentence_reading",
      selfRating: 1,
      responseMs: 4_000,
      metadata: { interaction: "offline-import" },
    });

    const snapshot = await getProgressSnapshot(env.DB, FIXED_OWNER_LEARNER_ID, { now: () => NOW });
    expect(snapshot.reflex.troublesomeItems).toHaveLength(5);
    expect(
      snapshot.reading.difficultSentences.some(({ cardId }) => cardId === sentenceCard.id),
    ).toBe(true);
    expect(
      snapshot.troublesomeItems.some(
        ({ cardId, mode }) => cardId === sentenceCard.id && mode === "reading",
      ),
    ).toBe(true);
  });

  test("excludes future-dated attempts from rolling activity and trouble", async () => {
    await applyImport(
      vocabularyInput("future-progress", [sourceLexeme("未", "wèi", "wei4", "future")]),
    );
    const card = await vocabularyCardFor("未");
    const before = await getProgressSnapshot(env.DB, FIXED_OWNER_LEARNER_ID, { now: () => NOW });
    const futureOccurredAt = NOW + DAY;
    await insertCanonicalAttempt({
      eventId: "future-clock-skew-attempt",
      deviceSeq: 5_000,
      occurredAt: futureOccurredAt,
      receivedAt: NOW,
      cardId: card.id,
      mode: "reflex",
      activityType: card.activity_type,
      correct: false,
      responseMs: 4_000,
      metadata: { interaction: "offline-import" },
    });

    const snapshot = await getProgressSnapshot(env.DB, FIXED_OWNER_LEARNER_ID, { now: () => NOW });
    expect(snapshot.overall).toEqual(before.overall);
    expect(snapshot.reflex).toEqual(before.reflex);
    expect(snapshot.troublesomeItems).toEqual(before.troublesomeItems);
    expect(snapshot.dataThrough.latestAttemptOccurredAt).toBe(futureOccurredAt);
  });
});

const DAY = 24 * 60 * 60 * 1_000;

async function prepareMixedModeFixture(): Promise<{
  objectiveCardId: string;
  productionCardId: string;
  audioCardId: string;
  readingCardId: string;
  grammarCardId: string;
  reflexCardId: string;
  reflexActivity: "hanzi_to_meaning" | "meaning_to_hanzi";
}> {
  const revision = await env.DB.prepare(
    "SELECT current_content_revision FROM content_state WHERE singleton = 1",
  ).first<number>("current_content_revision");
  const reading = await env.DB.prepare(
    `SELECT id FROM lexeme_readings WHERE retired_at IS NULL ORDER BY id LIMIT 1`,
  ).first<{ id: string }>();
  const readingCard = await env.DB.prepare(
    `SELECT id FROM cards WHERE subject_type = 'sentence' AND retired_at IS NULL ORDER BY id LIMIT 1`,
  ).first<{ id: string }>();
  const grammarCard = await env.DB.prepare(
    `SELECT id, grammar_topic_id FROM cards
     WHERE subject_type = 'grammar_topic' AND retired_at IS NULL ORDER BY id LIMIT 1`,
  ).first<{ id: string; grammar_topic_id: string }>();
  const reflexCard = await firstVocabularyCard();
  if (revision === null || !reading || !readingCard || !grammarCard) {
    throw new Error("mixed progress fixture content is incomplete");
  }
  for (const mode of ["pronunciation", "reading", "grammar", "reflex"] as const) {
    await registerLearnerDevice(env.DB, FIXED_OWNER_LEARNER_ID, `progress-device-${mode}`);
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cards
          (id, subject_type, lexeme_reading_id, activity_type, scheduler_eligible,
           content_revision, created_at)
         VALUES (?, 'lexeme_reading', ?, 'tone_identification', 0, ?, ?)`,
    ).bind("progress-pronunciation-objective", reading.id, revision, NOW - DAY),
    env.DB.prepare(
      `INSERT INTO cards
          (id, subject_type, lexeme_reading_id, activity_type, scheduler_eligible,
           content_revision, created_at)
         VALUES (?, 'lexeme_reading', ?, 'pronunciation_production', 0, ?, ?)`,
    ).bind("progress-pronunciation-production", reading.id, revision, NOW - DAY),
    env.DB.prepare(
      `INSERT INTO cards
          (id, subject_type, lexeme_reading_id, activity_type, scheduler_eligible,
           content_revision, created_at)
         VALUES (?, 'lexeme_reading', ?, 'audio_to_hanzi', 0, ?, ?)`,
    ).bind("progress-pronunciation-audio", reading.id, revision, NOW - DAY),
    sessionStatement("progress-pronunciation-session", "pronunciation"),
    sessionStatement("progress-reading-session", "reading"),
    sessionStatement("progress-grammar-session", "grammar"),
    env.DB.prepare(
      `INSERT INTO study_sessions
        (id, learner_id, device_id, mode, started_at, context_json)
       VALUES (
         'progress-reflex-session', ?, 'progress-device-reflex', 'reflex', ?, '{"maxItems":4}'
       )`,
    ).bind(FIXED_OWNER_LEARNER_ID, NOW - DAY),
    env.DB.prepare(
      `INSERT INTO grammar_topic_state
          (learner_id, grammar_topic_id, status, introduced_at, last_studied_at, self_confidence)
         VALUES (?, ?, 'learning', ?, ?, 0.5)`,
    ).bind(
      FIXED_OWNER_LEARNER_ID,
      grammarCard.grammar_topic_id,
      NOW - DAY,
      NOW - 19 * 60 * 60 * 1_000,
    ),
  ]);
  return {
    objectiveCardId: "progress-pronunciation-objective",
    productionCardId: "progress-pronunciation-production",
    audioCardId: "progress-pronunciation-audio",
    readingCardId: readingCard.id,
    grammarCardId: grammarCard.id,
    reflexCardId: reflexCard.id,
    reflexActivity: reflexCard.activity_type,
  };
}

function sessionStatement(id: string, mode: PracticeMode): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO study_sessions (id, learner_id, device_id, mode, started_at, context_json)
       VALUES (?, ?, ?, ?, ?, '{}')`,
  ).bind(id, FIXED_OWNER_LEARNER_ID, `progress-device-${mode}`, mode, NOW - DAY);
}

async function insertCanonicalAttempt(input: {
  eventId: string;
  deviceSeq: number;
  occurredAt: number;
  receivedAt: number;
  cardId: string;
  studySessionId?: string;
  mode: PracticeMode;
  activityType: ActivityType;
  correct?: boolean;
  selfRating?: number;
  responseMs?: number;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const changeId = `attempt:${input.eventId}`;
  const deviceId = `progress-device-${input.mode}`;
  await registerLearnerDevice(env.DB, FIXED_OWNER_LEARNER_ID, deviceId);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO server_changes
          (change_id, learner_id, entity_type, entity_id, operation, changed_at)
         VALUES (?, ?, 'attempt', ?, 'upsert', ?)`,
    ).bind(changeId, FIXED_OWNER_LEARNER_ID, input.eventId, input.receivedAt),
    env.DB.prepare(
      `INSERT INTO attempts
          (event_id, learner_id, device_id, device_seq, occurred_at, received_at, card_id,
           study_session_id, mode, activity_type, correct, self_rating, response_ms,
           metadata_json, server_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT seq FROM server_changes WHERE change_id = ?))`,
    ).bind(
      input.eventId,
      FIXED_OWNER_LEARNER_ID,
      deviceId,
      input.deviceSeq,
      input.occurredAt,
      input.receivedAt,
      input.cardId,
      input.studySessionId ?? null,
      input.mode,
      input.activityType,
      input.correct === undefined ? null : Number(input.correct),
      input.selfRating ?? null,
      input.responseMs ?? null,
      JSON.stringify(input.metadata),
      changeId,
    ),
  ]);
}

async function canonicalLearningState(): Promise<Record<string, unknown>> {
  const [counts, cards, grammar, sessions] = await Promise.all([
    env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM attempts WHERE learner_id = ?) AS attempts,
        (SELECT COUNT(*) FROM fsrs_reviews) AS reviews,
        (SELECT dirty FROM projection_state WHERE learner_id = ?) AS projection_dirty,
        (SELECT last_attempt_at FROM projection_state WHERE learner_id = ?) AS last_attempt_at`,
    )
      .bind(FIXED_OWNER_LEARNER_ID, FIXED_OWNER_LEARNER_ID, FIXED_OWNER_LEARNER_ID)
      .first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT card_id, due_at, stability, difficulty, reps, lapses, state, version, server_seq
       FROM card_state WHERE learner_id = ? ORDER BY card_id`,
    )
      .bind(FIXED_OWNER_LEARNER_ID)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT grammar_topic_id, status, last_studied_at, self_confidence, version, server_seq
       FROM grammar_topic_state WHERE learner_id = ? ORDER BY grammar_topic_id`,
    )
      .bind(FIXED_OWNER_LEARNER_ID)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id, ended_at, aggregate_json, server_seq
       FROM study_sessions WHERE learner_id = ? ORDER BY id`,
    )
      .bind(FIXED_OWNER_LEARNER_ID)
      .all<Record<string, unknown>>(),
  ]);
  return {
    counts,
    cards: cards.results,
    grammar: grammar.results,
    sessions: sessions.results,
  };
}

async function firstVocabularyCard(): Promise<{
  id: string;
  activity_type: "hanzi_to_meaning" | "meaning_to_hanzi";
}> {
  const card = await env.DB.prepare(
    `SELECT id, activity_type FROM cards
     WHERE subject_type = 'lexeme' AND scheduler_eligible = 1
     ORDER BY id LIMIT 1`,
  ).first<{ id: string; activity_type: "hanzi_to_meaning" | "meaning_to_hanzi" }>();
  if (!card) throw new Error("fixture has no vocabulary card");
  return card;
}

async function vocabularyCardFor(simplified: string): Promise<{
  id: string;
  activity_type: "hanzi_to_meaning" | "meaning_to_hanzi";
}> {
  const card = await env.DB.prepare(
    `SELECT c.id, c.activity_type FROM cards c
     JOIN lexemes l ON l.id = c.lexeme_id
     WHERE c.subject_type = 'lexeme' AND c.scheduler_eligible = 1
       AND l.simplified = ?
     ORDER BY c.id LIMIT 1`,
  )
    .bind(simplified)
    .first<{ id: string; activity_type: "hanzi_to_meaning" | "meaning_to_hanzi" }>();
  if (!card) throw new Error(`fixture has no vocabulary card for ${simplified}`);
  return card;
}

function scheduledAttempt(input: {
  eventId: string;
  cardId: string;
  activityType: "hanzi_to_meaning" | "meaning_to_hanzi";
  deviceId: string;
  occurredAt: number;
  rating: 1 | 2 | 3 | 4;
}): AttemptInput {
  return {
    eventId: input.eventId,
    deviceId: input.deviceId,
    deviceSeq: 1,
    occurredAt: new Date(input.occurredAt).toISOString(),
    cardId: input.cardId,
    mode: "study",
    activityType: input.activityType,
    responseMs: 800,
    metadata: { interaction: "reveal-and-rate" },
    fsrsReview: { rating: input.rating, schedulerConfigId: DEFAULT_SCHEDULER_CONFIG_ID },
  };
}

function readingGrammarInput(): V1ImportInput {
  return {
    vocabularyVersion: "progress-reading-grammar-vocabulary",
    v1Version: "progress-reading-grammar-v1",
    createdAt: NOW - 2 * DAY,
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
    enrichments: BEGINNER_GRAMMAR_TOPICS.map((topic) => ({
      simplified: topic.anchorSimplified,
      meaning_ja: topic.teaching.summaryJa,
      example_zh: topic.expectedSentence.chinese,
      example_pinyin: topic.expectedSentence.pinyin,
      example_ja: topic.expectedSentence.meaningJa,
      example_en: topic.expectedSentence.meaningEn,
    })),
  };
}

function vocabularyInput(prefix: string, lexemes: V1SourceLexeme[]): V1ImportInput {
  return {
    lexemes,
    enrichments: [],
    vocabularyVersion: `${prefix}-vocabulary`,
    v1Version: `${prefix}-v1`,
    createdAt: NOW - 3 * DAY,
  };
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

async function applyImport(input: V1ImportInput): Promise<void> {
  const statements = await buildV1ImportStatements(input);
  for (let index = 0; index < statements.length; index += 60) {
    await env.DB.batch(
      statements.slice(index, index + 60).map((statement) => env.DB.prepare(statement)),
    );
  }
}
