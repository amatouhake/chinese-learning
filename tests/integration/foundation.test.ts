import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { ingestAttempt } from "../../src/db/ingestion";
import {
  FSRS_ALGORITHM,
  FSRS_IMPLEMENTATION,
  FSRS_IMPLEMENTATION_VERSION,
  createFsrsParameters,
  replayFsrsHistory,
} from "../../src/domain/fsrs";
import type {
  AttemptInput,
  CanonicalFsrsReview,
  FsrsCardProjection,
  SchedulerConfig,
} from "../../src/domain/types";
import { buildV1ImportStatements } from "../../src/db/v1-import";
import v1EnrichmentFixture from "../fixtures/v1-reference/data/llm_generated.json";
import vocabularyFixture from "../fixtures/v1-reference/wordlists/exclusive/old/1.json";

describe("D1 learning foundation", () => {
  test("representative v1 content imports with multiple readings and provenance", async () => {
    const statements = buildV1ImportStatements({
      lexemes: vocabularyFixture.map((lexeme) => ({ ...lexeme, hskLevel: 1 })),
      enrichments: v1EnrichmentFixture,
      vocabularyVersion: "fixture-vocabulary-commit",
      v1Version: "fixture-v1-commit",
    });

    await env.DB.batch(
      statements
        .filter((statement) => !statement.startsWith("PRAGMA"))
        .map((statement) => env.DB.prepare(statement)),
    );

    const imported = await env.DB.prepare(
      `SELECT l.simplified, COUNT(r.id) AS reading_count,
          SUM(r.is_preferred) AS preferred_count
         FROM lexemes l
         JOIN lexeme_readings r ON r.lexeme_id = l.id
         WHERE l.simplified = '大'
         GROUP BY l.id`,
    ).first<{ simplified: string; reading_count: number; preferred_count: number }>();
    expect(imported).toEqual({ simplified: "大", reading_count: 2, preferred_count: 1 });
    expect(await scalar("SELECT COUNT(*) FROM sentences WHERE source LIKE 'why-learn%'")).toBe(2);
    expect(
      await scalar("SELECT COUNT(*) FROM cards WHERE id LIKE 'card:lexeme:complete-hsk:%'"),
    ).toBe(4);
    expect(
      await scalar(
        "SELECT COUNT(*) FROM server_changes WHERE change_id = 'content-import:fixture-vocabulary-commit:fixture-v1-commit'",
      ),
    ).toBe(1);
  });

  test("normal scheduling persists an immutable attempt, 1:1 review, and card state", async () => {
    const fixture = await seedScheduledCard("normal");
    const input = scheduledInput(fixture, "normal-event", "2026-08-29T10:00:00Z", 1);

    const result = await ingestAttempt(env.DB, input, { now: () => timestamp("13:00") });

    expect(result.disposition).toBe("inserted");
    expect(result.reviewCreated).toBe(true);
    expect(result.cardState?.version).toBe(1);

    const persisted = await env.DB.prepare(
      `SELECT a.event_id, a.card_id, a.server_seq, r.attempt_id,
          r.scheduler_config_id, cs.version
         FROM attempts a
         JOIN fsrs_reviews r ON r.attempt_id = a.event_id
         JOIN card_state cs ON cs.card_id = a.card_id
         WHERE a.event_id = ?`,
    )
      .bind(input.eventId)
      .first<{
        event_id: string;
        card_id: string;
        server_seq: number;
        attempt_id: string;
        scheduler_config_id: string;
        version: number;
      }>();

    expect(persisted).toMatchObject({
      event_id: input.eventId,
      card_id: fixture.cardId,
      attempt_id: input.eventId,
      scheduler_config_id: fixture.config.id,
      version: 1,
    });
    expect(persisted?.server_seq).toBe(result.attemptServerSeq);
  });

  test("duplicate event delivery is idempotent and does not schedule twice", async () => {
    const fixture = await seedScheduledCard("duplicate");
    const input = scheduledInput(fixture, "duplicate-event", "2026-08-29T10:00:00Z", 1);

    const first = await ingestAttempt(env.DB, input, { now: () => timestamp("13:00") });
    const second = await ingestAttempt(env.DB, input, { now: () => timestamp("14:00") });

    expect(first.disposition).toBe("inserted");
    expect(second.disposition).toBe("duplicate");
    expect(second.attemptServerSeq).toBe(first.attemptServerSeq);
    expect(await count("attempts", "event_id", input.eventId)).toBe(1);
    expect(await count("fsrs_reviews", "attempt_id", input.eventId)).toBe(1);
    expect((await stateFor(fixture.cardId)).version).toBe(1);
  });

  test("an ordinary practice attempt remains history without mutating FSRS state", async () => {
    const fixture = await seedScheduledCard("practice-only");
    const scheduled = scheduledInput(fixture, "practice-only-event", "2026-08-29T10:00:00Z", 1);
    const input: AttemptInput = {
      ...scheduled,
      mode: "reflex",
      fsrsReview: undefined,
    };

    const result = await ingestAttempt(env.DB, input, { now: () => timestamp("13:00") });

    expect(result.reviewCreated).toBe(false);
    expect(result.cardState).toBeNull();
    expect(await count("attempts", "event_id", input.eventId)).toBe(1);
    expect(await count("fsrs_reviews", "attempt_id", input.eventId)).toBe(0);
    expect((await stateFor(fixture.cardId)).version).toBe(0);
  });

  test("late A/C/B arrival rebuilds the same persisted state as semantic-order ingestion", async () => {
    const fixture = await seedScheduledCard("late");
    const baseline = await seedScheduledCard("late-baseline", fixture.config, false);

    const a = scheduledInput(fixture, "late-A", "2026-08-29T10:00:00Z", 1);
    const c = scheduledInput(fixture, "late-C", "2026-08-29T11:00:00Z", 2, { rating: 4 });
    const b = scheduledInput(fixture, "late-B", "2026-08-29T12:00:00Z", 3, { rating: 2 });
    await ingestAttempt(env.DB, a, { now: () => timestamp("10:01") });
    await ingestAttempt(env.DB, b, { now: () => timestamp("12:01") });
    await ingestAttempt(env.DB, c, { now: () => timestamp("13:00") });

    const baselineA = scheduledInput(baseline, "baseline-A", "2026-08-29T10:00:00Z", 1, {
      deviceId: "baseline-device",
    });
    const baselineC = scheduledInput(baseline, "baseline-C", "2026-08-29T11:00:00Z", 2, {
      rating: 4,
      deviceId: "baseline-device",
    });
    const baselineB = scheduledInput(baseline, "baseline-B", "2026-08-29T12:00:00Z", 3, {
      rating: 2,
      deviceId: "baseline-device",
    });
    await ingestAttempt(env.DB, baselineA, { now: () => timestamp("10:01") });
    await ingestAttempt(env.DB, baselineC, { now: () => timestamp("11:01") });
    await ingestAttempt(env.DB, baselineB, { now: () => timestamp("12:01") });

    const order = await env.DB.prepare(
      `SELECT event_id FROM attempts
         WHERE card_id = ?
         ORDER BY occurred_at, device_id, device_seq, event_id`,
    )
      .bind(fixture.cardId)
      .all<{ event_id: string }>();
    expect(order.results.map((row) => row.event_id)).toEqual(["late-A", "late-C", "late-B"]);
    expect(project(await stateFor(fixture.cardId))).toEqual(
      project(await stateFor(baseline.cardId)),
    );
  });

  test("an offline review preserves config X after config Y becomes current", async () => {
    const fixture = await seedScheduledCard("config-preservation");
    const offline = scheduledInput(fixture, "offline-config-x", "2026-08-29T10:00:00Z", 1, {
      rating: 4,
    });
    const configY = schedulerConfig("config-preservation-y", 0.97, 1.8);
    await makeCurrentConfig(configY);

    await ingestAttempt(env.DB, offline, { now: () => timestamp("15:00") });

    const review = await env.DB.prepare(
      "SELECT scheduler_config_id FROM fsrs_reviews WHERE attempt_id = ?",
    )
      .bind(offline.eventId)
      .first<{ scheduler_config_id: string }>();
    const current = await env.DB.prepare(
      "SELECT id FROM scheduler_configs WHERE is_current = 1",
    ).first<{ id: string }>();
    expect(review?.scheduler_config_id).toBe(fixture.config.id);
    expect(current?.id).toBe(configY.id);

    const canonicalReview = canonical(offline);
    const usingX = replayFsrsHistory(
      [canonicalReview],
      new Map([[fixture.config.id, fixture.config]]),
    );
    const usingY = replayFsrsHistory(
      [{ ...canonicalReview, schedulerConfigId: configY.id }],
      new Map([[configY.id, configY]]),
    );
    expect(project(await stateFor(fixture.cardId))).toEqual(usingX);
    expect(usingX).not.toEqual(usingY);
  });

  test("D1 batch rollback leaves no partial attempt, review, state, cursor, or guard", async () => {
    const fixture = await seedScheduledCard("atomic");
    const input = scheduledInput(fixture, "atomic-failure", "2026-08-29T10:00:00Z", 1);
    const projectionDirtyBefore = await scalar(
      "SELECT dirty FROM projection_state WHERE singleton = 1",
    );

    await expect(
      ingestAttempt(env.DB, input, {
        now: () => timestamp("13:00"),
        forceFailureAfterWrites: true,
      }),
    ).rejects.toThrow();

    expect(await count("attempts", "event_id", input.eventId)).toBe(0);
    expect(await count("fsrs_reviews", "attempt_id", input.eventId)).toBe(0);
    expect(await changeCountFor(input.eventId)).toBe(0);
    expect((await stateFor(fixture.cardId)).version).toBe(0);
    expect((await scalar("SELECT COUNT(*) FROM atomic_write_guards")) ?? -1).toBe(0);
    expect(await scalar("SELECT dirty FROM projection_state WHERE singleton = 1")).toBe(
      projectionDirtyBefore,
    );
  });

  test("version conflict rolls back, retries, and resolves both concurrent events by replay", async () => {
    const fixture = await seedScheduledCard("concurrency");
    const outer = scheduledInput(fixture, "concurrent-A", "2026-08-29T10:00:00Z", 1, {
      deviceId: "phone-concurrency",
    });
    const interleaved = scheduledInput(fixture, "concurrent-B", "2026-08-29T11:00:00Z", 1, {
      deviceId: "desktop-concurrency",
      rating: 2,
    });
    let hasInterleaved = false;

    const result = await ingestAttempt(env.DB, outer, {
      now: () => timestamp("13:00"),
      beforeScheduledWrite: async () => {
        if (hasInterleaved) return;
        hasInterleaved = true;
        await ingestAttempt(env.DB, interleaved, { now: () => timestamp("12:00") });
      },
    });

    expect(result.disposition).toBe("inserted");
    expect(await count("attempts", "card_id", fixture.cardId)).toBe(2);
    expect(await count("fsrs_reviews", "card_id", fixture.cardId)).toBe(2);
    expect(await changeCountFor("concurrent-")).toBe(4);
    const finalState = await stateFor(fixture.cardId);
    expect(finalState.version).toBe(2);
    expect(project(finalState)).toEqual(
      replayFsrsHistory(
        [canonical(outer), canonical(interleaved)],
        new Map([[fixture.config.id, fixture.config]]),
      ),
    );
  });

  test("critical uniqueness, immutability, and scheduler constraints are enforced by D1", async () => {
    const fixture = await seedScheduledCard("constraints");
    const revision = fixture.revision;
    const readingInsert = (id: string) =>
      env.DB.prepare(
        `INSERT INTO lexeme_readings
            (id, lexeme_id, pinyin, numeric_pinyin, normalized_syllables_json,
             is_preferred, source, content_revision, created_at)
           VALUES (?, ?, 'ài', 'ai4', '["ai4"]', 1, 'test', ?, ?)`,
      ).bind(id, fixture.lexemeId, revision, timestamp("09:00"));
    await readingInsert("constraints-reading-1").run();
    await expect(readingInsert("constraints-reading-2").run()).rejects.toThrow();

    const input = scheduledInput(fixture, "constraint-event", "2026-08-29T10:00:00Z", 1);
    await ingestAttempt(env.DB, input, { now: () => timestamp("13:00") });
    await expect(
      env.DB.prepare("UPDATE attempts SET correct = 0 WHERE event_id = ?")
        .bind(input.eventId)
        .run(),
    ).rejects.toThrow("attempts are immutable");
    await expect(
      env.DB.prepare("UPDATE scheduler_configs SET desired_retention = 0.7 WHERE id = ?")
        .bind(fixture.config.id)
        .run(),
    ).rejects.toThrow("immutable");

    const reusedSequence = {
      ...input,
      eventId: "constraint-reused-sequence",
      occurredAt: "2026-08-29T11:00:00Z",
    };
    await expect(
      ingestAttempt(env.DB, reusedSequence, { now: () => timestamp("14:00") }),
    ).rejects.toThrow();
    expect((await stateFor(fixture.cardId)).version).toBe(1);
  });

  test("Hono Worker exposes the API and reserved MCP boundaries in workerd", async () => {
    const health = await exports.default.fetch(new Request("https://example.test/api/health"));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true });

    const mcp = await exports.default.fetch(new Request("https://example.test/mcp"));
    expect(mcp.status).toBe(501);
  });
});

