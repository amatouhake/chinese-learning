import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { ingestAttempt } from "../../src/db/ingestion";
import {
  DEFAULT_SCHEDULER_CONFIG_ID,
  FSRS_ALGORITHM,
  FSRS_IMPLEMENTATION,
  FSRS_IMPLEMENTATION_VERSION,
  createFsrsParameters,
  replayFsrsHistory,
} from "../../src/domain/fsrs";
import { compareCanonicalReviews, semanticOrderKey } from "../../src/domain/ordering";
import type {
  AttemptInput,
  CanonicalFsrsReview,
  FsrsCardProjection,
  SchedulerConfig,
} from "../../src/domain/types";
import {
  buildV1ImportStatements,
  deriveV1ImportIdentity,
  type V1ImportInput,
  type V1SourceLexeme,
} from "../../src/db/v1-import";
import v1EnrichmentFixture from "../fixtures/v1-reference/data/llm_generated.json";
import vocabularyFixture from "../fixtures/v1-reference/wordlists/exclusive/old/1.json";

describe("D1 learning foundation", () => {
  test("fresh migrations and representative import provide a usable default scheduler", async () => {
    const importInput: V1ImportInput = {
      lexemes: vocabularyFixture.map((lexeme) => ({ ...lexeme, hskLevel: 1 })),
      enrichments: v1EnrichmentFixture,
      vocabularyVersion: "fixture-vocabulary-commit",
      v1Version: "fixture-v1-commit",
    };
    const identity = await deriveV1ImportIdentity(importInput);

    await applyImport(importInput);

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
      await scalar("SELECT COUNT(*) FROM server_changes WHERE change_id = ?", identity.changeId),
    ).toBe(1);

    const config = await env.DB.prepare(
      `SELECT id, algorithm, implementation, implementation_version,
          parameters_json, desired_retention, is_current
         FROM scheduler_configs WHERE id = ?`,
    )
      .bind(DEFAULT_SCHEDULER_CONFIG_ID)
      .first<{
        id: string;
        algorithm: string;
        implementation: string;
        implementation_version: string;
        parameters_json: string;
        desired_retention: number;
        is_current: number;
      }>();
    expect(config).toMatchObject({
      id: DEFAULT_SCHEDULER_CONFIG_ID,
      algorithm: FSRS_ALGORITHM,
      implementation: FSRS_IMPLEMENTATION,
      implementation_version: FSRS_IMPLEMENTATION_VERSION,
      desired_retention: 0.9,
      is_current: 1,
    });
    expect(JSON.parse(config?.parameters_json ?? "null")).toEqual(createFsrsParameters(0.9));

    const cardId = "card:lexeme:complete-hsk:%E5%A4%A7:hanzi_to_meaning";
    const attempt: AttemptInput = {
      eventId: "fresh-bootstrap-review",
      deviceId: "fresh-bootstrap-device",
      deviceSeq: 1,
      occurredAt: "2026-08-29T10:00:00Z",
      cardId,
      mode: "study",
      activityType: "hanzi_to_meaning",
      correct: true,
      fsrsReview: { rating: 3, schedulerConfigId: DEFAULT_SCHEDULER_CONFIG_ID },
    };
    const result = await ingestAttempt(env.DB, attempt, { now: () => timestamp("10:01") });
    expect(result).toMatchObject({ disposition: "inserted", reviewCreated: true });
    expect(await count("attempts", "event_id", attempt.eventId)).toBe(1);
    expect(await count("fsrs_reviews", "attempt_id", attempt.eventId)).toBe(1);
  });

  test("content-addressed import revisions distinguish partial and full scope", async () => {
    const lexemes = scopedLexemes("scope");
    const base = {
      enrichments: [],
      vocabularyVersion: "scope-vocabulary-commit",
      v1Version: "scope-v1-commit",
      createdAt: timestamp("09:00"),
    } satisfies Omit<V1ImportInput, "lexemes">;
    const partial = { ...base, lexemes: lexemes.slice(0, 1) };
    const full = { ...base, lexemes };
    const partialIdentity = await deriveV1ImportIdentity(partial);
    const samePartialIdentity = await deriveV1ImportIdentity({ ...partial });
    const fullIdentity = await deriveV1ImportIdentity(full);

    expect(samePartialIdentity).toEqual(partialIdentity);
    expect(fullIdentity.contentDigest).not.toBe(partialIdentity.contentDigest);

    await applyImport(partial);
    const partialCursor = (await scalar("SELECT MAX(seq) FROM server_changes")) ?? 0;
    const revisionCountAfterPartial = await scalar(
      "SELECT COUNT(*) FROM content_revisions WHERE source_version LIKE 'complete-hsk-vocabulary@scope-vocabulary-commit;%'",
    );
    await applyImport(partial);
    expect(
      await scalar(
        "SELECT COUNT(*) FROM content_revisions WHERE source_version LIKE 'complete-hsk-vocabulary@scope-vocabulary-commit;%'",
      ),
    ).toBe(revisionCountAfterPartial);
    expect(await scalar("SELECT MAX(seq) FROM server_changes")).toBe(partialCursor);

    await applyImport(full);
    const fullCursor = (await scalar("SELECT MAX(seq) FROM server_changes")) ?? 0;
    const fullRevision = await scalar(
      "SELECT revision FROM content_revisions WHERE source_version = ?",
      fullIdentity.sourceVersion,
    );
    expect(fullCursor).toBeGreaterThan(partialCursor);
    expect(fullRevision).not.toBeNull();
    expect(
      await scalar(
        "SELECT COUNT(*) FROM server_changes WHERE change_id = ?",
        fullIdentity.changeId,
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) FROM server_changes WHERE seq > ? AND change_id = ?",
        partialCursor,
        fullIdentity.changeId,
      ),
    ).toBe(1);

    await applyImport(partial);
    expect(await scalar("SELECT MAX(seq) FROM server_changes")).toBe(fullCursor);
    expect(
      await scalar("SELECT current_content_revision FROM learner_settings WHERE singleton = 1"),
    ).toBe(fullRevision);
    expect(
      await scalar(
        "SELECT COUNT(*) FROM lexemes WHERE simplified LIKE '测scope%' AND content_revision = ?",
        fullRevision ?? -1,
      ),
    ).toBe(2);
  });

  test("a completed content import is a true no-op when only createdAt changes", async () => {
    const [lexeme] = scopedLexemes("completed-noop");
    if (!lexeme) throw new Error("missing completed-import test fixture");
    const initial = {
      lexemes: [lexeme],
      enrichments: [],
      vocabularyVersion: "completed-noop-vocabulary-commit",
      v1Version: "completed-noop-v1-commit",
      createdAt: timestamp("09:00"),
    } satisfies V1ImportInput;
    const regenerated = { ...initial, createdAt: timestamp("16:00") } satisfies V1ImportInput;
    const initialIdentity = await deriveV1ImportIdentity(initial);
    const regeneratedIdentity = await deriveV1ImportIdentity(regenerated);
    const lexemeId = `lexeme:complete-hsk:${encodeURIComponent(lexeme.simplified)}`;

    expect(regeneratedIdentity).toEqual(initialIdentity);
    await applyImport(initial);
    const snapshot = await env.DB.prepare(
      `SELECT
         l.updated_at AS lexeme_updated_at,
         cr.created_at AS revision_created_at,
         ls.updated_at AS settings_updated_at,
         ls.current_content_revision
       FROM lexemes l
       JOIN learner_settings ls ON ls.singleton = 1
       JOIN content_revisions cr ON cr.revision = ls.current_content_revision
       WHERE l.id = ?`,
    )
      .bind(lexemeId)
      .first<{
        lexeme_updated_at: number;
        revision_created_at: number;
        settings_updated_at: number;
        current_content_revision: number;
      }>();
    const cursor = await scalar("SELECT MAX(seq) FROM server_changes");

    await applyImport(regenerated);
    expect(
      await env.DB.prepare(
        `SELECT
           l.updated_at AS lexeme_updated_at,
           cr.created_at AS revision_created_at,
           ls.updated_at AS settings_updated_at,
           ls.current_content_revision
         FROM lexemes l
         JOIN learner_settings ls ON ls.singleton = 1
         JOIN content_revisions cr ON cr.revision = ls.current_content_revision
         WHERE l.id = ?`,
      )
        .bind(lexemeId)
        .first(),
    ).toEqual(snapshot);
    expect(await scalar("SELECT MAX(seq) FROM server_changes")).toBe(cursor);
    expect(
      await scalar(
        "SELECT COUNT(*) FROM server_changes WHERE change_id = ?",
        initialIdentity.changeId,
      ),
    ).toBe(1);
  });

  test("a revised import atomically changes the one preferred reading", async () => {
    const [lexeme] = scopedLexemes("preferred");
    if (!lexeme) throw new Error("missing preferred-reading test fixture");
    const first = {
      lexemes: [lexeme],
      enrichments: [],
      vocabularyVersion: "preferred-vocabulary-commit-a",
      v1Version: "preferred-v1-commit",
      createdAt: timestamp("09:00"),
    } satisfies V1ImportInput;
    const revised = {
      ...first,
      vocabularyVersion: "preferred-vocabulary-commit-b",
      lexemes: [{ ...lexeme, forms: [...lexeme.forms].reverse() }],
    } satisfies V1ImportInput;
    const firstIdentity = await deriveV1ImportIdentity(first);
    const revisedIdentity = await deriveV1ImportIdentity(revised);

    await applyImport(first);
    await applyImport(revised);

    const readings = await env.DB.prepare(
      `SELECT numeric_pinyin, is_preferred
         FROM lexeme_readings
         WHERE lexeme_id = ?
         ORDER BY numeric_pinyin`,
    )
      .bind(`lexeme:complete-hsk:${encodeURIComponent(lexeme.simplified)}`)
      .all<{ numeric_pinyin: string; is_preferred: number }>();
    expect(readings.results.filter((reading) => reading.is_preferred === 1)).toEqual([
      { numeric_pinyin: "preferred2", is_preferred: 1 },
    ]);
    expect(revisedIdentity.changeId).not.toBe(firstIdentity.changeId);
    expect(
      await scalar(
        "SELECT COUNT(*) FROM server_changes WHERE change_id IN (?, ?)",
        firstIdentity.changeId,
        revisedIdentity.changeId,
      ),
    ).toBe(2);
    const revisedRevision = await scalar(
      "SELECT revision FROM content_revisions WHERE source_version = ?",
      revisedIdentity.sourceVersion,
    );
    expect(revisedRevision).not.toBeNull();
    expect(
      await scalar(
        "SELECT content_revision FROM server_changes WHERE change_id = ?",
        revisedIdentity.changeId,
      ),
    ).toBe(revisedRevision);
    expect(
      await scalar("SELECT current_content_revision FROM learner_settings WHERE singleton = 1"),
    ).toBe(revisedRevision);
  });

  test("a revised import retires source readings that are no longer present", async () => {
    const [lexeme] = scopedLexemes("removed");
    if (!lexeme) throw new Error("missing removed-reading test fixture");
    const initial = {
      lexemes: [lexeme],
      enrichments: [],
      vocabularyVersion: "removed-vocabulary-commit-a",
      v1Version: "removed-v1-commit",
      createdAt: timestamp("09:00"),
    } satisfies V1ImportInput;
    const remainingForm = lexeme.forms[1];
    if (!remainingForm) throw new Error("missing remaining reading test fixture");
    const revised = {
      ...initial,
      vocabularyVersion: "removed-vocabulary-commit-b",
      lexemes: [{ ...lexeme, forms: [remainingForm] }],
    } satisfies V1ImportInput;
    const revisedIdentity = await deriveV1ImportIdentity(revised);

    await applyImport(initial);
    await applyImport(revised);

    const revisedRevision = await scalar(
      "SELECT revision FROM content_revisions WHERE source_version = ?",
      revisedIdentity.sourceVersion,
    );
    const readings = await env.DB.prepare(
      `SELECT numeric_pinyin, is_preferred, retired_at, content_revision
         FROM lexeme_readings
         WHERE lexeme_id = ?
         ORDER BY numeric_pinyin`,
    )
      .bind(`lexeme:complete-hsk:${encodeURIComponent(lexeme.simplified)}`)
      .all<{
        numeric_pinyin: string;
        is_preferred: number;
        retired_at: number | null;
        content_revision: number;
      }>();
    expect(readings.results).toEqual([
      {
        numeric_pinyin: "removed1",
        is_preferred: 0,
        retired_at: timestamp("09:00"),
        content_revision: revisedRevision,
      },
      {
        numeric_pinyin: "removed2",
        is_preferred: 1,
        retired_at: null,
        content_revision: revisedRevision,
      },
    ]);
    expect(
      await scalar("SELECT current_content_revision FROM learner_settings WHERE singleton = 1"),
    ).toBe(revisedRevision);
    await expect(
      env.DB.prepare(
        `UPDATE lexeme_readings SET is_preferred = 1
           WHERE lexeme_id = ? AND numeric_pinyin = 'removed1'`,
      )
        .bind(`lexeme:complete-hsk:${encodeURIComponent(lexeme.simplified)}`)
        .run(),
    ).rejects.toThrow("retired reading cannot be preferred");
  });

  test("a revised import replaces its HSK level link without touching other tags", async () => {
    const [lexeme] = scopedLexemes("level-move");
    if (!lexeme) throw new Error("missing HSK level test fixture");
    const initial = {
      lexemes: [lexeme],
      enrichments: [],
      vocabularyVersion: "level-move-vocabulary-commit-a",
      v1Version: "level-move-v1-commit",
      createdAt: timestamp("09:00"),
    } satisfies V1ImportInput;
    const revised = {
      ...initial,
      lexemes: [{ ...lexeme, hskLevel: 2 }],
      vocabularyVersion: "level-move-vocabulary-commit-b",
      createdAt: timestamp("10:00"),
    } satisfies V1ImportInput;
    const initialIdentity = await deriveV1ImportIdentity(initial);
    const revisedIdentity = await deriveV1ImportIdentity(revised);
    const lexemeId = `lexeme:complete-hsk:${encodeURIComponent(lexeme.simplified)}`;

    await applyImport(initial);
    const initialRevision = await scalar(
      "SELECT revision FROM content_revisions WHERE source_version = ?",
      initialIdentity.sourceVersion,
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tags (id, kind, label, source, content_revision)
         VALUES ('tag:test:level-move', 'test', 'level-move', 'integration-test', ?)`,
      ).bind(initialRevision),
      env.DB.prepare(
        `INSERT INTO lexeme_tags (lexeme_id, tag_id, content_revision)
         VALUES (?, 'tag:test:level-move', ?)`,
      ).bind(lexemeId, initialRevision),
    ]);

    await applyImport(revised);
    const revisedRevision = await scalar(
      "SELECT revision FROM content_revisions WHERE source_version = ?",
      revisedIdentity.sourceVersion,
    );
    const hskTags = await env.DB.prepare(
      `SELECT t.label
         FROM lexeme_tags lt
         JOIN tags t ON t.id = lt.tag_id
         WHERE lt.lexeme_id = ? AND t.kind = 'hsk-2.0'
         ORDER BY t.label`,
    )
      .bind(lexemeId)
      .all<{ label: string }>();

    expect(hskTags.results).toEqual([{ label: "level-2" }]);
    expect(
      await scalar(
        "SELECT COUNT(*) FROM lexeme_tags WHERE lexeme_id = ? AND tag_id = 'tag:test:level-move'",
        lexemeId,
      ),
    ).toBe(1);
    expect(
      await scalar("SELECT current_content_revision FROM learner_settings WHERE singleton = 1"),
    ).toBe(revisedRevision);
    expect(
      await scalar(
        "SELECT COUNT(*) FROM server_changes WHERE change_id IN (?, ?)",
        initialIdentity.changeId,
        revisedIdentity.changeId,
      ),
    ).toBe(2);

    const revisedCursor = await scalar("SELECT MAX(seq) FROM server_changes");
    await applyImport(initial);
    expect(await scalar("SELECT MAX(seq) FROM server_changes")).toBe(revisedCursor);
    expect(
      await scalar(
        `SELECT COUNT(*) FROM lexeme_tags lt
           JOIN tags t ON t.id = lt.tag_id
           WHERE lt.lexeme_id = ? AND t.kind = 'hsk-2.0' AND t.label = 'level-2'`,
        lexemeId,
      ),
    ).toBe(1);
  });

  test("an import reuses an existing HSK tag's noncanonical ID", async () => {
    const [lexeme] = scopedLexemes("hsk-tag-id-conflict");
    if (!lexeme) throw new Error("missing HSK tag identity test fixture");
    const importedLexeme = { ...lexeme, hskLevel: 97 };
    const input = {
      lexemes: [importedLexeme],
      enrichments: [],
      vocabularyVersion: "hsk-tag-id-conflict-vocabulary-commit",
      v1Version: "hsk-tag-id-conflict-v1-commit",
      createdAt: timestamp("10:00"),
    } satisfies V1ImportInput;
    const identity = await deriveV1ImportIdentity(input);
    const legacyTagId = "tag:legacy:hsk-2.0:97";
    const seedRevisionResult = await env.DB.prepare(
      `INSERT INTO content_revisions (source, source_version, description, created_at)
       VALUES ('integration-test', 'hsk-tag-id-conflict-seed', 'test fixture', ?)`,
    )
      .bind(timestamp("09:00"))
      .run();

    await env.DB.prepare(
      `INSERT INTO tags (id, kind, label, source, content_revision)
       VALUES (?, 'hsk-2.0', 'level-97', 'legacy-import', ?)`,
    )
      .bind(legacyTagId, Number(seedRevisionResult.meta.last_row_id))
      .run();

    await applyImport(input);

    const lexemeId = `lexeme:complete-hsk:${encodeURIComponent(importedLexeme.simplified)}`;
    expect(
      await env.DB.prepare(
        `SELECT t.id, t.kind, t.label
         FROM lexeme_tags lt
         JOIN tags t ON t.id = lt.tag_id
         WHERE lt.lexeme_id = ? AND t.kind = 'hsk-2.0'`,
      )
        .bind(lexemeId)
        .first<{ id: string; kind: string; label: string }>(),
    ).toEqual({ id: legacyTagId, kind: "hsk-2.0", label: "level-97" });
    expect(await scalar("SELECT COUNT(*) FROM tags WHERE id = 'tag:hsk-2.0:97'")).toBe(0);
    expect(
      await scalar("SELECT COUNT(*) FROM server_changes WHERE change_id = ?", identity.changeId),
    ).toBe(1);
  });

  test("a revised import retires an omitted generated example and can reactivate it", async () => {
    const [lexeme] = scopedLexemes("example-lifecycle");
    if (!lexeme) throw new Error("missing example lifecycle test fixture");
    const enrichment = {
      simplified: lexeme.simplified,
      meaning_ja: "例の意味",
      example_zh: "这是一个旧例子。",
      example_pinyin: "Zhè shì yí ge jiù lìzi.",
      example_en: "This is an old example.",
      example_ja: "これは古い例です。",
    };
    const initial = {
      lexemes: [lexeme],
      enrichments: [enrichment],
      vocabularyVersion: "example-lifecycle-vocabulary-commit",
      v1Version: "example-lifecycle-v1-commit-a",
      createdAt: timestamp("09:00"),
    } satisfies V1ImportInput;
    const omitted = {
      ...initial,
      enrichments: [{ simplified: lexeme.simplified, meaning_ja: enrichment.meaning_ja }],
      v1Version: "example-lifecycle-v1-commit-b",
      createdAt: timestamp("10:00"),
    } satisfies V1ImportInput;
    const restored = {
      ...initial,
      enrichments: [{ ...enrichment, example_zh: "这是一个新例子。" }],
      v1Version: "example-lifecycle-v1-commit-c",
      createdAt: timestamp("11:00"),
    } satisfies V1ImportInput;
    const initialIdentity = await deriveV1ImportIdentity(initial);
    const omittedIdentity = await deriveV1ImportIdentity(omitted);
    const restoredIdentity = await deriveV1ImportIdentity(restored);
    const sentenceId = `sentence:v1:${encodeURIComponent(lexeme.simplified)}`;

    await applyImport(initial);
    expect(await scalar("SELECT COUNT(*) FROM sentences WHERE id = ?", sentenceId)).toBe(1);
    expect(
      await scalar("SELECT COUNT(*) FROM sentence_lexemes WHERE sentence_id = ?", sentenceId),
    ).toBe(1);

    await applyImport(omitted);
    const omittedRevision = await scalar(
      "SELECT revision FROM content_revisions WHERE source_version = ?",
      omittedIdentity.sourceVersion,
    );
    const retired = await env.DB.prepare(
      "SELECT retired_at, content_revision FROM sentences WHERE id = ?",
    )
      .bind(sentenceId)
      .first<{ retired_at: number | null; content_revision: number }>();
    expect(retired).toEqual({
      retired_at: timestamp("10:00"),
      content_revision: omittedRevision,
    });
    expect(
      await scalar("SELECT COUNT(*) FROM sentence_lexemes WHERE sentence_id = ?", sentenceId),
    ).toBe(0);
    expect(
      await scalar(
        "SELECT COUNT(*) FROM server_changes WHERE change_id IN (?, ?)",
        initialIdentity.changeId,
        omittedIdentity.changeId,
      ),
    ).toBe(2);

    const omittedCursor = await scalar("SELECT MAX(seq) FROM server_changes");
    await applyImport(initial);
    expect(await scalar("SELECT MAX(seq) FROM server_changes")).toBe(omittedCursor);
    expect(await scalar("SELECT retired_at FROM sentences WHERE id = ?", sentenceId)).toBe(
      timestamp("10:00"),
    );

    await applyImport(restored);
    expect(
      await env.DB.prepare("SELECT chinese, retired_at FROM sentences WHERE id = ?")
        .bind(sentenceId)
        .first<{ chinese: string; retired_at: number | null }>(),
    ).toEqual({ chinese: "这是一个新例子。", retired_at: null });
    expect(
      await scalar("SELECT COUNT(*) FROM sentence_lexemes WHERE sentence_id = ?", sentenceId),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) FROM server_changes WHERE change_id = ?",
        restoredIdentity.changeId,
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

  test("projection metadata keeps the maximum scheduled and practice attempt timestamp", async () => {
    const fixture = await seedScheduledCard("projection-max");
    await env.DB.prepare(
      "UPDATE projection_state SET dirty = 0, last_attempt_at = NULL WHERE singleton = 1",
    ).run();

    const scheduledNoon = scheduledInput(
      fixture,
      "projection-scheduled-noon",
      "2026-08-29T12:00:00Z",
      2,
      { deviceId: "projection-scheduled-device" },
    );
    const scheduledEleven = scheduledInput(
      fixture,
      "projection-scheduled-eleven",
      "2026-08-29T11:00:00Z",
      1,
      { deviceId: "projection-scheduled-device", rating: 2 },
    );
    await ingestAttempt(env.DB, scheduledNoon, { now: () => timestamp("12:01") });
    await ingestAttempt(env.DB, scheduledEleven, { now: () => timestamp("13:00") });
    expect(await scalar("SELECT last_attempt_at FROM projection_state WHERE singleton = 1")).toBe(
      timestamp("12:00"),
    );

    await env.DB.prepare(
      "UPDATE projection_state SET dirty = 0, last_attempt_at = NULL WHERE singleton = 1",
    ).run();
    const practiceFourteen: AttemptInput = {
      ...scheduledInput(fixture, "projection-practice-fourteen", "2026-08-29T14:00:00Z", 2, {
        deviceId: "projection-practice-device",
      }),
      mode: "reflex",
      fsrsReview: undefined,
    };
    const practiceThirteen: AttemptInput = {
      ...scheduledInput(fixture, "projection-practice-thirteen", "2026-08-29T13:00:00Z", 1, {
        deviceId: "projection-practice-device",
      }),
      mode: "reflex",
      fsrsReview: undefined,
    };
    await ingestAttempt(env.DB, practiceFourteen, { now: () => timestamp("14:01") });
    await ingestAttempt(env.DB, practiceThirteen, { now: () => timestamp("15:00") });
    expect(await scalar("SELECT last_attempt_at FROM projection_state WHERE singleton = 1")).toBe(
      timestamp("14:00"),
    );
    expect(await scalar("SELECT dirty FROM projection_state WHERE singleton = 1")).toBe(1);
  });

  test("Unicode review tie-breaks match D1 BINARY order", async () => {
    const fixture = await seedScheduledCard("unicode-order");
    const occurredAt = "2026-08-29T10:00:00Z";
    const astral = scheduledInput(fixture, "unicode-astral", occurredAt, 1, {
      deviceId: "\u{10000}",
      rating: 1,
    });
    const privateUseBmp = scheduledInput(fixture, "unicode-bmp", occurredAt, 1, {
      deviceId: "\uE000",
      rating: 4,
    });

    await ingestAttempt(env.DB, astral, { now: () => timestamp("10:01") });
    await ingestAttempt(env.DB, privateUseBmp, { now: () => timestamp("10:02") });

    const sqlOrder = await env.DB.prepare(
      `SELECT event_id FROM attempts
         WHERE card_id = ?
         ORDER BY occurred_at, device_id, device_seq, event_id`,
    )
      .bind(fixture.cardId)
      .all<{ event_id: string }>();
    const reviews = [canonical(astral), canonical(privateUseBmp)];
    const domainOrder = [...reviews].sort(compareCanonicalReviews).map((review) => review.eventId);

    expect(sqlOrder.results.map((row) => row.event_id)).toEqual([
      privateUseBmp.eventId,
      astral.eventId,
    ]);
    expect(domainOrder).toEqual(sqlOrder.results.map((row) => row.event_id));
    expect(project(await stateFor(fixture.cardId))).toEqual(
      replayFsrsHistory(reviews, new Map([[fixture.config.id, fixture.config]])),
    );
  });

  test("encoded review keys preserve D1 tuple order for control characters", async () => {
    const fixture = await seedScheduledCard("control-order");
    const occurredAt = "2026-08-29T10:00:00Z";
    const prefixedDevice = scheduledInput(fixture, "control-prefixed", occurredAt, 1, {
      deviceId: "a\u001f!",
      rating: 4,
    });
    const prefixDevice = scheduledInput(fixture, "control-prefix", occurredAt, 1, {
      deviceId: "a",
      rating: 1,
    });

    await ingestAttempt(env.DB, prefixedDevice, { now: () => timestamp("10:01") });
    await ingestAttempt(env.DB, prefixDevice, { now: () => timestamp("10:02") });

    const byTuple = await env.DB.prepare(
      `SELECT event_id FROM attempts
       WHERE card_id = ?
       ORDER BY occurred_at, device_id, device_seq, event_id`,
    )
      .bind(fixture.cardId)
      .all<{ event_id: string }>();
    const byKey = await env.DB.prepare(
      `SELECT r.attempt_id, r.semantic_order_key
       FROM fsrs_reviews r
       WHERE r.card_id = ?
       ORDER BY r.semantic_order_key`,
    )
      .bind(fixture.cardId)
      .all<{ attempt_id: string; semantic_order_key: string }>();
    const reviews = [canonical(prefixedDevice), canonical(prefixDevice)];
    const expectedOrder = [prefixDevice.eventId, prefixedDevice.eventId];

    expect(byTuple.results.map((row) => row.event_id)).toEqual(expectedOrder);
    expect(byKey.results.map((row) => row.attempt_id)).toEqual(expectedOrder);
    expect(new Set(byKey.results.map((row) => row.semantic_order_key)).size).toBe(2);
    expect(byKey.results.map((row) => row.semantic_order_key)).toEqual(
      expectedOrder.map((eventId) =>
        semanticOrderKey(reviews.find((review) => review.eventId === eventId)!),
      ),
    );
    expect(project(await stateFor(fixture.cardId))).toEqual(
      replayFsrsHistory(reviews, new Map([[fixture.config.id, fixture.config]])),
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

  test("a persisted scheduler config is immutable before its first synced review", async () => {
    const fixture = await seedScheduledCard("issued-config");
    expect(
      await scalar(
        "SELECT COUNT(*) FROM fsrs_reviews WHERE scheduler_config_id = ?",
        fixture.config.id,
      ),
    ).toBe(0);

    await expect(
      env.DB.prepare("UPDATE scheduler_configs SET desired_retention = 0.7 WHERE id = ?")
        .bind(fixture.config.id)
        .run(),
    ).rejects.toThrow("identity and semantics are immutable");
    await expect(
      env.DB.prepare("UPDATE scheduler_configs SET id = ? WHERE id = ?")
        .bind(`${fixture.config.id}-changed`, fixture.config.id)
        .run(),
    ).rejects.toThrow("identity and semantics are immutable");
    await expect(
      env.DB.prepare("DELETE FROM scheduler_configs WHERE id = ?").bind(fixture.config.id).run(),
    ).rejects.toThrow("scheduler configs cannot be deleted");
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO scheduler_configs
          (id, algorithm, implementation, implementation_version, parameters_json,
           desired_retention, is_current, created_at)
         VALUES (?, 'changed-algorithm', 'changed-implementation', '0.0.0', ?, 0.7, 0, ?)`,
      )
        .bind(fixture.config.id, JSON.stringify(fixture.config.parameters), timestamp("09:00"))
        .run(),
    ).rejects.toThrow("scheduler config IDs cannot be reinserted");

    const preserved = await env.DB.prepare(
      "SELECT algorithm, desired_retention, is_current FROM scheduler_configs WHERE id = ?",
    )
      .bind(fixture.config.id)
      .first<{ algorithm: string; desired_retention: number; is_current: number }>();
    expect(preserved).toEqual({
      algorithm: fixture.config.algorithm,
      desired_retention: fixture.config.desiredRetention,
      is_current: 1,
    });

    await env.DB.prepare("UPDATE scheduler_configs SET is_current = 0 WHERE id = ?")
      .bind(fixture.config.id)
      .run();
    await env.DB.prepare("UPDATE scheduler_configs SET is_current = 1 WHERE id = ?")
      .bind(fixture.config.id)
      .run();
    expect(
      await scalar("SELECT is_current FROM scheduler_configs WHERE id = ?", fixture.config.id),
    ).toBe(1);
  });

  test("study session device ownership is enforced and preserved", async () => {
    const fixture = await seedScheduledCard("session-device");
    const sessionId = "session-device-session";
    await env.DB.prepare(
      `INSERT INTO study_sessions (id, device_id, mode, started_at)
       VALUES (?, 'session-device-a', 'reflex', ?)`,
    )
      .bind(sessionId, timestamp("09:00"))
      .run();

    const directEventId = "session-device-direct-mismatch";
    const directChangeId = `attempt:${directEventId}`;
    await expect(
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO server_changes
            (change_id, entity_type, entity_id, operation, changed_at)
           VALUES (?, 'attempt', ?, 'upsert', ?)`,
        ).bind(directChangeId, directEventId, timestamp("10:01")),
        env.DB.prepare(
          `INSERT INTO attempts
            (event_id, device_id, device_seq, occurred_at, received_at, card_id,
             study_session_id, mode, activity_type, server_seq)
           VALUES (?, 'session-device-b', 1, ?, ?, ?, ?, 'reflex', 'hanzi_to_meaning',
             (SELECT seq FROM server_changes WHERE change_id = ?))`,
        ).bind(
          directEventId,
          timestamp("10:00"),
          timestamp("10:01"),
          fixture.cardId,
          sessionId,
          directChangeId,
        ),
      ]),
    ).rejects.toThrow("attempt device must match study session device");
    expect(await changeCountFor(directEventId)).toBe(0);

    const mismatch: AttemptInput = {
      ...scheduledInput(fixture, "session-device-http-mismatch", "2026-08-29T10:00:00Z", 1, {
        deviceId: "session-device-b",
      }),
      studySessionId: sessionId,
      mode: "reflex",
      fsrsReview: undefined,
    };
    const mismatchResponse = await postAttempt(mismatch);
    expect(mismatchResponse.status).toBe(409);
    await expect(mismatchResponse.json()).resolves.toMatchObject({ code: "conflict" });
    expect(await count("attempts", "event_id", mismatch.eventId)).toBe(0);

    const matching: AttemptInput = {
      ...mismatch,
      eventId: "session-device-http-match",
      deviceId: "session-device-a",
    };
    const matchingResponse = await postAttempt(matching);
    expect(matchingResponse.status).toBe(201);
    expect(
      await env.DB.prepare("SELECT device_id, study_session_id FROM attempts WHERE event_id = ?")
        .bind(matching.eventId)
        .first<{ device_id: string; study_session_id: string }>(),
    ).toEqual({ device_id: matching.deviceId, study_session_id: sessionId });

    await expect(
      env.DB.prepare("UPDATE study_sessions SET device_id = 'session-device-b' WHERE id = ?")
        .bind(sessionId)
        .run(),
    ).rejects.toThrow("linked study session device is immutable");
    expect(
      await env.DB.prepare("SELECT device_id FROM study_sessions WHERE id = ?")
        .bind(sessionId)
        .first<{ device_id: string }>(),
    ).toEqual({ device_id: matching.deviceId });
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
    ).rejects.toThrow("already belongs to another event");
    expect((await stateFor(fixture.cardId)).version).toBe(1);
  });

  test("Worker maps invalid input, missing references, and sequence conflicts to 4xx", async () => {
    const invalidTimestamp = await postAttempt({
      eventId: "http-invalid-time",
      deviceId: "http-invalid-device",
      deviceSeq: 1,
      occurredAt: "not-a-dateZ",
      cardId: "missing-card",
      mode: "study",
      activityType: "hanzi_to_meaning",
    });
    expect(invalidTimestamp.status).toBe(400);
    await expect(invalidTimestamp.json()).resolves.toMatchObject({ code: "invalid_input" });

    const invalidCalendar = await postAttempt({
      eventId: "http-invalid-calendar",
      deviceId: "http-invalid-calendar-device",
      deviceSeq: 1,
      occurredAt: "2026-02-30T00:00:00Z",
      cardId: "missing-card",
      mode: "study",
      activityType: "hanzi_to_meaning",
    });
    expect(invalidCalendar.status).toBe(400);
    await expect(invalidCalendar.json()).resolves.toMatchObject({ code: "invalid_input" });

    const unsafeInteger = await postAttempt({
      eventId: "http-unsafe-integer",
      deviceId: "http-unsafe-integer-device",
      deviceSeq: 1,
      occurredAt: "2026-08-29T10:00:00Z",
      cardId: "missing-card",
      mode: "study",
      activityType: "hanzi_to_meaning",
      responseMs: 1e100,
      expectedCardStateVersion: 1e100,
    });
    expect(unsafeInteger.status).toBe(400);
    await expect(unsafeInteger.json()).resolves.toMatchObject({ code: "invalid_input" });

    const missingCard = await postAttempt({
      eventId: "http-missing-card",
      deviceId: "http-missing-card-device",
      deviceSeq: 1,
      occurredAt: "2026-08-29T10:00:00Z",
      cardId: "card-that-does-not-exist",
      mode: "study",
      activityType: "hanzi_to_meaning",
    });
    expect(missingCard.status).toBe(404);
    await expect(missingCard.json()).resolves.toMatchObject({ code: "reference_not_found" });

    const fixture = await seedScheduledCard("http-errors");
    const missingConfigInput = scheduledInput(
      fixture,
      "http-missing-config",
      "2026-08-29T10:00:00Z",
      1,
    );
    if (!missingConfigInput.fsrsReview) throw new Error("missing HTTP test review");
    missingConfigInput.fsrsReview.schedulerConfigId = "config-that-does-not-exist";
    const missingConfig = await postAttempt(missingConfigInput);
    expect(missingConfig.status).toBe(404);
    await expect(missingConfig.json()).resolves.toMatchObject({ code: "reference_not_found" });
    expect(await count("attempts", "event_id", missingConfigInput.eventId)).toBe(0);

    const first = scheduledInput(fixture, "http-sequence-first", "2026-08-29T10:00:00Z", 1);
    const firstResponse = await postAttempt(first);
    expect(firstResponse.status).toBe(201);
    const reused = scheduledInput(fixture, "http-sequence-reused", "2026-08-29T11:00:00Z", 1);
    const reusedResponse = await postAttempt(reused);
    expect(reusedResponse.status).toBe(409);
    await expect(reusedResponse.json()).resolves.toMatchObject({ code: "conflict" });
    expect(await count("attempts", "event_id", reused.eventId)).toBe(0);
  });

  test("Worker requires the configured bearer token before immutable attempt writes", async () => {
    const fixture = await seedScheduledCard("http-auth");
    const input = scheduledInput(fixture, "http-auth-event", "2026-08-29T10:00:00Z", 1);

    const missing = await postAttempt(input, null);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");

    const incorrect = await postAttempt(input, "Bearer incorrect-token");
    expect(incorrect.status).toBe(401);
    await expect(incorrect.json()).resolves.toMatchObject({ code: "unauthorized" });
    expect(await count("attempts", "event_id", input.eventId)).toBe(0);

    const authorized = await postAttempt(input);
    expect(authorized.status).toBe(201);
    expect(await count("attempts", "event_id", input.eventId)).toBe(1);
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

async function applyImport(input: V1ImportInput): Promise<void> {
  const statements = await buildV1ImportStatements(input);
  await env.DB.batch(
    statements
      .filter((statement) => !statement.startsWith("PRAGMA"))
      .map((statement) => env.DB.prepare(statement)),
  );
}

function postAttempt(
  input: AttemptInput,
  authorization: string | null = "Bearer integration-test-write-token",
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== null) headers.set("authorization", authorization);
  return exports.default.fetch(
    new Request("https://example.test/api/attempts", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    }),
  );
}

function scopedLexemes(prefix: string): V1SourceLexeme[] {
  return [1, 2].map((number) => ({
    simplified: `测${prefix}${number}`,
    frequency: 100 + number,
    pos: ["verb"],
    hskLevel: 1,
    forms: [1, 2].map((reading) => ({
      traditional: `測${prefix}${number}`,
      transcriptions: {
        pinyin: `${prefix} ${reading}`,
        numeric: `${prefix}${reading}`,
      },
      meanings: [`${prefix} meaning ${reading}`],
    })),
  }));
}

async function scalar(sql: string, ...values: Array<string | number>): Promise<number | null> {
  const statement = values.length === 0 ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(...values);
  const result = await statement.first<Record<string, number>>();
  return result ? (Object.values(result)[0] ?? null) : null;
}

function timestamp(time: string): number {
  return Date.parse(`2026-08-29T${time}:00Z`);
}
