import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { ingestAttempt } from "../../src/db/ingestion";
import {
  buildPronunciationImportStatements,
  type PronunciationImportInput,
} from "../../src/db/pronunciation-import";
import { createPronunciationSession, getNextPronunciationCard } from "../../src/db/pronunciation";
import {
  buildV1ImportStatements,
  type V1ImportInput,
  type V1SourceLexeme,
} from "../../src/db/v1-import";
import type { AttemptInput, PronunciationNextResult } from "../../src/domain/types";

describe("pronunciation foundation", () => {
  test("keeps polyphonic senses, cards, and audio attached to exact readings", async () => {
    await applyPronunciationFixture();

    const readings = await env.DB.prepare(
      `SELECT r.pinyin, r.sense_scope,
        GROUP_CONCAT(c.activity_type, ',') AS activities,
        rm.media_asset_id
       FROM lexeme_readings r
       JOIN lexemes l ON l.id = r.lexeme_id
       JOIN cards c ON c.lexeme_reading_id = r.id AND c.retired_at IS NULL
       LEFT JOIN lexeme_reading_media rm ON rm.lexeme_reading_id = r.id
       WHERE l.simplified = '行'
       GROUP BY r.id, r.pinyin, r.sense_scope, rm.media_asset_id
       ORDER BY r.pinyin`,
    ).all<{
      pinyin: string;
      sense_scope: string;
      activities: string;
      media_asset_id: string | null;
    }>();

    expect(readings.results).toHaveLength(2);
    expect(readings.results).toEqual([
      expect.objectContaining({
        pinyin: "háng",
        sense_scope: '["row","profession"]',
        media_asset_id: null,
      }),
      expect.objectContaining({
        pinyin: "xíng",
        sense_scope: '["to walk","to be capable"]',
        media_asset_id: null,
      }),
    ]);
    for (const reading of readings.results) {
      expect(reading.activities).toContain("hanzi_to_pinyin");
      expect(reading.activities).toContain("tone_identification");
      expect(reading.activities).not.toContain("audio_to_hanzi");
    }

    expect(
      await scalar(
        `SELECT COUNT(*) FROM lexeme_reading_media rm
         JOIN lexeme_readings r ON r.id = rm.lexeme_reading_id
         JOIN lexemes l ON l.id = r.lexeme_id WHERE l.simplified = '爱'`,
      ),
    ).toBe(1);
    expect(
      await scalar(
        `SELECT COUNT(*) FROM lexeme_reading_media rm
         JOIN lexeme_readings r ON r.id = rm.lexeme_reading_id
         JOIN lexemes l ON l.id = r.lexeme_id WHERE l.simplified IN ('行', '吗')`,
      ),
    ).toBe(0);
  });

  test("derives neutral tones and lexical tone pairs from the exact reading", async () => {
    await applyPronunciationFixture();
    await createPronunciationSession(env.DB, {
      sessionId: "tone-session",
      deviceId: "tone-device",
      focus: "tones",
      maxItems: 10,
    });

    const neutralCard = await cardFor("吗", "tone_identification");
    const pairCard = await cardFor("你好", "tone_pair_identification");
    expect(neutralCard).toMatchObject({ answerChoiceId: "tone:5", reading: { tone: 5 } });
    expect(pairCard).toMatchObject({
      answerChoiceId: "tone-pair:3-3",
      reading: { tonePair: [3, 3], untonedPinyin: "ni hao" },
    });
    if (!neutralCard) throw new Error("missing neutral-tone card");
    await expect(
      ingestAttempt(env.DB, {
        eventId: "false-objective-correctness",
        deviceId: "direct-card:吗:tone_identification",
        deviceSeq: 1,
        occurredAt: "2026-08-30T03:00:00Z",
        cardId: neutralCard.cardId,
        studySessionId: "direct-card:吗:tone_identification",
        mode: "pronunciation",
        activityType: "tone_identification",
        correct: true,
        metadata: { selectedChoiceId: "tone:1" },
      }),
    ).rejects.toThrow("correctness disagrees");
  });

  test("reruns the same pronunciation import as a complete identity no-op", async () => {
    await applyPronunciationFixture();
    const before = await importIdentitySummary();
    await applyStatements(
      await buildPronunciationImportStatements(pronunciationFixtureInput(fixtureLexemes())),
    );
    expect(await importIdentitySummary()).toEqual(before);
  });

  test("serves legacy ü syllable storage through the canonical reading path", async () => {
    await applyPronunciationFixture();
    await env.DB.prepare(
      `UPDATE lexeme_readings
       SET normalized_syllables_json = '[{"syllable":"lü","tone":4}]'
       WHERE lexeme_id = 'lexeme:complete-hsk:%E7%BB%BF'`,
    ).run();

    const card = await cardFor("绿", "hanzi_to_pinyin");
    expect(card?.reading).toMatchObject({
      pinyin: "lǜ",
      numericPinyin: "lv4",
      untonedPinyin: "lü",
      tone: 4,
    });

    await env.DB.prepare(
      `UPDATE lexeme_readings
       SET normalized_syllables_json = '[{"syllable":"lv","tone":4}]'
       WHERE lexeme_id = 'lexeme:complete-hsk:%E7%BB%BF'`,
    ).run();
  });

  test("releases retired reading media before remapping unchanged audio to a new reading", async () => {
    const original = [lexeme("爱", [{ pinyin: "ài", numeric: "ai4", meanings: ["to love"] }], 1)];
    await applyStatements(
      await buildV1ImportStatements({
        lexemes: original,
        enrichments: [],
        vocabularyVersion: "mapping-vocabulary-1",
        v1Version: "mapping-v1",
        createdAt: 10,
      }),
    );
    await applyStatements(
      await buildPronunciationImportStatements(
        reliablePronunciationInput(original, "mapping-vocabulary-1", 10),
      ),
    );

    const revised = [lexeme("爱", [{ pinyin: "ǎi", numeric: "ai3", meanings: ["to love"] }], 1)];
    await applyStatements(
      await buildV1ImportStatements({
        lexemes: revised,
        enrichments: [],
        vocabularyVersion: "mapping-vocabulary-2",
        v1Version: "mapping-v1",
        createdAt: 20,
      }),
    );
    await applyStatements(
      await buildPronunciationImportStatements(
        reliablePronunciationInput(revised, "mapping-vocabulary-2", 20),
      ),
    );

    const readings = await env.DB.prepare(
      `SELECT r.numeric_pinyin, r.retired_at, rm.media_asset_id
       FROM lexeme_readings r
       LEFT JOIN lexeme_reading_media rm ON rm.lexeme_reading_id = r.id
       WHERE r.lexeme_id = 'lexeme:complete-hsk:%E7%88%B1'
       ORDER BY r.numeric_pinyin`,
    ).all<{
      numeric_pinyin: string;
      retired_at: number | null;
      media_asset_id: string | null;
    }>();
    expect(readings.results).toEqual([
      { numeric_pinyin: "ai3", retired_at: null, media_asset_id: expect.any(String) },
      { numeric_pinyin: "ai4", retired_at: 20, media_asset_id: null },
    ]);
    expect(
      await scalar("SELECT COUNT(*) FROM media_assets WHERE source_version = 'mapping-audio'"),
    ).toBe(1);
    expect(
      await scalar(
        `SELECT COUNT(*) FROM lexeme_reading_media rm
         JOIN media_assets m ON m.id = rm.media_asset_id
         WHERE m.source_version = 'mapping-audio'`,
      ),
    ).toBe(1);
  });

  test("persists perception correctness and production self-rating without FSRS mutation", async () => {
    await applyPronunciationFixture();
    const vocabularyStateBefore = await env.DB.prepare(
      `SELECT card_id, version, due_at, reps FROM card_state ORDER BY card_id LIMIT 1`,
    ).first<Record<string, unknown>>();

    await createPronunciationSession(env.DB, {
      sessionId: "attempt-session",
      deviceId: "attempt-device",
      focus: "speaking",
      maxItems: 2,
    });
    const production = await getNextPronunciationCard(env.DB, "attempt-session", "attempt-device");
    expect(production.card?.activityType).toBe("pronunciation_production");
    if (!production.card) throw new Error("missing production card");

    const saved = await ingestAttempt(env.DB, {
      eventId: "production-event",
      deviceId: "attempt-device",
      deviceSeq: 1,
      occurredAt: "2026-08-30T04:00:00Z",
      cardId: production.card.cardId,
      studySessionId: "attempt-session",
      mode: "pronunciation",
      activityType: "pronunciation_production",
      selfRating: 3,
      responseMs: 900,
      metadata: { interaction: "speak-compare-self-rate", readingId: production.card.readingId },
    });
    expect(saved).toMatchObject({ reviewCreated: false, cardState: null });

    const persisted = await env.DB.prepare(
      `SELECT correct, score, self_rating FROM attempts WHERE event_id = 'production-event'`,
    ).first<{ correct: number | null; score: number | null; self_rating: number | null }>();
    expect(persisted).toEqual({ correct: null, score: null, self_rating: 3 });
    expect(
      await scalar("SELECT COUNT(*) FROM fsrs_reviews WHERE attempt_id = 'production-event'"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        `SELECT card_id, version, due_at, reps FROM card_state ORDER BY card_id LIMIT 1`,
      ).first<Record<string, unknown>>(),
    ).toEqual(vocabularyStateBefore);

    await expect(
      ingestAttempt(env.DB, {
        eventId: "invalid-production-event",
        deviceId: "attempt-device",
        deviceSeq: 2,
        occurredAt: "2026-08-30T04:01:00Z",
        cardId: production.card.cardId,
        studySessionId: "attempt-session",
        mode: "pronunciation",
        activityType: "pronunciation_production",
        correct: true,
        selfRating: 3,
      }),
    ).rejects.toThrow("keeps self-rating separate");

    await expect(
      ingestAttempt(env.DB, {
        eventId: "invalid-production-mode",
        deviceId: "attempt-device",
        deviceSeq: 2,
        occurredAt: "2026-08-30T04:01:00Z",
        cardId: production.card.cardId,
        mode: "reflex",
        activityType: "pronunciation_production",
        selfRating: 3,
      }),
    ).rejects.toThrow("require pronunciation mode");
  });

  test("resumes the same presentation, advances durably, and completes through the Worker API", async () => {
    await applyPronunciationFixture();
    const created = await localJson("/api/pronunciation/sessions", {
      sessionId: "reload-session",
      deviceId: "reload-device",
      focus: "pinyin",
      maxItems: 2,
    });
    expect(created.status).toBe(201);

    const first = (await (
      await localJson("/api/pronunciation/sessions/reload-session/next", {
        deviceId: "reload-device",
      })
    ).json()) as PronunciationNextResult;
    const reload = (await (
      await localJson("/api/pronunciation/sessions/reload-session/next", {
        deviceId: "reload-device",
      })
    ).json()) as PronunciationNextResult;
    expect(reload.card).toEqual(first.card);
    if (!first.card) throw new Error("missing first pronunciation card");

    const firstAttempt = pronunciationAttempt({
      eventId: "reload-event-1",
      deviceSeq: 1,
      card: first.card,
      sessionId: "reload-session",
      deviceId: "reload-device",
    });
    expect((await localJson("/api/attempts", firstAttempt)).status).toBe(201);
    expect((await localJson("/api/attempts", firstAttempt)).status).toBe(200);

    const second = (await (
      await localJson("/api/pronunciation/sessions/reload-session/next", {
        deviceId: "reload-device",
      })
    ).json()) as PronunciationNextResult;
    expect(second.card?.cardId).not.toBe(first.card.cardId);
    expect(second.card?.readingId).not.toBe(first.card.readingId);
    expect(second.card?.lexeme.simplified).not.toBe(first.card.lexeme.simplified);
    if (!second.card) throw new Error("missing second pronunciation card");
    expect(
      (
        await localJson(
          "/api/attempts",
          pronunciationAttempt({
            eventId: "reload-event-2",
            deviceSeq: 2,
            card: second.card,
            sessionId: "reload-session",
            deviceId: "reload-device",
          }),
        )
      ).status,
    ).toBe(201);

    const completed = (await (
      await localJson("/api/pronunciation/sessions/reload-session/next", {
        deviceId: "reload-device",
      })
    ).json()) as PronunciationNextResult;
    expect(completed).toMatchObject({
      status: "completed",
      session: { completedItems: 2, maxItems: 2 },
      card: null,
    });

    const nextSession = await createPronunciationSession(env.DB, {
      sessionId: "next-session",
      deviceId: "reload-device",
      focus: "pinyin",
      maxItems: 1,
    });
    expect(nextSession.disposition).toBe("created");
    const rotated = await getNextPronunciationCard(env.DB, "next-session", "reload-device");
    expect(rotated.card?.cardId).not.toBe(first.card.cardId);
  });
});