interface Fixture {
  cardId: string;
  lexemeId: string;
  revision: number;
  config: SchedulerConfig;
}

interface StateRow {
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
}

async function seedScheduledCard(
  prefix: string,
  config = schedulerConfig(`${prefix}-config`, 0.8, 1),
  insertConfig = true,
): Promise<Fixture> {
  const lexemeId = `${prefix}-lexeme`;
  const cardId = `${prefix}-card`;
  const createdAt = timestamp("09:00");
  const revisionResult = await env.DB.prepare(
    `INSERT INTO content_revisions (source, source_version, description, created_at)
       VALUES ('integration-test', ?, 'test fixture', ?)`,
  )
    .bind(prefix, createdAt)
    .run();
  const revision = Number(revisionResult.meta.last_row_id);

  if (insertConfig) await makeCurrentConfig(config);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO lexemes
          (id, simplified, traditional, meanings_json, pos_json, source,
           content_revision, created_at, updated_at)
         VALUES (?, '爱', '愛', '["love"]', '["verb"]', 'integration-test', ?, ?, ?)`,
    ).bind(lexemeId, revision, createdAt, createdAt),
    env.DB.prepare(
      `INSERT INTO cards
          (id, subject_type, lexeme_id, activity_type, scheduler_eligible,
           content_revision, created_at)
         VALUES (?, 'lexeme', ?, 'hanzi_to_meaning', 1, ?, ?)`,
    ).bind(cardId, lexemeId, revision, createdAt),
    env.DB.prepare(
      `INSERT INTO card_state
          (card_id, due_at, rebuilt_at)
         VALUES (?, ?, ?)`,
    ).bind(cardId, createdAt, createdAt),
  ]);
  return { cardId, lexemeId, revision, config };
}

async function makeCurrentConfig(config: SchedulerConfig): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE scheduler_configs SET is_current = 0 WHERE is_current = 1"),
    env.DB.prepare(
      `INSERT INTO scheduler_configs
          (id, algorithm, implementation, implementation_version, parameters_json,
           desired_retention, is_current, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    ).bind(
      config.id,
      config.algorithm,
      config.implementation,
      config.implementationVersion,
      JSON.stringify(config.parameters),
      config.desiredRetention,
      timestamp("09:00"),
    ),
  ]);
}

