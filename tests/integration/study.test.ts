import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { FIXED_OWNER_LEARNER_ID } from "../../src/worker/current-learner";

import { ingestAttempt } from "../../src/db/ingestion";
import { getPracticeSessionSummary } from "../../src/db/practice-sessions";
import { createStudySession, getNextStudyCard } from "../../src/db/study";
import {
  buildV1ImportStatements,
  type V1ImportInput,
  type V1Enrichment,
  type V1SourceLexeme,
} from "../../src/db/v1-import";
import { DEFAULT_SCHEDULER_CONFIG_ID } from "../../src/domain/fsrs";
import {
  CURRENT_PRACTICE_CONTRACT_VERSIONS,
  LEGACY_PRACTICE_CONTRACT_VERSIONS,
} from "../../src/domain/practice-contract";
import type { AttemptInput, PracticeSessionHistory, StudyNextResult } from "../../src/domain/types";

describe("vocabulary study flow", () => {
  test("selects progressed due cards before deterministic new cards", async () => {
    await applyImport("due-priority", [lexeme("先", 1), lexeme("后", 2)]);
    const dueCardId = cardId("先", "hanzi_to_meaning");
    const reviewTime = Date.parse("2026-08-29T08:00:00Z");
    await ingestAttempt(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      scheduledAttempt({
        eventId: "due-priority-setup",
        cardId: dueCardId,
        deviceId: "due-priority-setup-device",
        deviceSeq: 1,
        occurredAt: new Date(reviewTime).toISOString(),
        activityType: "hanzi_to_meaning",
        rating: 1,
      }),
      { now: () => reviewTime + 1 },
    );

    const now = reviewTime + 60 * 60 * 1000;
    await createStudySession(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      { sessionId: "due-priority-session", deviceId: "due-priority-device", maxCards: 4 },
      { now: () => now },
    );
    const next = await getNextStudyCard(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "due-priority-session",
      "due-priority-device",
      {
        now: () => now,
      },
    );

    expect(next.status).toBe("card");
    expect(next.card).toMatchObject({ cardId: dueCardId, source: "due" });
    await retireLexemes(["先", "后"]);
  });

  test("a reveal-and-rate UI payload uses canonical ingestion and advances both directions", async () => {
    await applyImport("canonical-ui", [lexeme("爱", 1)]);
    const sessionResponse = await localJson("/api/study/sessions", {
      sessionId: "canonical-ui-session",
      deviceId: "canonical-ui-device",
      maxCards: 2,
    });
    expect(sessionResponse.status).toBe(201);

    const firstResponse = await localJson("/api/study/sessions/canonical-ui-session/next", {
      deviceId: "canonical-ui-device",
    });
    const first = (await firstResponse.json()) as StudyNextResult;
    expect(first.card).toMatchObject({
      activityType: "hanzi_to_meaning",
      source: "new",
      schedulerConfigId: DEFAULT_SCHEDULER_CONFIG_ID,
    });
    if (!first.card) throw new Error("missing first study card");

    const firstAttempt = scheduledAttempt({
      eventId: "canonical-ui-event-1",
      cardId: first.card.cardId,
      deviceId: "canonical-ui-device",
      deviceSeq: 1,
      occurredAt: "2026-08-30T01:00:00Z",
      activityType: first.card.activityType,
      rating: 3,
      studySessionId: "canonical-ui-session",
      expectedCardStateVersion: first.card.state.version,
    });
    const write = await localJson("/api/attempts", firstAttempt);
    expect(write.status).toBe(201);
    await expect(write.json()).resolves.toMatchObject({
      disposition: "inserted",
      reviewCreated: true,
      cardState: { version: 1 },
    });

    const duplicate = await localJson("/api/attempts", firstAttempt);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ disposition: "duplicate" });

    const persisted = await env.DB.prepare(
      `SELECT a.correct, a.self_rating, r.rating, cs.version
       FROM attempts a
       JOIN fsrs_reviews r ON r.attempt_id = a.event_id
       JOIN card_state cs ON cs.card_id = a.card_id
       WHERE a.event_id = ?`,
    )
      .bind(firstAttempt.eventId)
      .first<{
        correct: number | null;
        self_rating: number | null;
        rating: number;
        version: number;
      }>();
    expect(persisted).toEqual({ correct: null, self_rating: null, rating: 3, version: 1 });

    const secondResponse = await localJson("/api/study/sessions/canonical-ui-session/next", {
      deviceId: "canonical-ui-device",
    });
    const second = (await secondResponse.json()) as StudyNextResult;
    expect(second.card).toMatchObject({ activityType: "meaning_to_hanzi", source: "new" });
    expect(second.card?.cardId).not.toBe(first.card.cardId);
    if (!second.card) throw new Error("missing second study card");

    const secondAttempt = scheduledAttempt({
      eventId: "canonical-ui-event-2",
      cardId: second.card.cardId,
      deviceId: "canonical-ui-device",
      deviceSeq: 2,
      occurredAt: "2026-08-30T01:01:00Z",
      activityType: second.card.activityType,
      rating: 4,
      studySessionId: "canonical-ui-session",
      expectedCardStateVersion: second.card.state.version,
    });
    expect((await localJson("/api/attempts", secondAttempt)).status).toBe(201);

    const completedResponse = await localJson("/api/study/sessions/canonical-ui-session/next", {
      deviceId: "canonical-ui-device",
    });
    const completed = (await completedResponse.json()) as StudyNextResult;
    expect(completed).toMatchObject({
      status: "completed",
      session: { reviewedCards: 2, maxCards: 2 },
      card: null,
    });
    expect(completed.session.endedAt).not.toBeNull();
    await expect(
      getPracticeSessionSummary(env.DB, FIXED_OWNER_LEARNER_ID, "canonical-ui-session"),
    ).resolves.toMatchObject({
      practice: "vocabulary_review",
      configuration: { direction: "mixed", requestedItems: 2, actualItems: 2 },
      evidence: {
        ratings: { distribution: { 3: 1, 4: 1 } },
        directions: { hanzi_to_meaning: 1, meaning_to_hanzi: 1 },
      },
    });
    const historyResponse = await localJson("/api/practice-sessions/recent", { limit: 10 });
    expect(historyResponse.status).toBe(200);
    expect(historyResponse.headers.get("Cache-Control")).toBe("no-store");
    const history = (await historyResponse.json()) as PracticeSessionHistory;
    expect(history.sessions).toContainEqual(
      expect.objectContaining({
        sessionId: "canonical-ui-session",
        practice: "vocabulary_review",
      }),
    );
    await retireLexemes(["爱"]);
  });

  test("persists a requested direction and filters the prepared card pool", async () => {
    await applyImport("direction-choice", [lexeme("向", 1)]);
    const created = await createStudySession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "direction-choice-session",
      deviceId: "direction-choice-device",
      maxCards: 1,
      direction: "meaning_to_hanzi",
    });
    expect(created.session).toMatchObject({
      maxCards: 1,
      direction: "meaning_to_hanzi",
    });
    const next = await getNextStudyCard(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "direction-choice-session",
      "direction-choice-device",
    );
    expect(next.card).toMatchObject({
      activityType: "meaning_to_hanzi",
      lexeme: { simplified: "向" },
    });
    await retireLexemes(["向"]);
  });

  test("keeps an unversioned persisted Study context on the legacy contract", async () => {
    await applyImport("unversioned-study-context", [lexeme("旧", 1)]);
    await createStudySession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "unversioned-study-context-session",
      deviceId: "unversioned-study-context-device",
      maxCards: 1,
    });

    const stored = await env.DB.prepare(
      "SELECT context_json FROM study_sessions WHERE id = ? AND mode = 'study'",
    )
      .bind("unversioned-study-context-session")
      .first<{ context_json: string }>();
    if (!stored) throw new Error("missing persisted Study context");
    const context = JSON.parse(stored.context_json) as Record<string, unknown>;
    delete context.practiceContractVersion;
    await env.DB.prepare("UPDATE study_sessions SET context_json = ? WHERE id = ?")
      .bind(JSON.stringify(context), "unversioned-study-context-session")
      .run();

    const currentVersions = CURRENT_PRACTICE_CONTRACT_VERSIONS as unknown as Record<
      "study",
      number
    >;
    const currentVersion = currentVersions.study;
    currentVersions.study = currentVersion + 1;
    try {
      const existing = await createStudySession(env.DB, FIXED_OWNER_LEARNER_ID, {
        sessionId: "unversioned-study-context-session",
        deviceId: "unversioned-study-context-device",
        maxCards: 1,
      });
      expect(existing.session.practiceContractVersion).toBe(
        LEGACY_PRACTICE_CONTRACT_VERSIONS.study,
      );
    } finally {
      currentVersions.study = currentVersion;
    }
    await retireLexemes(["旧"]);
  });

  test("defers a recent lexeme sibling without dropping its due card", async () => {
    await applyImport("lexical-variety", [lexeme("甲", 1), lexeme("乙", 2)]);
    const setupTime = Date.parse("2026-08-01T08:00:00Z");
    const setupCards = ["hanzi_to_meaning", "meaning_to_hanzi"] as const;
    for (const [index, activityType] of setupCards.entries()) {
      await ingestAttempt(
        env.DB,
        FIXED_OWNER_LEARNER_ID,
        scheduledAttempt({
          eventId: `lexical-variety-setup-${index}`,
          cardId: cardId("甲", activityType),
          deviceId: "lexical-variety-setup-device",
          deviceSeq: index + 1,
          occurredAt: new Date(setupTime).toISOString(),
          activityType,
          rating: 1,
        }),
        { now: () => setupTime + 1 },
      );
    }

    const now = Date.parse("2026-08-31T08:00:00Z");
    await createStudySession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "lexical-variety-session",
      deviceId: "lexical-variety-device",
      maxCards: 3,
    });
    const first = await getNextStudyCard(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "lexical-variety-session",
      "lexical-variety-device",
      { now: () => now },
    );
    expect(first.card?.lexeme.simplified).toBe("甲");
    if (!first.card) throw new Error("missing first lexical variety card");
    await ingestAttempt(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      scheduledAttempt({
        eventId: "lexical-variety-session-first",
        cardId: first.card.cardId,
        deviceId: "lexical-variety-device",
        deviceSeq: 1,
        occurredAt: new Date(now).toISOString(),
        activityType: first.card.activityType,
        rating: 3,
        studySessionId: "lexical-variety-session",
        expectedCardStateVersion: first.card.state.version,
      }),
      { now: () => now + 1 },
    );

    const second = await getNextStudyCard(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "lexical-variety-session",
      "lexical-variety-device",
      { now: () => now + 2 },
    );
    expect(second.card).toMatchObject({ source: "new", lexeme: { simplified: "乙" } });
    if (!second.card) throw new Error("missing deferred sibling alternative");
    await ingestAttempt(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      scheduledAttempt({
        eventId: "lexical-variety-session-second",
        cardId: second.card.cardId,
        deviceId: "lexical-variety-device",
        deviceSeq: 2,
        occurredAt: new Date(now + 2).toISOString(),
        activityType: second.card.activityType,
        rating: 3,
        studySessionId: "lexical-variety-session",
        expectedCardStateVersion: second.card.state.version,
      }),
      { now: () => now + 3 },
    );
    const deferred = await getNextStudyCard(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "lexical-variety-session",
      "lexical-variety-device",
      { now: () => now + 4 },
    );
    expect(deferred.card).toMatchObject({ source: "due", lexeme: { simplified: "甲" } });
    await retireLexemes(["甲", "乙"]);
  });

  test("aligns displayed meanings with the preferred reading", async () => {
    await applyImport(
      "preferred-reading-meaning",
      [
        {
          simplified: "行",
          frequency: 1,
          hskLevel: 1,
          forms: [
            {
              traditional: "行",
              transcriptions: { pinyin: "xíng", numeric: "xing2" },
              meanings: ["to walk", "to be capable"],
            },
            {
              traditional: "行",
              transcriptions: { pinyin: "háng", numeric: "hang2" },
              meanings: ["row", "profession"],
            },
          ],
        },
      ],
      [{ simplified: "行", meaning_ja: "歩く；できる" }],
    );
    await createStudySession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "preferred-reading-meaning-session",
      deviceId: "preferred-reading-meaning-device",
      maxCards: 1,
    });

    const next = await getNextStudyCard(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "preferred-reading-meaning-session",
      "preferred-reading-meaning-device",
    );

    expect(next.card?.lexeme).toMatchObject({
      simplified: "行",
      pinyin: "xíng",
      numericPinyin: "xing2",
    });
    expect(next.card?.lexeme.meanings).toEqual([
      { language: "en", text: "to walk" },
      { language: "en", text: "to be capable" },
      { language: "ja", text: "歩く；できる" },
    ]);
    await retireLexemes(["行"]);
  });

  test("empty sessions complete coherently and API input failures are explicit", async () => {
    const invalid = await localJson("/api/study/sessions", {
      sessionId: "invalid-session",
      deviceId: "invalid-device",
      maxCards: 0,
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: "invalid_input" });

    const unauthorized = await workerJson("https://example.test/api/study/sessions", {
      sessionId: "unauthorized-session",
      deviceId: "unauthorized-device",
    });
    expect(unauthorized.status).toBe(401);

    expect(
      (
        await localJson("/api/study/sessions/missing-session/next", {
          deviceId: "missing-device",
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await localJson("/api/study/sessions", {
          sessionId: "empty-session",
          deviceId: "empty-device",
          maxCards: 3,
        })
      ).status,
    ).toBe(201);
    const wrongDevice = await localJson("/api/study/sessions/empty-session/next", {
      deviceId: "another-device",
    });
    expect(wrongDevice.status).toBe(409);

    const emptyResponse = await localJson("/api/study/sessions/empty-session/next", {
      deviceId: "empty-device",
    });
    const empty = (await emptyResponse.json()) as StudyNextResult;
    expect(empty).toMatchObject({ status: "empty", card: null });
    expect(empty.session.endedAt).not.toBeNull();
  });

  test("local bypass rejects cross-origin/simple requests and malformed JSON is a 400", async () => {
    const sessionBody = {
      sessionId: "bypass-security-session",
      deviceId: "bypass-security-device",
      maxCards: 3,
    };
    const crossOrigin = await workerJson("http://127.0.0.1/api/study/sessions", sessionBody, {
      origin: "https://attacker.example",
    });
    expect(crossOrigin.status).toBe(401);

    const simpleRequest = await workerRaw(
      "http://127.0.0.1/api/study/sessions",
      JSON.stringify(sessionBody),
      {
        "content-type": "text/plain",
        origin: "http://127.0.0.1",
      },
    );
    expect(simpleRequest.status).toBe(401);

    const malformedSession = await localRaw("/api/study/sessions", "{");
    expect(malformedSession.status).toBe(400);
    await expect(malformedSession.json()).resolves.toMatchObject({ code: "invalid_input" });

    const malformedNext = await localRaw("/api/study/sessions/bypass-security-session/next", "");
    expect(malformedNext.status).toBe(400);
    await expect(malformedNext.json()).resolves.toMatchObject({ code: "invalid_input" });
  });
});