async function applyPronunciationFixture(): Promise<void> {
  const lexemes = fixtureLexemes();
  const vocabulary: V1ImportInput = {
    lexemes,
    enrichments: [],
    vocabularyVersion: "pronunciation-fixture-vocabulary",
    v1Version: "pronunciation-fixture-v1",
  };
  await applyStatements(await buildV1ImportStatements(vocabulary));
  await applyStatements(
    await buildPronunciationImportStatements(pronunciationFixtureInput(lexemes)),
  );
}

function pronunciationFixtureInput(lexemes: V1SourceLexeme[]): PronunciationImportInput {
  return {
    lexemes,
    vocabularyVersion: "pronunciation-fixture-vocabulary",
    audioVersion: "pronunciation-fixture-audio",
    audioItems: [
      {
        simplified: "爱",
        status: "reliable",
        sourcePath: "64k/hsk/cmn-爱.mp3",
        contentSha256: "a".repeat(64),
        byteLength: 128,
      },
      {
        simplified: "行",
        status: "ambiguous",
        sourcePath: "64k/hsk/cmn-行.mp3",
        contentSha256: "b".repeat(64),
        byteLength: 128,
      },
      { simplified: "吗", status: "missing" },
      { simplified: "你好", status: "missing" },
      { simplified: "绿", status: "missing" },
    ],
  };
}

