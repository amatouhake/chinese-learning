import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { ingestAttempt } from "../../src/db/ingestion";
import { createStudySession } from "../../src/db/study";
import { pullSyncChanges } from "../../src/db/sync";
import { buildV1ImportStatements, type V1ImportInput } from "../../src/db/v1-import";
import { DEFAULT_SCHEDULER_CONFIG_ID } from "../../src/domain/fsrs";
import type { AttemptInput, StudyCard, SyncPullResponse } from "../../src/domain/types";

describe("offline sync contract", () => {
  test("pulls bounded canonical changes by cursor and duplicate delivery adds no change", async () => {
    await applyImport("cursor", [lexeme("游标一", 1), lexeme("游标二", 2)]);
    await createStudySession(env.DB, {
      sessionId: "cursor-session",
      deviceId: "cursor-device",
      maxCards: 3,
    });

    const initial = await pullSyncChanges(env.DB, {
      cursor: 0,
      contentRevision: null,
      deviceId: "cursor-device",
      studySessionId: "cursor-session",
    });
    expect(initial.nextCursor).toBeGreaterThan(0);
    expect(initial.contentChanged).toBe(true);
    expect(initial.contentChanges).toHaveLength(1);
    expect(initial.studyPack).toMatchObject({ status: "cards", cards: { length: 3 } });
    const card = requiredCard(initial.studyPack?.cards[0]);
    const attempt = scheduledAttempt(card, {
      eventId: "cursor-event",
      deviceId: "cursor-device",
      deviceSeq: 1,
      studySessionId: "cursor-session",
      occurredAt: "2026-08-30T02:00:00Z",
    });

    expect((await ingestAttempt(env.DB, attempt)).disposition).toBe("inserted");
    const incremental = await pullSyncChanges(env.DB, {
      cursor: initial.nextCursor,
      contentRevision: initial.currentContentRevision,
      deviceId: "cursor-device",
      studySessionId: "cursor-session",
    });
    expect(incremental.contentChanged).toBe(false);
    expect(incremental.learnerChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityType: "attempt", eventId: "cursor-event" }),
        expect.objectContaining({
          entityType: "card_state",
          cardState: expect.objectContaining({ version: 1 }),
        }),
      ]),
    );
    const duplicateCursor = incremental.nextCursor;
    expect((await ingestAttempt(env.DB, attempt)).disposition).toBe("duplicate");
    const afterDuplicate = await pullSyncChanges(env.DB, {
      cursor: duplicateCursor,
      contentRevision: incremental.currentContentRevision,
      deviceId: "cursor-device",
    });
    expect(afterDuplicate.nextCursor).toBe(duplicateCursor);
    expect(afterDuplicate.learnerChanges).toEqual([]);

    const endpoint = await localJson("/api/sync/pull", {
      cursor: initial.nextCursor,
      contentRevision: initial.currentContentRevision,
      deviceId: "cursor-device",
      studySessionId: "cursor-session",
    });
    expect(endpoint.status).toBe(200);
    await expect(endpoint.json()).resolves.toMatchObject({
      nextCursor: incremental.nextCursor,
      contentChanged: false,
    });
  });

  test("offline vocabulary facts preserve the scheduler selected before configuration changes", async () => {
    await applyImport("config", [lexeme("配置", 1)]);
    await createStudySession(env.DB, {
      sessionId: "config-session",
      deviceId: "config-device",
      maxCards: 1,
    });
    const cached = await pullSyncChanges(env.DB, {
      cursor: 0,
      contentRevision: null,
      deviceId: "config-device",
      studySessionId: "config-session",
    });
    const card = requiredCard(cached.studyPack?.cards[0]);
    expect(card.schedulerConfigId).toBe(DEFAULT_SCHEDULER_CONFIG_ID);

    await env.DB.batch([
      env.DB.prepare("UPDATE scheduler_configs SET is_current = 0 WHERE is_current = 1"),
      env.DB.prepare(
        `INSERT INTO scheduler_configs
          (id, algorithm, implementation, implementation_version, parameters_json,
           desired_retention, is_current, created_at, optimization_metadata_json)
         SELECT 'fsrs-6:ts-fsrs@5.4.1:default:0.90:test-next', algorithm, implementation,
           implementation_version, parameters_json, desired_retention, 1, 1,
           '{"kind":"sync-test"}'
         FROM scheduler_configs WHERE id = ?`,
      ).bind(DEFAULT_SCHEDULER_CONFIG_ID),
    ]);

    const attempt = scheduledAttempt(card, {
      eventId: "config-offline-event",
      deviceId: "config-device",
      deviceSeq: 1,
      studySessionId: "config-session",
      occurredAt: "2026-08-30T03:00:00Z",
    });
    await ingestAttempt(env.DB, attempt);
    expect(
      await env.DB.prepare("SELECT scheduler_config_id FROM fsrs_reviews WHERE attempt_id = ?")
        .bind(attempt.eventId)
        .first(),
    ).toEqual({ scheduler_config_id: DEFAULT_SCHEDULER_CONFIG_ID });
  });

  test("a content revision and newer online review do not rewrite a pending older review", async () => {
    await applyImport("pending-a", [lexeme("离线", 1)]);
    await Promise.all([
      createStudySession(env.DB, {
        sessionId: "late-offline-session",
        deviceId: "late-offline-device",
        maxCards: 1,
      }),
      createStudySession(env.DB, {
        sessionId: "late-online-session",
        deviceId: "late-online-device",
        maxCards: 1,
      }),
    ]);
    const offlinePull = await pullSyncChanges(env.DB, {
      cursor: 0,
      contentRevision: null,
      deviceId: "late-offline-device",
      studySessionId: "late-offline-session",
    });
    const offlineCard = requiredCard(offlinePull.studyPack?.cards[0]);
    const onlinePull = await pullSyncChanges(env.DB, {
      cursor: 0,
      contentRevision: null,
      deviceId: "late-online-device",
      studySessionId: "late-online-session",
    });
    const onlineCard = requiredCard(
      onlinePull.studyPack?.cards.find((candidate) => candidate.cardId === offlineCard.cardId),
    );
    const newer = scheduledAttempt(onlineCard, {
      eventId: "late-newer-online",
      deviceId: "late-online-device",
      deviceSeq: 1,
      studySessionId: "late-online-session",
      occurredAt: "2026-08-30T05:00:00Z",
      rating: 4,
    });
    await ingestAttempt(env.DB, newer, { now: () => Date.parse("2026-08-30T05:00:01Z") });

    await applyImport("pending-b", [
      {
        ...lexeme("离线", 1),
        forms: [{ ...lexeme("离线", 1).forms[0]!, meanings: ["offline revised"] }],
      },
    ]);
    const older = scheduledAttempt(offlineCard, {
      eventId: "late-older-offline",
      deviceId: "late-offline-device",
      deviceSeq: 1,
      studySessionId: "late-offline-session",
      occurredAt: "2026-08-30T04:00:00Z",
      rating: 2,
    });
    await ingestAttempt(env.DB, older, { now: () => Date.parse("2026-08-30T05:10:00Z") });

    const converged = await pullSyncChanges(env.DB, {
      cursor: offlinePull.nextCursor,
      contentRevision: offlinePull.currentContentRevision,
      deviceId: "late-offline-device",
      studySessionId: "late-offline-session",
    });
    expect(converged.contentChanged).toBe(true);
    expect(converged.contentChanges.length).toBeGreaterThan(0);
    const canonicalState = converged.learnerChanges
      .filter((change) => change.entityType === "card_state")
      .at(-1);
    expect(canonicalState).toMatchObject({
      entityType: "card_state",
      cardState: { cardId: offlineCard.cardId, version: 2 },
    });
    expect(
      await env.DB.prepare(
        `SELECT a.event_id, a.occurred_at, r.rating, r.scheduler_config_id
         FROM attempts a JOIN fsrs_reviews r ON r.attempt_id = a.event_id
         WHERE a.card_id = ? ORDER BY r.semantic_order_key`,
      )
        .bind(offlineCard.cardId)
        .all(),
    ).toMatchObject({
      results: [
        {
          event_id: "late-older-offline",
          occurred_at: Date.parse("2026-08-30T04:00:00Z"),
          rating: 2,
          scheduler_config_id: offlineCard.schedulerConfigId,
        },
        {
          event_id: "late-newer-online",
          occurred_at: Date.parse("2026-08-30T05:00:00Z"),
          rating: 4,
          scheduler_config_id: onlineCard.schedulerConfigId,
        },
      ],
    });
  });
});