async function applyImport(
  prefix: string,
  lexemes: V1SourceLexeme[],
  enrichments: V1Enrichment[] = [],
): Promise<void> {
  const input: V1ImportInput = {
    lexemes,
    enrichments,
    vocabularyVersion: `${prefix}-vocabulary`,
    v1Version: `${prefix}-v1`,
  };
  const statements = await buildV1ImportStatements(input);
  await env.DB.batch(
    statements
      .filter((statement) => !statement.startsWith("PRAGMA"))
      .map((statement) => env.DB.prepare(statement)),
  );
}

async function retireLexemes(simplified: string[]): Promise<void> {
  for (const value of simplified) {
    await env.DB.prepare("UPDATE cards SET retired_at = 0 WHERE lexeme_id = ?")
      .bind(`lexeme:complete-hsk:${encodeURIComponent(value)}`)
      .run();
  }
}

function lexeme(simplified: string, frequency: number): V1SourceLexeme {
  return {
    simplified,
    frequency,
    hskLevel: 1,
    forms: [
      {
        traditional: simplified,
        transcriptions: { pinyin: `${simplified} pinyin`, numeric: "shi4" },
        meanings: [`${simplified} meaning`],
      },
    ],
  };
}

function cardId(simplified: string, activityType: "hanzi_to_meaning" | "meaning_to_hanzi"): string {
  return `card:lexeme:complete-hsk:${encodeURIComponent(simplified)}:${activityType}`;
}

