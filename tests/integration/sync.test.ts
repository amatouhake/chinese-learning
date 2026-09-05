import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, test } from "vitest";
import { FIXED_OWNER_LEARNER_ID } from "../../src/worker/current-learner";

import { ingestAttempt } from "../../src/db/ingestion";
import { createStudySession } from "../../src/db/study";
import { createPronunciationSession } from "../../src/db/pronunciation";
import { buildPronunciationImportStatements } from "../../src/db/pronunciation-import";
import { pullSyncChanges } from "../../src/db/sync";
import { buildV1ImportStatements, type V1ImportInput } from "../../src/db/v1-import";
import { DEFAULT_SCHEDULER_CONFIG_ID } from "../../src/domain/fsrs";
import {
  CURRENT_PRACTICE_CONTRACT_VERSIONS,
  LEGACY_PRACTICE_CONTRACT_VERSIONS,
} from "../../src/domain/practice-contract";
import type { AttemptInput, StudyCard } from "../../src/domain/types";

describe("offline sync contract", () => {
  afterEach(async () => {
    await retireFixtureLexemes(["游标一", "游标二", "配置", "离线"]);
  });

  test("bulk-loads a full learner-change page within the D1 Free query budget", async () => {
    await env.DB.prepare("INSERT INTO learner_devices (id, learner_id) VALUES (?, ?)")
      .bind("bulk-device", FIXED_OWNER_LEARNER_ID)
      .run();
    await env.DB.prepare(
      `WITH RECURSIVE numbers(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM numbers WHERE value < 101
       )
       INSERT INTO study_sessions
         (id, learner_id, device_id, mode, started_at, context_json)
       SELECT printf('bulk-session-%03d', value), ?, 'bulk-device',
         CASE WHEN value % 2 = 0 THEN 'pronunciation' ELSE 'study' END,
         value, '{}'
       FROM numbers`,
    )
      .bind(FIXED_OWNER_LEARNER_ID)
      .run();
    await env.DB.prepare(
      `WITH RECURSIVE numbers(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM numbers WHERE value < 101
       )
       INSERT INTO server_changes
         (change_id, learner_id, entity_type, entity_id, operation, changed_at)
       SELECT printf('bulk-change-%03d', value), ?, 'study_session',
         printf('bulk-session-%03d', value), 'upsert', value
       FROM numbers`,
    )
      .bind(FIXED_OWNER_LEARNER_ID)
      .run();

    try {
      const measured = measurePreparedQueries(env.DB);
      const first = await pullSyncChanges(measured.database, FIXED_OWNER_LEARNER_ID, {
        cursor: 0,
        contentRevision: null,
        deviceId: "bulk-device",
      });
      expect(first.learnerChanges).toHaveLength(100);
      expect(first.hasMore).toBe(true);
      expect(first.learnerChanges[0]).toMatchObject({
        entityType: "study_session",
        sessionId: "bulk-session-001",
        mode: "study",
      });
      expect(measured.count()).toBe(3);

      const second = await pullSyncChanges(measured.database, FIXED_OWNER_LEARNER_ID, {
        cursor: first.nextCursor,
        contentRevision: first.currentContentRevision,
        deviceId: "bulk-device",
      });
      expect(second.learnerChanges).toHaveLength(1);
      expect(second.hasMore).toBe(false);
      expect(measured.count()).toBe(6);
    } finally {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM server_changes WHERE change_id LIKE 'bulk-change-%'"),
        env.DB.prepare("DELETE FROM study_sessions WHERE device_id = 'bulk-device'"),
        env.DB.prepare("DELETE FROM learner_devices WHERE id = 'bulk-device'"),
      ]);
    }
  });

  test("pulls bounded canonical changes by cursor and duplicate delivery adds no change", async () => {
    await applyImport("cursor", [lexeme("游标一", 1), lexeme("游标二", 2)]);
    await createStudySession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "cursor-session",
      deviceId: "cursor-device",
      maxCards: 3,
    });

    const initial = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
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

    expect((await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, attempt)).disposition).toBe(
      "inserted",
    );
    const incremental = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
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
    expect((await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, attempt)).disposition).toBe(
      "duplicate",
    );
    const afterDuplicate = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
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
    await createStudySession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "config-session",
      deviceId: "config-device",
      maxCards: 1,
    });
    const cached = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
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
    await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, attempt);
    expect(
      await env.DB.prepare("SELECT scheduler_config_id FROM fsrs_reviews WHERE attempt_id = ?")
        .bind(attempt.eventId)
        .first(),
    ).toEqual({ scheduler_config_id: DEFAULT_SCHEDULER_CONFIG_ID });
  });

  test("a content revision and newer online review do not rewrite a pending older review", async () => {
    await applyImport("pending-a", [lexeme("离线", 1)]);
    await Promise.all([
      createStudySession(env.DB, FIXED_OWNER_LEARNER_ID, {
        sessionId: "late-offline-session",
        deviceId: "late-offline-device",
        maxCards: 1,
      }),
      createStudySession(env.DB, FIXED_OWNER_LEARNER_ID, {
        sessionId: "late-online-session",
        deviceId: "late-online-device",
        maxCards: 1,
      }),
    ]);
    const offlinePull = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
      cursor: 0,
      contentRevision: null,
      deviceId: "late-offline-device",
      studySessionId: "late-offline-session",
    });
    const offlineCard = requiredCard(offlinePull.studyPack?.cards[0]);
    const onlinePull = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
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
    await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, newer, {
      now: () => Date.parse("2026-08-30T05:00:01Z"),
    });

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
    await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, older, {
      now: () => Date.parse("2026-08-30T05:10:00Z"),
    });

    const converged = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
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
      cardState: { cardId: offlineCard.cardId, version: offlineCard.state.version + 2 },
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

  test("handshakes practice contracts independently from content revision", async () => {
    const contractLexemes = [lexeme("游标一", 1), lexeme("游标二", 2)];
    await applyImport("contract", contractLexemes);
    await env.DB.batch(
      (
        await buildPronunciationImportStatements({
          lexemes: contractLexemes,
          vocabularyVersion: "contract-vocabulary",
          audioVersion: "contract-audio",
          audioItems: contractLexemes.map((item) => ({
            simplified: item.simplified,
            status: "missing" as const,
          })),
        })
      )
        .filter((statement) => !statement.startsWith("PRAGMA"))
        .map((statement) => env.DB.prepare(statement)),
    );
    await createStudySession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "contract-study-session",
      deviceId: "contract-device",
      maxCards: 1,
    });
    await createPronunciationSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "contract-pronunciation-session",
      deviceId: "contract-device",
      focus: "pinyin",
      maxItems: 1,
      practiceContractVersion: CURRENT_PRACTICE_CONTRACT_VERSIONS.pronunciation,
    });

    const legacy = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
      cursor: 0,
      contentRevision: null,
      deviceId: "contract-device",
      studySessionId: "contract-study-session",
      pronunciationSessionId: "contract-pronunciation-session",
      practiceContracts: { ...LEGACY_PRACTICE_CONTRACT_VERSIONS },
    });
    expect(legacy.currentPracticeContracts).toEqual(CURRENT_PRACTICE_CONTRACT_VERSIONS);
    expect(legacy.practiceUpdateRequiredModes).toContain("pronunciation");
    expect(legacy.studyPack).toMatchObject({ status: "cards" });
    expect(legacy.pronunciationPack).toBeNull();

    const legacyHttp = await localJson("/api/sync/pull", {
      cursor: 0,
      contentRevision: null,
      deviceId: "contract-device",
      pronunciationSessionId: "contract-pronunciation-session",
    });
    expect(legacyHttp.status).toBe(200);
    await expect(legacyHttp.json()).resolves.toMatchObject({
      practiceUpdateRequiredModes: ["pronunciation"],
      pronunciationPack: null,
    });

    const current = await pullSyncChanges(env.DB, FIXED_OWNER_LEARNER_ID, {
      cursor: legacy.nextCursor,
      contentRevision: legacy.currentContentRevision,
      deviceId: "contract-device",
      studySessionId: "contract-study-session",
      pronunciationSessionId: "contract-pronunciation-session",
      practiceContracts: { ...CURRENT_PRACTICE_CONTRACT_VERSIONS },
    });
    expect(current.contentChanged).toBe(false);
    expect(current.practiceUpdateRequiredModes).toEqual([]);
    expect(current.pronunciationPack).toMatchObject({
      status: "cards",
      practiceContractVersion: CURRENT_PRACTICE_CONTRACT_VERSIONS.pronunciation,
    });
    expect(current.pronunciationPack?.cards[0]?.activityType).not.toBe("pronunciation_production");
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

async function retireFixtureLexemes(simplified: string[]): Promise<void> {
  const ids = simplified.map((value) => `lexeme:complete-hsk:${encodeURIComponent(value)}`);
  await env.DB.prepare(
    `UPDATE cards SET retired_at = created_at
     WHERE lexeme_id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .run();
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

function measurePreparedQueries(database: D1Database): {
  database: D1Database;
  count: () => number;
} {
  let count = 0;
  return {
    database: new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            count += 1;
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    count: () => count,
  };
}
