import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { ingestAttempt } from "../../src/db/ingestion";
import { createLearner } from "../../src/db/learners";
import { getProgressSnapshot } from "../../src/db/progress";
import {
  getPracticeSessionSummary,
  getRecentPracticeSessions,
} from "../../src/db/practice-sessions";
import { createStudySession, getNextStudyCard } from "../../src/db/study";
import { pullSyncChanges } from "../../src/db/sync";
import { DEFAULT_SCHEDULER_CONFIG_ID } from "../../src/domain/fsrs";
import type { AttemptInput, MaterializedCardState } from "../../src/domain/types";

const LEARNER_A = "learner:test:a";
const LEARNER_B = "learner:test:b";
const CARD_ID = "card:learner-isolation:hanzi_to_meaning";
const TOPIC_ID = "grammar:learner-isolation";
const NOW = Date.parse("2026-08-31T15:00:00Z");

describe("learner identity foundation", () => {
  test("isolates learner history, state, sessions, progress, replay, and sync over shared content", async () => {
    await createLearner(env.DB, LEARNER_A, NOW - 4 * 60 * 60 * 1_000);
    await createLearner(env.DB, LEARNER_B, NOW - 4 * 60 * 60 * 1_000);
    await seedSharedContent();

    expect(await scalar("SELECT COUNT(*) FROM cards WHERE id = ?", CARD_ID)).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT learner_id, timezone FROM learner_settings
         WHERE learner_id IN (?, ?) ORDER BY learner_id`,
      )
        .bind(LEARNER_A, LEARNER_B)
        .all(),
    ).toMatchObject({
      results: [
        { learner_id: LEARNER_A, timezone: "Asia/Tokyo" },
        { learner_id: LEARNER_B, timezone: "Asia/Tokyo" },
      ],
    });
    expect(
      await env.DB.prepare(
        `SELECT learner_id, card_id, version
         FROM card_state WHERE learner_id IN (?, ?) AND card_id = ?
         ORDER BY learner_id`,
      )
        .bind(LEARNER_A, LEARNER_B, CARD_ID)
        .all(),
    ).toMatchObject({
      results: [
        { learner_id: LEARNER_A, card_id: CARD_ID, version: 0 },
        { learner_id: LEARNER_B, card_id: CARD_ID, version: 0 },
      ],
    });

    await createStudySession(
      env.DB,
      LEARNER_A,
      { sessionId: "session:a:phone", deviceId: "device:a:phone", maxCards: 1 },
      { now: () => NOW - 3 * 60 * 60 * 1_000 },
    );
    await createStudySession(
      env.DB,
      LEARNER_A,
      { sessionId: "session:a:desktop", deviceId: "device:a:desktop", maxCards: 1 },
      { now: () => NOW - 3 * 60 * 60 * 1_000 },
    );
    await createStudySession(
      env.DB,
      LEARNER_B,
      { sessionId: "session:b:phone", deviceId: "device:b:phone", maxCards: 1 },
      { now: () => NOW - 3 * 60 * 60 * 1_000 },
    );

    await expect(
      getNextStudyCard(env.DB, LEARNER_B, "session:a:phone", "device:a:phone"),
    ).rejects.toThrow("study session");

    const firstA = await ingestAttempt(
      env.DB,
      LEARNER_A,
      scheduledAttempt({
        eventId: "review:a:phone",
        deviceId: "device:a:phone",
        studySessionId: "session:a:phone",
        occurredAt: NOW - 2 * 60 * 60 * 1_000,
        rating: 3,
        expectedVersion: 0,
      }),
      { now: () => NOW - 2 * 60 * 60 * 1_000 + 1 },
    );
    expect(firstA.cardState?.version).toBe(1);
    expect(await cardState(LEARNER_B)).toMatchObject({ version: 0, reps: 0 });

    await ingestAttempt(
      env.DB,
      LEARNER_B,
      scheduledAttempt({
        eventId: "review:b:phone",
        deviceId: "device:b:phone",
        studySessionId: "session:b:phone",
        occurredAt: NOW - 90 * 60 * 1_000,
        rating: 1,
        expectedVersion: 0,
      }),
      { now: () => NOW - 90 * 60 * 1_000 + 1 },
    );
    const learnerBBeforeLateA = await cardState(LEARNER_B);

    const lateA = await ingestAttempt(
      env.DB,
      LEARNER_A,
      scheduledAttempt({
        eventId: "review:a:desktop:late",
        deviceId: "device:a:desktop",
        studySessionId: "session:a:desktop",
        occurredAt: NOW - 3 * 60 * 60 * 1_000,
        rating: 2,
        expectedVersion: 0,
      }),
      { now: () => NOW - 60 * 60 * 1_000 },
    );
    expect(lateA.cardState).toMatchObject({ version: 2, reps: 2 });
    expect(await cardState(LEARNER_B)).toEqual(learnerBBeforeLateA);

    await seedGrammarStateForLearnerA();
    const [progressA, progressB] = await Promise.all([
      getProgressSnapshot(env.DB, LEARNER_A, { now: () => NOW }),
      getProgressSnapshot(env.DB, LEARNER_B, { now: () => NOW }),
    ]);
    expect(progressA.overall.last7Days.attempts).toBe(2);
    expect(progressB.overall.last7Days.attempts).toBe(1);
    expect(progressA.vocabulary.recentScheduledReviews).toBe(2);
    expect(progressB.vocabulary.recentScheduledReviews).toBe(1);
    expect(progressA.grammar.topicCounts.learning).toBe(1);
    expect(progressB.grammar.topicCounts.notIntroduced).toBe(1);

    const [phoneA, desktopA, phoneB] = await Promise.all([
      pullSyncChanges(env.DB, LEARNER_A, syncInput("device:a:phone")),
      pullSyncChanges(env.DB, LEARNER_A, syncInput("device:a:desktop")),
      pullSyncChanges(env.DB, LEARNER_B, syncInput("device:b:phone")),
    ]);
    expect(phoneA.learnerChanges).toEqual(desktopA.learnerChanges);
    expect(phoneA.contentChanges).toEqual(phoneB.contentChanges);
    expect(changeEventIds(phoneA)).toEqual(["review:a:desktop:late", "review:a:phone"]);
    expect(changeEventIds(phoneB)).toEqual(["review:b:phone"]);
    expect(
      phoneB.learnerChanges.some(
        (change) =>
          change.entityType === "grammar_topic_state" && change.state.status === "learning",
      ),
    ).toBe(false);

    expect(
      await getNextStudyCard(env.DB, LEARNER_A, "session:a:phone", "device:a:phone", {
        now: () => NOW,
      }),
    ).toMatchObject({ status: "completed" });
    expect(
      await getNextStudyCard(env.DB, LEARNER_B, "session:b:phone", "device:b:phone", {
        now: () => NOW,
      }),
    ).toMatchObject({ status: "completed" });

    const [historyA, historyB] = await Promise.all([
      getRecentPracticeSessions(env.DB, LEARNER_A, { now: () => NOW }),
      getRecentPracticeSessions(env.DB, LEARNER_B, { now: () => NOW }),
    ]);
    expect(historyA.sessions.map(({ sessionId }) => sessionId)).toEqual(["session:a:phone"]);
    expect(historyB.sessions.map(({ sessionId }) => sessionId)).toEqual(["session:b:phone"]);
    expect(historyA.sessions[0]).toMatchObject({
      learnerId: LEARNER_A,
      practice: "vocabulary_review",
      configuration: { direction: "mixed", requestedItems: 1, actualItems: 1 },
      evidence: { ratings: { distribution: { 3: 1 } } },
    });
    expect(historyB.sessions[0]).toMatchObject({
      learnerId: LEARNER_B,
      evidence: { ratings: { distribution: { 1: 1 } } },
      attentionItems: [{ label: "学", reasons: ["忘れた"] }],
    });
    await expect(getPracticeSessionSummary(env.DB, LEARNER_B, "session:a:phone")).rejects.toThrow(
      "completed practice session",
    );
    const learnerBAfterHiddenChange = await pullSyncChanges(env.DB, LEARNER_B, {
      ...syncInput("device:b:phone"),
      cursor: phoneB.nextCursor,
      contentRevision: phoneB.currentContentRevision,
    });
    expect(learnerBAfterHiddenChange.learnerChanges).toMatchObject([
      { entityType: "study_session", sessionId: "session:b:phone", mode: "study" },
    ]);
    expect(
      learnerBAfterHiddenChange.learnerChanges.some(
        (change) =>
          change.entityType === "study_session" && change.sessionId.startsWith("session:a:"),
      ),
    ).toBe(false);
    expect(learnerBAfterHiddenChange.contentChanges).toEqual([]);
    expect(learnerBAfterHiddenChange.nextCursor).toBeGreaterThan(phoneB.nextCursor);

    expect(
      await env.DB.prepare(
        "SELECT id, learner_id FROM learner_devices WHERE id LIKE 'device:%' ORDER BY id",
      ).all(),
    ).toMatchObject({
      results: [
        { id: "device:a:desktop", learner_id: LEARNER_A },
        { id: "device:a:phone", learner_id: LEARNER_A },
        { id: "device:b:phone", learner_id: LEARNER_B },
      ],
    });

    const fixedOwnerResponse = await exports.default.fetch(
      new Request("http://localhost/api/progress", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ learnerId: LEARNER_B }),
      }),
    );
    expect(fixedOwnerResponse.status).toBe(200);
    expect(
      ((await fixedOwnerResponse.json()) as { overall: { last7Days: { attempts: number } } })
        .overall.last7Days.attempts,
    ).toBe(0);
  });
});

async function seedSharedContent(): Promise<void> {
  const revisionResult = await env.DB.prepare(
    `INSERT INTO content_revisions (source, source_version, description, created_at)
     VALUES ('learner-identity-test', 'v1', 'shared learner fixture', ?)`,
  )
    .bind(NOW - 4 * 60 * 60 * 1_000)
    .run();
  const revision = Number(revisionResult.meta.last_row_id);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO lexemes
        (id, simplified, meanings_json, source, content_revision, created_at, updated_at)
       VALUES ('lexeme:learner-isolation', '学', '[{"language":"ja","text":"学ぶ"}]',
         'learner-identity-test', ?, ?, ?)`,
    ).bind(revision, NOW - 4 * 60 * 60 * 1_000, NOW - 4 * 60 * 60 * 1_000),
    env.DB.prepare(
      `INSERT INTO cards
        (id, subject_type, lexeme_id, activity_type, scheduler_eligible,
         content_revision, created_at)
       VALUES (?, 'lexeme', 'lexeme:learner-isolation', 'hanzi_to_meaning', 1, ?, ?)`,
    ).bind(CARD_ID, revision, NOW - 4 * 60 * 60 * 1_000),
    env.DB.prepare(
      `INSERT INTO grammar_topics
        (id, title, source, content_revision, created_at)
       VALUES (?, '共有文法', 'learner-identity-test', ?, ?)`,
    ).bind(TOPIC_ID, revision, NOW - 4 * 60 * 60 * 1_000),
    env.DB.prepare(
      `UPDATE content_state
       SET current_content_revision = ?, updated_at = ?
       WHERE singleton = 1`,
    ).bind(revision, NOW - 4 * 60 * 60 * 1_000),
    env.DB.prepare(
      `INSERT INTO server_changes
        (change_id, entity_type, entity_id, operation, content_revision, changed_at)
       VALUES ('content:learner-isolation', 'content', ?, 'upsert', ?, ?)`,
    ).bind(`content-revision:${revision}`, revision, NOW - 4 * 60 * 60 * 1_000),
  ]);
}

