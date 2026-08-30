import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { ingestAttempt } from "../../src/db/ingestion";
import { createStudySession, getNextStudyCard } from "../../src/db/study";
import {
  buildV1ImportStatements,
  type V1ImportInput,
  type V1SourceLexeme,
} from "../../src/db/v1-import";
import { DEFAULT_SCHEDULER_CONFIG_ID } from "../../src/domain/fsrs";
import type { AttemptInput, StudyNextResult } from "../../src/domain/types";

describe("vocabulary study flow", () => {
  test("selects progressed due cards before deterministic new cards", async () => {
    await applyImport("due-priority", [lexeme("先", 1), lexeme("后", 2)]);
    const dueCardId = cardId("先", "hanzi_to_meaning");
    const reviewTime = Date.parse("2026-08-29T08:00:00Z");
    await ingestAttempt(
      env.DB,
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
      { sessionId: "due-priority-session", deviceId: "due-priority-device", maxCards: 4 },
      { now: () => now },
    );
    const next = await getNextStudyCard(env.DB, "due-priority-session", "due-priority-device", {
      now: () => now,
    });

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
    await retireLexemes(["爱"]);
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

async function applyImport(prefix: string, lexemes: V1SourceLexeme[]): Promise<void> {
  const input: V1ImportInput = {
    lexemes,
    enrichments: [],
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