function schedulerConfig(id: string, retention: number, weightScale: number): SchedulerConfig {
  const defaults = createFsrsParameters(retention);
  return {
    id,
    algorithm: FSRS_ALGORITHM,
    implementation: FSRS_IMPLEMENTATION,
    implementationVersion: FSRS_IMPLEMENTATION_VERSION,
    parameters: createFsrsParameters(retention, {
      w: defaults.w.map((weight, index) => (index < 4 ? weight * weightScale : weight)),
    }),
    desiredRetention: retention,
  };
}

function scheduledInput(
  fixture: Fixture,
  eventId: string,
  occurredAt: string,
  deviceSeq: number,
  overrides: { rating?: 1 | 2 | 3 | 4; deviceId?: string } = {},
): AttemptInput {
  return {
    eventId,
    deviceId: overrides.deviceId ?? `${fixture.cardId}-device`,
    deviceSeq,
    occurredAt,
    cardId: fixture.cardId,
    mode: "study",
    activityType: "hanzi_to_meaning",
    correct: true,
    responseMs: 850,
    fsrsReview: {
      rating: overrides.rating ?? 3,
      schedulerConfigId: fixture.config.id,
    },
  };
}

function canonical(input: AttemptInput): CanonicalFsrsReview {
  if (!input.fsrsReview) throw new Error("test input is missing an FSRS review");
  return {
    eventId: input.eventId,
    cardId: input.cardId,
    deviceId: input.deviceId,
    deviceSeq: input.deviceSeq,
    occurredAt: Date.parse(input.occurredAt),
    rating: input.fsrsReview.rating,
    schedulerConfigId: input.fsrsReview.schedulerConfigId,
  };
}