function scheduledAttempt(input: {
  eventId: string;
  cardId: string;
  deviceId: string;
  deviceSeq: number;
  occurredAt: string;
  activityType: "hanzi_to_meaning" | "meaning_to_hanzi";
  rating: 1 | 2 | 3 | 4;
  studySessionId?: string;
  expectedCardStateVersion?: number;
}): AttemptInput {
  return {
    eventId: input.eventId,
    cardId: input.cardId,
    deviceId: input.deviceId,
    deviceSeq: input.deviceSeq,
    occurredAt: input.occurredAt,
    studySessionId: input.studySessionId,
    mode: "study",
    activityType: input.activityType,
    responseMs: 800,
    expectedCardStateVersion: input.expectedCardStateVersion,
    metadata: { interaction: "reveal-and-rate" },
    fsrsReview: {
      rating: input.rating,
      schedulerConfigId: DEFAULT_SCHEDULER_CONFIG_ID,
    },
  };
}

function localJson(path: string, body: unknown): Promise<Response> {
  const url = `http://127.0.0.1${path}`;
  return workerJson(url, body, { origin: new URL(url).origin });
}

function localRaw(path: string, body: string): Promise<Response> {
  const url = `http://127.0.0.1${path}`;
  return workerRaw(url, body, {
    "content-type": "application/json",
    origin: new URL(url).origin,
  });
}

function workerJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return workerRaw(url, JSON.stringify(body), {
    "content-type": "application/json",
    ...headers,
  });
}

function workerRaw(url: string, body: string, headers: Record<string, string>): Promise<Response> {
  return exports.default.fetch(
    new Request(url, {
      method: "POST",
      headers,
      body,
    }),
  );
}