async function applyImport(prefix: string, lexemes: V1ImportInput["lexemes"]): Promise<void> {
  const statements = await buildV1ImportStatements({
    lexemes,
    enrichments: [],
    vocabularyVersion: `${prefix}-vocabulary`,
    v1Version: `${prefix}-v1`,
    createdAt: Date.parse("2026-08-30T01:00:00Z"),
  });
  await env.DB.batch(
    statements
      .filter((statement) => !statement.startsWith("PRAGMA"))
      .map((statement) => env.DB.prepare(statement)),
  );
}

function lexeme(simplified: string, frequency: number): V1ImportInput["lexemes"][number] {
  return {
    simplified,
    frequency,
    hskLevel: 1,
    forms: [
      {
        traditional: simplified,
        transcriptions: { pinyin: "lí xiàn", numeric: "li2 xian4" },
        meanings: [`${simplified} meaning`],
      },
    ],
  };
}

function requiredCard(card: StudyCard | undefined): StudyCard {
  if (!card) throw new Error("test offline pack has no card");
  return card;
}

function scheduledAttempt(
  card: StudyCard,
  input: {
    eventId: string;
    deviceId: string;
    deviceSeq: number;
    studySessionId: string;
    occurredAt: string;
    rating?: 1 | 2 | 3 | 4;
  },
): AttemptInput {
  return {
    eventId: input.eventId,
    deviceId: input.deviceId,
    deviceSeq: input.deviceSeq,
    occurredAt: input.occurredAt,
    cardId: card.cardId,
    studySessionId: input.studySessionId,
    mode: "study",
    activityType: card.activityType,
    expectedCardStateVersion: card.state.version,
    metadata: { interaction: "offline-test", queueSource: card.source },
    fsrsReview: {
      rating: input.rating ?? 3,
      schedulerConfigId: card.schedulerConfigId,
    },
  };
}

function localJson(path: string, body: unknown): Promise<Response> {
  const url = `http://127.0.0.1${path}`;
  return exports.default.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: new URL(url).origin,
      },
      body: JSON.stringify(body),
    }),
  );
}