async function stateFor(cardId: string): Promise<StateRow> {
  const row = await env.DB.prepare(
    `SELECT due_at, stability, difficulty, elapsed_days, scheduled_days,
        learning_steps, reps, lapses, state, last_review_at, version
       FROM card_state WHERE card_id = ?`,
  )
    .bind(cardId)
    .first<StateRow>();
  if (!row) throw new Error(`missing test card state: ${cardId}`);
  return row;
}

function project(row: StateRow): FsrsCardProjection {
  return {
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
  };
}

async function count(table: string, column: string, value: string): Promise<number> {
  const allowed = new Set([
    "attempts:event_id",
    "attempts:card_id",
    "fsrs_reviews:attempt_id",
    "fsrs_reviews:card_id",
  ]);
  if (!allowed.has(`${table}:${column}`)) throw new Error("unsafe test count query");
  return (await scalar(`SELECT COUNT(*) FROM ${table} WHERE ${column} = ?`, value)) ?? 0;
}

async function changeCountFor(fragment: string): Promise<number> {
  return (
    (await scalar("SELECT COUNT(*) FROM server_changes WHERE change_id LIKE ?", `%${fragment}%`)) ??
    0
  );
}

async function scalar(sql: string, value?: string): Promise<number | null> {
  const statement = value === undefined ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(value);
  const result = await statement.first<Record<string, number>>();
  return result ? (Object.values(result)[0] ?? null) : null;
}

function timestamp(time: string): number {
  return Date.parse(`2026-08-29T${time}:00Z`);
}