async function importIdentitySummary(): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM server_changes WHERE entity_type = 'content') AS content_changes,
      (SELECT COUNT(*) FROM media_assets) AS media_assets,
      (SELECT COUNT(*) FROM cards WHERE subject_type = 'lexeme_reading') AS pronunciation_cards,
      (SELECT current_content_revision FROM learner_settings WHERE singleton = 1)
        AS current_content_revision`,
  ).first<Record<string, unknown>>();
}

async function applyStatements(statements: string[]): Promise<void> {
  await env.DB.batch(
    statements
      .filter((statement) => !statement.startsWith("PRAGMA"))
      .map((statement) => env.DB.prepare(statement)),
  );
}

async function cardFor(
  simplified: string,
  activityType: string,
): Promise<PronunciationNextResult["card"]> {
  const row = await env.DB.prepare(
    `SELECT c.id, r.id AS reading_id FROM cards c
     JOIN lexeme_readings r ON r.id = c.lexeme_reading_id
     JOIN lexemes l ON l.id = r.lexeme_id
     WHERE l.simplified = ? AND c.activity_type = ? AND c.retired_at IS NULL
     ORDER BY r.id LIMIT 1`,
  )
    .bind(simplified, activityType)
    .first<{ id: string; reading_id: string }>();
  if (!row) throw new Error(`missing ${activityType} card for ${simplified}`);
  const sessionId = `direct-card:${simplified}:${activityType}`;
  await env.DB.prepare(
    `UPDATE cards SET retired_at = 0
     WHERE subject_type = 'lexeme_reading' AND id <> ?`,
  )
    .bind(row.id)
    .run();
  await createPronunciationSession(env.DB, {
    sessionId,
    deviceId: sessionId,
    focus: activityType.startsWith("tone_") ? "tones" : "mixed",
    maxItems: 1,
  });
  const card = await getNextPronunciationCard(env.DB, sessionId, sessionId);
  await env.DB.prepare(
    `UPDATE cards SET retired_at = NULL
     WHERE subject_type = 'lexeme_reading' AND retired_at = 0`,
  ).run();
  return card.card;
}

function fixtureLexemes(): V1SourceLexeme[] {
  return [
    lexeme("爱", [{ pinyin: "ài", numeric: "ai4", meanings: ["to love"] }], 1),
    lexeme(
      "行",
      [
        { pinyin: "xíng", numeric: "xing2", meanings: ["to walk", "to be capable"] },
        { pinyin: "háng", numeric: "hang2", meanings: ["row", "profession"] },
      ],
      2,
    ),
    lexeme("吗", [{ pinyin: "ma", numeric: "ma5", meanings: ["question particle"] }], 3),
    lexeme("你好", [{ pinyin: "nǐ hǎo", numeric: "ni3 hao3", meanings: ["hello"] }], 4),
    lexeme("绿", [{ pinyin: "lǜ", numeric: "lv4", meanings: ["green"] }], 5),
  ];
}

function reliablePronunciationInput(
  lexemes: V1SourceLexeme[],
  vocabularyVersion: string,
  createdAt: number,
): PronunciationImportInput {
  return {
    lexemes,
    vocabularyVersion,
    audioVersion: "mapping-audio",
    createdAt,
    audioItems: [
      {
        simplified: "爱",
        status: "reliable",
        sourcePath: "64k/hsk/cmn-爱.mp3",
        contentSha256: "c".repeat(64),
        byteLength: 128,
      },
    ],
  };
}

function lexeme(
  simplified: string,
  forms: Array<{ pinyin: string; numeric: string; meanings: string[] }>,
  frequency: number,
): V1SourceLexeme {
  return {
    simplified,
    frequency,
    hskLevel: 1,
    forms: forms.map((form) => ({
      traditional: simplified,
      transcriptions: { pinyin: form.pinyin, numeric: form.numeric },
      meanings: form.meanings,
    })),
  };
}

function pronunciationAttempt(input: {
  eventId: string;
  deviceSeq: number;
  card: NonNullable<PronunciationNextResult["card"]>;
  sessionId: string;
  deviceId: string;
}): AttemptInput {
  return {
    eventId: input.eventId,
    deviceId: input.deviceId,
    deviceSeq: input.deviceSeq,
    occurredAt: `2026-08-30T04:0${input.deviceSeq}:00Z`,
    cardId: input.card.cardId,
    studySessionId: input.sessionId,
    mode: "pronunciation",
    activityType: input.card.activityType,
    correct: true,
    responseMs: 500,
    metadata: {
      interaction: "test",
      readingId: input.card.readingId,
      ...(input.card.answerChoiceId ? { selectedChoiceId: input.card.answerChoiceId } : {}),
    },
  };
}

async function scalar(sql: string): Promise<number> {
  return (await env.DB.prepare(`SELECT (${sql}) AS value`).first<number>("value")) ?? 0;
}

function localJson(path: string, body: unknown): Promise<Response> {
  const url = `http://127.0.0.1${path}`;
  return exports.default.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify(body),
    }),
  );
}
