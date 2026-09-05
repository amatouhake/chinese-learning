import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { FIXED_OWNER_LEARNER_ID } from "../../src/worker/current-learner";

import { ingestAttempt } from "../../src/db/ingestion";
import { getPracticeSessionSummary } from "../../src/db/practice-sessions";
import {
  AUDIO_MAPPING_BASIS_SINGLE_READING,
  AUDIO_MAPPING_BASIS_SOURCE_PRONUNCIATION,
  buildPronunciationImportStatements,
  type PronunciationImportInput,
} from "../../src/db/pronunciation-import";
import {
  createPronunciationSession,
  getCanonicalPronunciationChoiceIds,
  getNextPronunciationCard,
  getOfflinePronunciationPack,
} from "../../src/db/pronunciation";
import {
  PRONUNCIATION_AUDIO_SKIP_INTERACTION,
  PRONUNCIATION_AUDIO_SKIP_REASON,
} from "../../src/domain/pronunciation";
import { currentPracticeContractVersion } from "../../src/domain/practice-contract";
import { normalizeSourcePinyin, normalizedPinyinTokens } from "../../src/domain/pronunciation";
import {
  buildV1ImportStatements,
  uniqueReadings,
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

  test("persists recovered evidence on one reading and leaves its sibling without audio", async () => {
    const lexemes = [
      lexeme(
        "声",
        [
          { pinyin: "shēng", numeric: "sheng1", meanings: ["sound"] },
          { pinyin: "shèng", numeric: "sheng4", meanings: ["voice"] },
        ],
        1,
      ),
    ];
    await applyStatements(
      await buildV1ImportStatements({
        lexemes,
        enrichments: [],
        vocabularyVersion: "recovered-evidence-vocabulary",
        v1Version: "recovered-evidence-v1",
        createdAt: 10,
      }),
    );
    const readingIds = uniqueReadings(lexemes[0]!, "lexeme:complete-hsk:%E5%A3%B0").map(
      ({ id }) => id,
    );
    const metadataSource = {
      id: "shtooka:integration-test",
      artifactSha256: "d".repeat(64),
      records: [
        {
          sourceText: "声",
          sourcePronunciation: "shēng",
          normalizedSourcePinyin: normalizedPinyinTokens(normalizeSourcePinyin("shēng")),
          sourcePath: "flac/cmn-recovered.flac",
        },
      ],
    };
    await applyStatements(
      await buildPronunciationImportStatements({
        lexemes,
        vocabularyVersion: "recovered-evidence-vocabulary",
        audioVersion: "recovered-evidence-audio",
        metadataSource,
        audioItems: [
          {
            simplified: "声",
            status: "reliable",
            targetReadingId: readingIds[0]!,
            mappingBasis: AUDIO_MAPPING_BASIS_SOURCE_PRONUNCIATION,
            sourcePath: "64k/hsk/cmn-声.mp3",
            contentSha256: "e".repeat(64),
            byteLength: 128,
            sourceEvidence: {
              sourceText: "声",
              sourcePronunciation: "shēng",
              normalizedSourcePinyin: ["sheng1"],
              metadataSourceId: metadataSource.id,
              metadataSourceDigest: metadataSource.artifactSha256,
              metadataSourceRecordPath: "flac/cmn-recovered.flac",
            },
          },
        ],
        createdAt: 10,
      }),
    );

    const mappings = await env.DB.prepare(
      `SELECT r.numeric_pinyin, rm.mapping_basis, rm.source_text, rm.source_pronunciation,
        rm.normalized_source_pinyin, rm.metadata_source_id, rm.metadata_source_digest,
        rm.metadata_source_record_path,
        (SELECT COUNT(*) FROM cards c
         WHERE c.lexeme_reading_id = r.id AND c.activity_type LIKE 'audio_to_%'
           AND c.retired_at IS NULL) AS audio_cards
       FROM lexeme_readings r
       LEFT JOIN lexeme_reading_media rm ON rm.lexeme_reading_id = r.id
       WHERE r.lexeme_id = 'lexeme:complete-hsk:%E5%A3%B0'
       ORDER BY r.numeric_pinyin`,
    ).all<Record<string, unknown>>();
    expect(mappings.results).toEqual([
      {
        numeric_pinyin: "sheng1",
        mapping_basis: AUDIO_MAPPING_BASIS_SOURCE_PRONUNCIATION,
        source_text: "声",
        source_pronunciation: "shēng",
        normalized_source_pinyin: '["sheng1"]',
        metadata_source_id: "shtooka:integration-test",
        metadata_source_digest: "d".repeat(64),
        metadata_source_record_path: "flac/cmn-recovered.flac",
        audio_cards: 2,
      },
      {
        numeric_pinyin: "sheng4",
        mapping_basis: null,
        source_text: null,
        source_pronunciation: null,
        normalized_source_pinyin: null,
        metadata_source_id: null,
        metadata_source_digest: null,
        metadata_source_record_path: null,
        audio_cards: 0,
      },
    ]);
    await expect(
      env.DB.prepare(
        `UPDATE media_assets SET attribution = 'changed' WHERE source_version = 'recovered-evidence-audio'`,
      ).run(),
    ).rejects.toThrow("media assets are immutable");

    const offlineTarget = await env.DB.prepare(
      `SELECT c.id FROM cards c
       WHERE c.lexeme_reading_id = ?
         AND c.activity_type = 'audio_to_hanzi'
         AND c.retired_at IS NULL`,
    )
      .bind(readingIds[0])
      .first<{ id: string }>();
    if (!offlineTarget) throw new Error("missing recovered offline target card");
    const temporaryRetirement = 9_999_999;
    await env.DB.prepare(
      `UPDATE cards SET retired_at = ?
       WHERE subject_type = 'lexeme_reading' AND retired_at IS NULL AND id <> ?`,
    )
      .bind(temporaryRetirement, offlineTarget.id)
      .run();
    try {
      await createPronunciationSession(env.DB, FIXED_OWNER_LEARNER_ID, {
        sessionId: "recovered-offline-session",
        deviceId: "recovered-offline-device",
        focus: "listening",
        maxItems: 1,
      });
      const offlinePack = await getOfflinePronunciationPack(
        env.DB,
        FIXED_OWNER_LEARNER_ID,
        "recovered-offline-session",
        "recovered-offline-device",
      );
      expect(offlinePack.cards).toEqual([
        expect.objectContaining({
          readingId: readingIds[0],
          activityType: "audio_to_hanzi",
          media: expect.objectContaining({ url: expect.stringContaining("audio-cmn") }),
        }),
      ]);
    } finally {
      await env.DB.prepare(
        `UPDATE cards SET retired_at = NULL
         WHERE subject_type = 'lexeme_reading' AND retired_at = ?`,
      )
        .bind(temporaryRetirement)
        .run();
    }
  });

  test("derives neutral tones and lexical tone pairs from the exact reading", async () => {
    await applyPronunciationFixture();
    await createPronunciationSession(env.DB, FIXED_OWNER_LEARNER_ID, {
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
    expect(pairCard?.choices).toHaveLength(5);
    expect(pairCard?.choices.map(({ id }) => id)).toEqual([
      "tone:1",
      "tone:2",
      "tone:3",
      "tone:4",
      "tone:5",
    ]);
    if (!neutralCard) throw new Error("missing neutral-tone card");
    if (!pairCard) throw new Error("missing tone-pair card");
    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        eventId: "tone-pair-two-stage",
        deviceId: "direct-card:你好:tone_pair_identification",
        deviceSeq: 1,
        occurredAt: "2026-08-30T02:59:00Z",
        cardId: pairCard.cardId,
        studySessionId: "direct-card:你好:tone_pair_identification",
        mode: "pronunciation",
        activityType: "tone_pair_identification",
        correct: true,
        metadata: {
          interaction: "choice",
          selectedChoiceId: "tone-pair:3-3",
          selectedTonePair: "3-3",
          readingId: pairCard.readingId,
        },
      }),
    ).resolves.toMatchObject({ reviewCreated: false, cardState: null });
    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
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

  test("rejects fabricated pronunciation choices instead of recording ordinary wrong answers", async () => {
    await applyPronunciationFixture();
    const cases = [
      { simplified: "吗", activityType: "tone_identification" as const, fabricated: "tone:6" },
      {
        simplified: "爱",
        activityType: "pinyin_to_hanzi" as const,
        fabricated: "reading:not-presented",
      },
      {
        simplified: "爱",
        activityType: "audio_to_hanzi" as const,
        fabricated: "reading:not-presented",
      },
      {
        simplified: "爱",
        activityType: "audio_to_meaning" as const,
        fabricated: "reading:not-presented",
      },
    ];

    for (const [index, candidate] of cases.entries()) {
      const card = await cardFor(candidate.simplified, candidate.activityType);
      if (!card) throw new Error(`missing ${candidate.activityType} card`);
      const eventId = `fabricated-pronunciation-choice-${index + 1}`;
      await expect(
        ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
          eventId,
          deviceId: `direct-card:${candidate.simplified}:${candidate.activityType}`,
          deviceSeq: 1,
          occurredAt: `2026-08-30T03:1${index}:00Z`,
          cardId: card.cardId,
          studySessionId: `direct-card:${candidate.simplified}:${candidate.activityType}`,
          mode: "pronunciation",
          activityType: candidate.activityType,
          correct: false,
          metadata: {
            interaction: "choice",
            selectedChoiceId: candidate.fabricated,
            readingId: card.readingId,
          },
        }),
      ).rejects.toThrow("canonical presented choice set");
      await expect(
        env.DB.prepare("SELECT COUNT(*) AS count FROM attempts WHERE event_id = ?")
          .bind(eventId)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
    }
  });

  test("preserves a presented wrong choice across a later content revision", async () => {
    await applyPronunciationFixture();
    const cached = await cardFor("爱", "pinyin_to_hanzi");
    if (!cached) throw new Error("missing cached objective pronunciation card");
    const firstChoiceIds = cached.choices.map(({ id }) => id);
    const presentedWrong = cached.choices.find(({ id }) => id.includes("hang2"));
    if (!presentedWrong) {
      throw new Error(
        `fixture did not present the expected wrong choice: ${JSON.stringify(cached.choices)}`,
      );
    }

    const revisedLexemes = [
      ...fixtureLexemes().map((item) =>
        item.simplified === "行"
          ? lexeme("行", [{ pinyin: "xíng", numeric: "xing2", meanings: ["to walk"] }], 2)
          : item,
      ),
      lexeme("啊", [{ pinyin: "ā", numeric: "a1", meanings: ["ah"] }], 1),
    ];
    await applyStatements(
      await buildV1ImportStatements({
        lexemes: revisedLexemes,
        enrichments: [],
        vocabularyVersion: "pronunciation-choice-revision-vocabulary",
        v1Version: "pronunciation-choice-revision-v1",
        createdAt: 100,
      }),
    );

    const currentChoices = await getCanonicalPronunciationChoiceIds(env.DB, cached.cardId);
    expect(currentChoices.has(presentedWrong.id)).toBe(false);
    const currentOnly = [...currentChoices].find((choiceId) => !firstChoiceIds.includes(choiceId));
    if (!currentOnly) throw new Error("content revision did not change the distractor set");

    const activeCards = await env.DB.prepare(
      `SELECT id FROM cards WHERE subject_type = 'lexeme_reading' AND retired_at IS NULL`,
    ).all<{ id: string }>();
    await env.DB.prepare(
      `UPDATE cards SET retired_at = created_at
       WHERE subject_type = 'lexeme_reading' AND id <> ? AND retired_at IS NULL`,
    )
      .bind(cached.cardId)
      .run();

    let refreshedCard: typeof cached | undefined;
    let refreshedOnlyWrong: (typeof cached.choices)[number] | undefined;
    let evidenceAfterRefresh: string[];
    try {
      const refreshed = await getOfflinePronunciationPack(
        env.DB,
        FIXED_OWNER_LEARNER_ID,
        "direct-card:爱:pinyin_to_hanzi",
        "direct-card:爱:pinyin_to_hanzi",
      );
      expect(refreshed.cards[0]?.cardId).toBe(cached.cardId);
      refreshedCard = refreshed.cards[0];
      if (!refreshedCard) throw new Error("missing re-prepared pronunciation card");
      refreshedOnlyWrong = refreshedCard.choices.find(
        ({ id }) => !firstChoiceIds.includes(id) && id !== refreshedCard?.answerChoiceId,
      );
      if (!refreshedOnlyWrong) {
        throw new Error(
          `re-prepared card did not present a new wrong choice: ${JSON.stringify(refreshedCard.choices)}`,
        );
      }

      evidenceAfterRefresh = await pronunciationPresentationEvidence(cached.cardId);
      expect(evidenceAfterRefresh).toEqual(expect.arrayContaining(firstChoiceIds));
      expect(evidenceAfterRefresh).toContain(refreshedOnlyWrong.id);
      expect(new Set(evidenceAfterRefresh).size).toBe(evidenceAfterRefresh.length);

      const retried = await getOfflinePronunciationPack(
        env.DB,
        FIXED_OWNER_LEARNER_ID,
        "direct-card:爱:pinyin_to_hanzi",
        "direct-card:爱:pinyin_to_hanzi",
      );
      expect(retried.cards[0]?.choices).toEqual(refreshedCard.choices);
      expect(await pronunciationPresentationEvidence(cached.cardId)).toEqual(evidenceAfterRefresh);
    } finally {
      await env.DB.batch(
        activeCards.results.map(({ id }) =>
          env.DB.prepare("UPDATE cards SET retired_at = NULL WHERE id = ?").bind(id),
        ),
      );
    }

    const attempt: AttemptInput = {
      eventId: "content-revised-presented-wrong-choice",
      deviceId: "direct-card:爱:pinyin_to_hanzi",
      deviceSeq: 1,
      occurredAt: "2026-08-30T05:00:00Z",
      cardId: cached.cardId,
      studySessionId: "direct-card:爱:pinyin_to_hanzi",
      mode: "pronunciation",
      activityType: "pinyin_to_hanzi",
      correct: false,
      metadata: {
        interaction: "choice",
        selectedChoiceId: presentedWrong.id,
        readingId: cached.readingId,
      },
    };
    await expect(ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, attempt)).resolves.toMatchObject({
      disposition: "inserted",
    });
    await expect(ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, attempt)).resolves.toMatchObject({
      disposition: "duplicate",
    });
    expect(
      await scalar(
        "SELECT COUNT(*) FROM attempts WHERE event_id = 'content-revised-presented-wrong-choice'",
      ),
    ).toBe(1);

    if (!refreshedCard || !refreshedOnlyWrong) {
      throw new Error("missing re-prepared pronunciation evidence");
    }
    const refreshedAttempt: AttemptInput = {
      ...attempt,
      eventId: "content-revised-reprepared-choice",
      deviceSeq: 2,
      metadata: {
        ...attempt.metadata,
        selectedChoiceId: refreshedOnlyWrong.id,
        readingId: refreshedCard.readingId,
      },
    };
    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, refreshedAttempt),
    ).resolves.toMatchObject({ disposition: "inserted" });
    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, refreshedAttempt),
    ).resolves.toMatchObject({ disposition: "duplicate" });
    expect(
      await scalar(
        "SELECT COUNT(*) FROM attempts WHERE event_id = 'content-revised-reprepared-choice'",
      ),
    ).toBe(1);

    const fabricatedChoice = "reading:never-presented";
    expect(evidenceAfterRefresh).not.toContain(fabricatedChoice);
    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        ...attempt,
        eventId: "content-revised-unpresented-choice",
        deviceSeq: 3,
        metadata: { ...attempt.metadata, selectedChoiceId: fabricatedChoice },
      }),
    ).rejects.toThrow("canonical presented choice set");
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
    expect(
      await scalar(
        `SELECT COUNT(*) FROM cards c
         JOIN lexeme_readings r ON r.id = c.lexeme_reading_id
         WHERE r.lexeme_id = 'lexeme:complete-hsk:%E7%88%B1'
           AND r.numeric_pinyin = 'ai4'
           AND r.retired_at IS NOT NULL
           AND c.retired_at IS NULL`,
      ),
    ).toBe(6);
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
    expect(
      await scalar(
        `SELECT COUNT(*) FROM cards c
         JOIN lexeme_readings r ON r.id = c.lexeme_reading_id
         WHERE r.lexeme_id = 'lexeme:complete-hsk:%E7%88%B1'
           AND r.numeric_pinyin = 'ai4'
           AND r.retired_at IS NOT NULL
           AND c.retired_at IS NULL`,
      ),
    ).toBe(0);
    expect(
      await scalar(
        `SELECT COUNT(*) FROM cards c
         JOIN lexeme_readings r ON r.id = c.lexeme_reading_id
         WHERE r.lexeme_id = 'lexeme:complete-hsk:%E7%88%B1'
           AND r.numeric_pinyin = 'ai4'
           AND r.retired_at IS NOT NULL
           AND c.retired_at IS NOT NULL`,
      ),
    ).toBe(6);
  });

  test("keeps exact-reading audio usable when vocabulary adds an active sibling reading", async () => {
    const original = [
      lexeme("声", [{ pinyin: "shēng", numeric: "sheng1", meanings: ["sound"] }], 1),
    ];
    await applyStatements(
      await buildV1ImportStatements({
        lexemes: original,
        enrichments: [],
        vocabularyVersion: "audio-safety-vocabulary-1",
        v1Version: "audio-safety-v1",
        createdAt: 30,
      }),
    );
    await applyStatements(
      await buildPronunciationImportStatements(
        reliablePronunciationInput(original, "audio-safety-vocabulary-1", 30),
      ),
    );

    const revised = [
      lexeme(
        "声",
        [
          { pinyin: "shēng", numeric: "sheng1", meanings: ["sound"] },
          { pinyin: "shèng", numeric: "sheng4", meanings: ["tone of voice"] },
        ],
        1,
      ),
    ];
    await applyStatements(
      await buildV1ImportStatements({
        lexemes: revised,
        enrichments: [],
        vocabularyVersion: "audio-safety-vocabulary-2",
        v1Version: "audio-safety-v1",
        createdAt: 40,
      }),
    );

    expect(
      await scalar(
        `SELECT COUNT(*) FROM lexeme_readings
         WHERE lexeme_id = 'lexeme:complete-hsk:%E5%A3%B0' AND retired_at IS NULL`,
      ),
    ).toBe(2);
    expect(
      await scalar(
        `SELECT COUNT(*) FROM lexeme_reading_media rm
         JOIN lexeme_readings r ON r.id = rm.lexeme_reading_id
         WHERE r.lexeme_id = 'lexeme:complete-hsk:%E5%A3%B0'`,
      ),
    ).toBe(1);

    const target = await env.DB.prepare(
      `SELECT c.id FROM cards c
       JOIN lexeme_readings r ON r.id = c.lexeme_reading_id
       WHERE r.lexeme_id = 'lexeme:complete-hsk:%E5%A3%B0'
         AND r.numeric_pinyin = 'sheng1'
         AND c.activity_type = 'audio_to_hanzi'
         AND c.retired_at IS NULL`,
    ).first<{ id: string }>();
    if (!target) throw new Error("missing audio safety target card");

    const temporaryRetirement = 9_999_999;
    await env.DB.prepare(
      `UPDATE cards SET retired_at = ?
       WHERE subject_type = 'lexeme_reading' AND retired_at IS NULL AND id <> ?`,
    )
      .bind(temporaryRetirement, target.id)
      .run();
    try {
      await createPronunciationSession(env.DB, FIXED_OWNER_LEARNER_ID, {
        sessionId: "audio-safety-session",
        deviceId: "audio-safety-device",
        focus: "listening",
        maxItems: 1,
      });
      const next = await getNextPronunciationCard(
        env.DB,
        FIXED_OWNER_LEARNER_ID,
        "audio-safety-session",
        "audio-safety-device",
      );
      expect(next).toMatchObject({
        status: "card",
        card: {
          readingId: expect.stringContaining("sheng1"),
          activityType: "audio_to_hanzi",
          media: { url: expect.stringContaining("audio-cmn") },
        },
      });
    } finally {
      await env.DB.prepare(
        `UPDATE cards SET retired_at = NULL
         WHERE subject_type = 'lexeme_reading' AND retired_at = ?`,
      )
        .bind(temporaryRetirement)
        .run();
    }
  });

  test("persists objective perception and ungraded production without FSRS mutation", async () => {
    await applyPronunciationFixture();
    const vocabularyStateBefore = await env.DB.prepare(
      `SELECT card_id, version, due_at, reps FROM card_state ORDER BY card_id LIMIT 1`,
    ).first<Record<string, unknown>>();

    await createPronunciationSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "attempt-session",
      deviceId: "attempt-device",
      focus: "speaking",
      maxItems: 2,
    });
    const production = await getNextPronunciationCard(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "attempt-session",
      "attempt-device",
    );
    expect(production.card?.activityType).toBe("pronunciation_production");
    if (!production.card) throw new Error("missing production card");

    const saved = await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
      eventId: "production-event",
      deviceId: "attempt-device",
      deviceSeq: 1,
      occurredAt: "2026-08-30T04:00:00Z",
      cardId: production.card.cardId,
      studySessionId: "attempt-session",
      mode: "pronunciation",
      activityType: "pronunciation_production",
      responseMs: 900,
      metadata: { interaction: "speak-compare", readingId: production.card.readingId },
    });
    expect(saved).toMatchObject({ reviewCreated: false, cardState: null });

    const persisted = await env.DB.prepare(
      `SELECT correct, score, self_rating FROM attempts WHERE event_id = 'production-event'`,
    ).first<{ correct: number | null; score: number | null; self_rating: number | null }>();
    expect(persisted).toEqual({ correct: null, score: null, self_rating: null });
    expect(
      await scalar("SELECT COUNT(*) FROM fsrs_reviews WHERE attempt_id = 'production-event'"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        `SELECT card_id, version, due_at, reps FROM card_state ORDER BY card_id LIMIT 1`,
      ).first<Record<string, unknown>>(),
    ).toEqual(vocabularyStateBefore);

    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        eventId: "historical-production-event",
        deviceId: "attempt-device",
        deviceSeq: 2,
        occurredAt: "2026-08-30T04:00:30Z",
        cardId: production.card.cardId,
        studySessionId: "attempt-session",
        mode: "pronunciation",
        activityType: "pronunciation_production",
        selfRating: 3,
        responseMs: 900,
        metadata: {
          interaction: "speak-compare-self-rate",
          readingId: production.card.readingId,
        },
      }),
    ).resolves.toMatchObject({ reviewCreated: false, cardState: null });
    await expect(
      env.DB.prepare(
        `SELECT correct, score, self_rating FROM attempts WHERE event_id = 'historical-production-event'`,
      ).first(),
    ).resolves.toEqual({ correct: null, score: null, self_rating: 3 });

    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        eventId: "unmarked-production-rating",
        deviceId: "attempt-device",
        deviceSeq: 5,
        occurredAt: "2026-08-30T04:00:45Z",
        cardId: production.card.cardId,
        studySessionId: "attempt-session",
        mode: "pronunciation",
        activityType: "pronunciation_production",
        selfRating: 2,
        responseMs: 900,
        metadata: { readingId: production.card.readingId },
      }),
    ).rejects.toThrow("legacy speak-compare-self-rate");
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM attempts WHERE event_id = ?")
        .bind("unmarked-production-rating")
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });

    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        eventId: "new-production-rating",
        deviceId: "attempt-device",
        deviceSeq: 6,
        occurredAt: "2026-08-30T04:00:50Z",
        cardId: production.card.cardId,
        studySessionId: "attempt-session",
        mode: "pronunciation",
        activityType: "pronunciation_production",
        selfRating: 2,
        responseMs: 900,
        metadata: {
          interaction: "speak-compare",
          readingId: production.card.readingId,
        },
      }),
    ).rejects.toThrow("legacy speak-compare-self-rate");

    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        eventId: "invalid-production-event",
        deviceId: "attempt-device",
        deviceSeq: 3,
        occurredAt: "2026-08-30T04:01:00Z",
        cardId: production.card.cardId,
        studySessionId: "attempt-session",
        mode: "pronunciation",
        activityType: "pronunciation_production",
        correct: true,
        metadata: { interaction: "speak-compare", readingId: production.card.readingId },
      }),
    ).rejects.toThrow("ungraded");

    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        eventId: "invalid-production-mode",
        deviceId: "attempt-device",
        deviceSeq: 4,
        occurredAt: "2026-08-30T04:01:00Z",
        cardId: production.card.cardId,
        mode: "reflex",
        activityType: "pronunciation_production",
        selfRating: 3,
      }),
    ).rejects.toThrow("require pronunciation mode");
  });

  test("persists an uncached-audio skip as an immutable non-FSRS event", async () => {
    await applyPronunciationFixture();
    await createPronunciationSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "audio-skip-session",
      deviceId: "audio-skip-device",
      focus: "listening",
      maxItems: 1,
    });
    const selected = await getNextPronunciationCard(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "audio-skip-session",
      "audio-skip-device",
    );
    if (!selected.card?.activityType.startsWith("audio_to_") || !selected.card.media) {
      throw new Error("missing exact-reading audio card for skip test");
    }
    const skipped: AttemptInput = {
      eventId: "audio-skip-event",
      deviceId: "audio-skip-device",
      deviceSeq: 1,
      occurredAt: "2026-08-30T04:15:00Z",
      cardId: selected.card.cardId,
      studySessionId: "audio-skip-session",
      mode: "pronunciation",
      activityType: selected.card.activityType,
      responseMs: 250,
      metadata: {
        interaction: PRONUNCIATION_AUDIO_SKIP_INTERACTION,
        reason: PRONUNCIATION_AUDIO_SKIP_REASON,
        readingId: selected.card.readingId,
      },
    };

    expect(await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, skipped)).toMatchObject({
      disposition: "inserted",
      reviewCreated: false,
      cardState: null,
    });
    expect(await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, skipped)).toMatchObject({
      disposition: "duplicate",
    });
    const persisted = await env.DB.prepare(
      `SELECT correct, score, self_rating, metadata_json
         FROM attempts WHERE event_id = ?`,
    )
      .bind(skipped.eventId)
      .first<{
        correct: number | null;
        score: number | null;
        self_rating: number | null;
        metadata_json: string;
      }>();
    expect(persisted).not.toBeNull();
    expect({
      correct: persisted?.correct,
      score: persisted?.score,
      self_rating: persisted?.self_rating,
      metadata: JSON.parse(persisted?.metadata_json ?? "null"),
    }).toEqual({
      correct: null,
      score: null,
      self_rating: null,
      metadata: skipped.metadata,
    });
    expect(
      await scalar("SELECT COUNT(*) FROM fsrs_reviews WHERE attempt_id = 'audio-skip-event'"),
    ).toBe(0);

    const completed = await getNextPronunciationCard(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "audio-skip-session",
      "audio-skip-device",
    );
    expect(completed).toMatchObject({
      status: "completed",
      session: { completedItems: 1, endedAt: expect.any(Number) },
      card: null,
    });
    await expect(
      getPracticeSessionSummary(env.DB, FIXED_OWNER_LEARNER_ID, "audio-skip-session"),
    ).resolves.toMatchObject({
      practice: "pronunciation",
      completedItems: 1,
      configuration: { focus: "listening", requestedItems: 1 },
      evidence: { correctness: null, selfRatings: null, skipped: 1 },
    });

    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        ...skipped,
        eventId: "invalid-audio-skip-reading",
        deviceSeq: 2,
        metadata: { ...skipped.metadata, readingId: "reading:not-the-presented-reading" },
      }),
    ).rejects.toThrow("preserve the exact reading identity");
    await expect(
      ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
        ...skipped,
        eventId: "invalid-audio-skip-grade",
        deviceSeq: 2,
        correct: false,
      }),
    ).rejects.toThrow("must not claim a graded response");
  });

  test("accepts an immutable offline tone fact after its exact reading is retired", async () => {
    await applyPronunciationFixture();
    await createPronunciationSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "retired-offline-session",
      deviceId: "retired-offline-device",
      focus: "tones",
      maxItems: 1,
    });
    const cached = await getNextPronunciationCard(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "retired-offline-session",
      "retired-offline-device",
    );
    if (!cached.card?.answerChoiceId) throw new Error("missing cached tone card");

    await env.DB.batch([
      env.DB.prepare("UPDATE cards SET retired_at = created_at WHERE id = ?").bind(
        cached.card.cardId,
      ),
      env.DB.prepare(
        "UPDATE lexeme_readings SET retired_at = created_at, is_preferred = 0 WHERE id = ?",
      ).bind(cached.card.readingId),
    ]);

    const saved = await ingestAttempt(env.DB, FIXED_OWNER_LEARNER_ID, {
      eventId: "retired-offline-event",
      deviceId: "retired-offline-device",
      deviceSeq: 1,
      occurredAt: "2026-08-30T04:30:00Z",
      cardId: cached.card.cardId,
      studySessionId: "retired-offline-session",
      mode: "pronunciation",
      activityType: cached.card.activityType,
      correct: true,
      metadata: {
        interaction: "choice",
        selectedChoiceId: cached.card.answerChoiceId,
        readingId: cached.card.readingId,
      },
    });

    expect(saved).toMatchObject({ reviewCreated: false, cardState: null });
    expect(
      await scalar("SELECT COUNT(*) FROM fsrs_reviews WHERE attempt_id = 'retired-offline-event'"),
    ).toBe(0);
  });

  test("resumes the same presentation, advances durably, and completes through the Worker API", async () => {
    await applyPronunciationFixture();
    const created = await localJson("/api/pronunciation/sessions", {
      sessionId: "reload-session",
      deviceId: "reload-device",
      focus: "pinyin",
      maxItems: 2,
      practiceContractVersion: currentPracticeContractVersion("pronunciation"),
    });
    expect(created.status).toBe(201);

    const first = (await (
      await localJson("/api/pronunciation/sessions/reload-session/next", {
        deviceId: "reload-device",
        practiceContractVersion: currentPracticeContractVersion("pronunciation"),
      })
    ).json()) as PronunciationNextResult;
    const reload = (await (
      await localJson("/api/pronunciation/sessions/reload-session/next", {
        deviceId: "reload-device",
        practiceContractVersion: currentPracticeContractVersion("pronunciation"),
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
        practiceContractVersion: currentPracticeContractVersion("pronunciation"),
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
        practiceContractVersion: currentPracticeContractVersion("pronunciation"),
      })
    ).json()) as PronunciationNextResult;
    expect(completed).toMatchObject({
      status: "completed",
      session: { completedItems: 2, maxItems: 2 },
      card: null,
    });

    const nextSession = await createPronunciationSession(env.DB, FIXED_OWNER_LEARNER_ID, {
      sessionId: "next-session",
      deviceId: "reload-device",
      focus: "pinyin",
      maxItems: 1,
    });
    expect(nextSession.disposition).toBe("created");
    const rotated = await getNextPronunciationCard(
      env.DB,
      FIXED_OWNER_LEARNER_ID,
      "next-session",
      "reload-device",
    );
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
  const love = lexemes.find(({ simplified }) => simplified === "爱");
  if (!love) throw new Error("pronunciation fixture is missing 爱");
  return {
    lexemes,
    vocabularyVersion: "pronunciation-fixture-vocabulary",
    audioVersion: "pronunciation-fixture-audio",
    audioItems: [
      {
        simplified: "爱",
        status: "reliable",
        targetReadingId: uniqueReadings(love, "lexeme:complete-hsk:%E7%88%B1")[0]!.id,
        mappingBasis: AUDIO_MAPPING_BASIS_SINGLE_READING,
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
      (SELECT current_content_revision FROM content_state WHERE singleton = 1)
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
    `UPDATE cards SET retired_at = created_at
     WHERE subject_type = 'lexeme_reading' AND id <> ?`,
  )
    .bind(row.id)
    .run();
  await createPronunciationSession(env.DB, FIXED_OWNER_LEARNER_ID, {
    sessionId,
    deviceId: sessionId,
    focus: activityType.startsWith("tone_") ? "tones" : "mixed",
    maxItems: 1,
  });
  const card = await getNextPronunciationCard(env.DB, FIXED_OWNER_LEARNER_ID, sessionId, sessionId);
  await env.DB.prepare(
    `UPDATE cards SET retired_at = NULL
     WHERE subject_type = 'lexeme_reading' AND retired_at = created_at`,
  ).run();
  return card.card;
}

async function pronunciationPresentationEvidence(cardId: string): Promise<string[]> {
  const row = await env.DB.prepare(
    "SELECT context_json FROM study_sessions WHERE id = ? AND mode = 'pronunciation'",
  )
    .bind("direct-card:爱:pinyin_to_hanzi")
    .first<{ context_json: string }>();
  if (!row) throw new Error("missing pronunciation session context");
  const context = JSON.parse(row.context_json) as {
    presentedChoiceIds?: Record<string, unknown>;
  };
  const evidence = context.presentedChoiceIds?.[cardId];
  if (!Array.isArray(evidence) || !evidence.every((choiceId) => typeof choiceId === "string")) {
    throw new Error("missing pronunciation presentation evidence");
  }
  return evidence;
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
  const simplified = lexemes[0]?.simplified;
  if (!simplified) throw new Error("reliable pronunciation fixture requires one lexeme");
  return {
    lexemes,
    vocabularyVersion,
    audioVersion: "mapping-audio",
    createdAt,
    audioItems: [
      {
        simplified,
        status: "reliable",
        targetReadingId: uniqueReadings(
          lexemes[0]!,
          `lexeme:complete-hsk:${encodeURIComponent(simplified)}`,
        )[0]!.id,
        mappingBasis: AUDIO_MAPPING_BASIS_SINGLE_READING,
        sourcePath: `64k/hsk/cmn-${simplified}.mp3`,
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