async function seedGrammarStateForLearnerA(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO server_changes
        (change_id, learner_id, entity_type, entity_id, operation, changed_at)
       VALUES ('grammar-state:learner-a', ?, 'grammar_topic_state', ?, 'upsert', ?)`,
    ).bind(LEARNER_A, TOPIC_ID, NOW - 30 * 60 * 1_000),
    env.DB.prepare(
      `INSERT INTO grammar_topic_state
        (learner_id, grammar_topic_id, status, introduced_at, last_studied_at,
         self_confidence, version, server_seq)
       VALUES (?, ?, 'learning', ?, ?, 0.5, 1,
         (SELECT seq FROM server_changes WHERE change_id = 'grammar-state:learner-a'))`,
    ).bind(LEARNER_A, TOPIC_ID, NOW - 30 * 60 * 1_000, NOW - 30 * 60 * 1_000),
  ]);
}

function scheduledAttempt(input: {
  eventId: string;
  deviceId: string;
  studySessionId: string;
  occurredAt: number;
  rating: 1 | 2 | 3 | 4;
  expectedVersion: number;
}): AttemptInput {
  return {
    eventId: input.eventId,
    deviceId: input.deviceId,
    deviceSeq: 1,
    occurredAt: new Date(input.occurredAt).toISOString(),
    cardId: CARD_ID,
    studySessionId: input.studySessionId,
    mode: "study",
    activityType: "hanzi_to_meaning",
    correct: input.rating >= 3,
    expectedCardStateVersion: input.expectedVersion,
    fsrsReview: { rating: input.rating, schedulerConfigId: DEFAULT_SCHEDULER_CONFIG_ID },
  };
}

async function cardState(learnerId: string): Promise<MaterializedCardState> {
  const row = await env.DB.prepare(
    `SELECT card_id, due_at, stability, difficulty, elapsed_days, scheduled_days,
       learning_steps, reps, lapses, state, last_review_at, version, server_seq, rebuilt_at
     FROM card_state WHERE learner_id = ? AND card_id = ?`,
  )
    .bind(learnerId, CARD_ID)
    .first<{
      card_id: string;
      due_at: number;
      stability: number;
      difficulty: number;
      elapsed_days: number;
      scheduled_days: number;
      learning_steps: number;
      reps: number;
      lapses: number;
      state: number;
      last_review_at: number | null;
      version: number;
      server_seq: number | null;
      rebuilt_at: number;
    }>();
  if (!row) throw new Error(`missing card state for ${learnerId}`);
  return {
    cardId: row.card_id,
    dueAt: row.due_at,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsed_days,
    scheduledDays: row.scheduled_days,
    learningSteps: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    lastReviewAt: row.last_review_at,
    version: row.version,
    serverSeq: row.server_seq,
    rebuiltAt: row.rebuilt_at,
  };
}

function syncInput(deviceId: string) {
  return { cursor: 0, contentRevision: null, deviceId };
}

function changeEventIds(response: Awaited<ReturnType<typeof pullSyncChanges>>): string[] {
  return response.learnerChanges
    .filter((change) => change.entityType === "attempt")
    .map((change) => change.eventId)
    .sort();
}

async function scalar(sql: string, ...bindings: Array<string | number>): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...bindings)
    .first<Record<string, number>>();
  return row ? (Object.values(row)[0] ?? 0) : 0;
}
