import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  AUDIO_MAPPING_BASIS_SINGLE_READING,
  AUDIO_MAPPING_BASIS_SOURCE_PRONUNCIATION,
  derivePronunciationImportIdentity,
  pronunciationCoverage,
  resolvePronunciationAudioItem,
  type PronunciationAudioItem,
  type PronunciationImportInput,
} from "../../src/db/pronunciation-import";
import {
  classifyWordAudioMapping,
  deriveTonePair,
  normalizeNumericPinyin,
  normalizeSourcePinyin,
  normalizedPinyinTokens,
  sameNormalizedPinyin,
  singleTone,
  untonedPinyin,
} from "../../src/domain/pronunciation";
import { uniqueReadings } from "../../src/db/v1-import";

describe("pronunciation normalization", () => {
  test("normalizes tone 0 and tone 5 to the neutral tone without losing ü", () => {
    expect(normalizeNumericPinyin("ma0 ma5 lü4 lu:4 nv3")).toEqual([
      { syllable: "ma", tone: 5 },
      { syllable: "ma", tone: 5 },
      { syllable: "lv", tone: 4 },
      { syllable: "lv", tone: 4 },
      { syllable: "nv", tone: 3 },
    ]);
    expect(singleTone(normalizeNumericPinyin("ma5"))).toBe(5);
    expect(untonedPinyin(normalizeNumericPinyin("lv4 xue2"))).toBe("lü xue");
  });

  test("derives only complete two-syllable tone pairs", () => {
    expect(deriveTonePair(normalizeNumericPinyin("ni3 hao3"))).toEqual([3, 3]);
    expect(deriveTonePair(normalizeNumericPinyin("xie4 xie5"))).toEqual([4, 5]);
    expect(deriveTonePair(normalizeNumericPinyin("ni3"))).toBeNull();
    expect(deriveTonePair(normalizeNumericPinyin("ni hao3"))).toBeNull();
    expect(deriveTonePair(normalizeNumericPinyin("gong1 gong4 qi4 che1"))).toBeNull();
  });

  test("normalizes the full tone-marked Mandarin set and source separators", () => {
    expect(normalizeSourcePinyin("mā má mǎ mà mē mé mě mè")).toEqual([
      { syllable: "ma", tone: 1 },
      { syllable: "ma", tone: 2 },
      { syllable: "ma", tone: 3 },
      { syllable: "ma", tone: 4 },
      { syllable: "me", tone: 1 },
      { syllable: "me", tone: 2 },
      { syllable: "me", tone: 3 },
      { syllable: "me", tone: 4 },
    ]);
    expect(normalizeSourcePinyin("mī mí mǐ mì mō mó mǒ mò")).toEqual([
      { syllable: "mi", tone: 1 },
      { syllable: "mi", tone: 2 },
      { syllable: "mi", tone: 3 },
      { syllable: "mi", tone: 4 },
      { syllable: "mo", tone: 1 },
      { syllable: "mo", tone: 2 },
      { syllable: "mo", tone: 3 },
      { syllable: "mo", tone: 4 },
    ]);
    expect(normalizeSourcePinyin("mū mú mǔ mù lǖ lǘ lǚ lǜ")).toEqual([
      { syllable: "mu", tone: 1 },
      { syllable: "mu", tone: 2 },
      { syllable: "mu", tone: 3 },
      { syllable: "mu", tone: 4 },
      { syllable: "lv", tone: 1 },
      { syllable: "lv", tone: 2 },
      { syllable: "lv", tone: 3 },
      { syllable: "lv", tone: 4 },
    ]);
    expect(normalizedPinyinTokens(normalizeSourcePinyin("Nǚʼrén·hǎo"))).toEqual([
      "nv3",
      "ren2",
      "hao3",
    ]);
    expect(normalizedPinyinTokens(normalizeSourcePinyin("liǎo"))).toEqual(["liao3"]);
    expect(normalizeSourcePinyin("nü3-ren2")).toEqual(normalizeSourcePinyin("nǚrén"));
    expect(sameNormalizedPinyin(normalizeSourcePinyin("de"), normalizeNumericPinyin("de5"))).toBe(
      true,
    );
    expect(sameNormalizedPinyin(normalizeSourcePinyin("mā"), normalizeNumericPinyin("ma1"))).toBe(
      true,
    );
    expect(sameNormalizedPinyin(normalizeSourcePinyin("dà"), normalizeNumericPinyin("da"))).toBe(
      false,
    );
  });

  test("migration upgrades legacy ü spellings before pronunciation validation", async () => {
    const database = new Database(":memory:");
    const migrationsRoot = fileURLToPath(new URL("../../migrations/", import.meta.url));
    try {
      for (let index = 1; index <= 10; index += 1) {
        const name = `${String(index).padStart(4, "0")}_${
          [
            "foundation",
            "content_revision_identity",
            "scheduler_bootstrap_and_reading_promotion",
            "reading_retirement",
            "sentence_retirement",
            "scheduler_config_immutability",
            "scheduler_and_session_guards",
            "session_ownership_immutability",
            "semantic_order_keys",
            "study_session_queries",
          ][index - 1]
        }.sql`;
        database.exec(await readFile(`${migrationsRoot}${name}`, "utf8"));
      }
      database.exec(`
        INSERT INTO content_revisions (source, source_version, created_at)
        VALUES ('legacy', 'main', 0);
        INSERT INTO lexemes
          (id, simplified, meanings_json, source, content_revision, created_at, updated_at)
        VALUES ('lexeme:legacy', '女绿', '[]', 'legacy', 1, 0, 0);
        INSERT INTO lexeme_readings
          (id, lexeme_id, pinyin, numeric_pinyin, normalized_syllables_json,
           is_preferred, source, content_revision, created_at)
        VALUES
          ('reading:legacy', 'lexeme:legacy', 'nǚ lǜ', 'nü3 lü4',
           '[{"syllable":"nü","tone":3},{"syllable":"lu:","tone":4}]',
           1, 'legacy', 1, 0);
      `);

      database.exec(await readFile(`${migrationsRoot}0011_pronunciation_media.sql`, "utf8"));
      const row = database
        .query("SELECT normalized_syllables_json AS syllables FROM lexeme_readings")
        .get() as { syllables: string };
      expect(JSON.parse(row.syllables)).toEqual([
        { syllable: "nv", tone: 3 },
        { syllable: "lv", tone: 4 },
      ]);

      database.exec(`
        INSERT INTO media_assets
          (id, media_type, source, source_version, source_path, content_sha256,
           byte_length, mime_type, license, attribution, delivery_key, metadata_json,
           content_revision, created_at)
        VALUES
          ('media:legacy', 'audio', 'audio-cmn', 'legacy', '64k/hsk/cmn-女绿.mp3',
           '${"a".repeat(64)}', 128, 'audio/mpeg', 'CC-BY-SA', 'legacy',
           'audio-cmn/legacy/legacy.mp3', '{}', 1, 0);
        INSERT INTO lexeme_reading_media
          (lexeme_reading_id, media_asset_id, role, mapping_basis, content_revision)
        VALUES ('reading:legacy', 'media:legacy', 'word_pronunciation',
          'exact_hanzi_filename_single_active_reading', 1);
      `);
      database.exec(
        await readFile(`${migrationsRoot}0016_pronunciation_mapping_evidence.sql`, "utf8"),
      );
      const migratedMapping = database
        .query(
          `SELECT mapping_basis, source_text, source_pronunciation,
             normalized_source_pinyin, metadata_source_id
           FROM lexeme_reading_media`,
        )
        .get() as Record<string, string | null>;
      expect(migratedMapping).toEqual({
        mapping_basis: "exact_hanzi_filename_single_active_reading",
        source_text: null,
        source_pronunciation: null,
        normalized_source_pinyin: null,
        metadata_source_id: null,
      });
    } finally {
      database.close();
    }
  });
});

describe("pronunciation source classification", () => {
  test("never guesses a Hanzi-keyed word recording onto one of several readings", () => {
    expect(classifyWordAudioMapping(true, 1)).toBe("reliable");
    expect(classifyWordAudioMapping(true, 2)).toBe("ambiguous");
    expect(classifyWordAudioMapping(false, 1)).toBe("missing");
  });

  test("resolves only one exact active reading from source pronunciation", () => {
    const single = lexeme("爱", [{ pinyin: "ài", numeric: "ai4", meanings: ["love"] }]);
    const singleResult = resolvePronunciationAudioItem(single, audioFile("a"));
    expect(singleResult).toMatchObject({
      status: "reliable",
      targetReadingId: uniqueReadings(single, "lexeme:complete-hsk:%E7%88%B1")[0]?.id,
      mappingBasis: AUDIO_MAPPING_BASIS_SINGLE_READING,
    });

    const polyphonic = lexeme("行", [
      { pinyin: "xíng", numeric: "xing2", meanings: ["walk"] },
      { pinyin: "háng", numeric: "hang2", meanings: ["row"] },
    ]);
    const metadata = metadataSource([
      { sourceText: "行", sourcePronunciation: "xíng", sourcePath: "flac/cmn-x.flac" },
    ]);
    const recovered = resolvePronunciationAudioItem(polyphonic, audioFile("b"), metadata);
    expect(recovered).toMatchObject({
      status: "reliable",
      mappingBasis: AUDIO_MAPPING_BASIS_SOURCE_PRONUNCIATION,
      targetReadingId: uniqueReadings(polyphonic, "lexeme:complete-hsk:%E8%A1%8C")[0]?.id,
      sourceEvidence: {
        sourcePronunciation: "xíng",
        normalizedSourcePinyin: ["xing2"],
      },
    });

    const noMatch = resolvePronunciationAudioItem(
      polyphonic,
      audioFile("c"),
      metadataSource([
        { sourceText: "行", sourcePronunciation: "xǐng", sourcePath: "flac/cmn-y.flac" },
      ]),
    );
    expect(noMatch).toMatchObject({
      status: "ambiguous",
      resolutionReason: "no_matching_canonical_reading",
    });

    const samePronunciation = lexeme("乐", [
      { pinyin: "lè", numeric: "le4", meanings: ["happy"], traditional: "樂" },
      { pinyin: "lè", numeric: "le4", meanings: ["music"], traditional: "乐" },
    ]);
    const multiple = resolvePronunciationAudioItem(
      samePronunciation,
      audioFile("d"),
      metadataSource([
        { sourceText: "乐", sourcePronunciation: "lè", sourcePath: "flac/cmn-z.flac" },
      ]),
    );
    expect(multiple).toMatchObject({
      status: "ambiguous",
      resolutionReason: "multiple_canonical_rows_match",
    });
  });

  test("reports the card and media coverage implied by exact readings", () => {
    const input: PronunciationImportInput = {
      vocabularyVersion: "vocabulary-test",
      audioVersion: "audio-test",
      lexemes: [
        lexeme("爱", [{ pinyin: "ài", numeric: "ai4", meanings: ["to love"] }]),
        lexeme("你好", [{ pinyin: "nǐ hǎo", numeric: "ni3 hao3", meanings: ["hello"] }]),
        lexeme("行", [
          { pinyin: "xíng", numeric: "xing2", meanings: ["to walk"] },
          { pinyin: "háng", numeric: "hang2", meanings: ["row"] },
        ]),
      ],
      audioItems: [
        audio("爱", "reliable", "a"),
        { simplified: "你好", status: "missing" },
        audio("行", "ambiguous", "b"),
      ],
    };

    expect(pronunciationCoverage(input)).toEqual({
      lexemes: 3,
      readings: 4,
      multiReadingLexemes: 1,
      sourceFirstFormProperNames: 0,
      completeToneReadings: 4,
      singleToneReadings: 3,
      tonePairReadings: 1,
      sourceAudioPresent: 2,
      existingReliable: 1,
      recoveredExact: 0,
      totalReliable: 1,
      stillAmbiguous: 1,
      missing: 1,
      pronunciationCards: 18,
      audioCards: 2,
      audioReliable: 1,
      audioAmbiguous: 1,
      audioMissing: 1,
      cards: 18,
    });
  });

  test("pins metadata evidence into a deterministic import identity", async () => {
    const input: PronunciationImportInput = {
      vocabularyVersion: "vocabulary-test",
      audioVersion: "audio-test",
      lexemes: [
        lexeme("行", [
          { pinyin: "xíng", numeric: "xing2", meanings: ["to walk"] },
          { pinyin: "háng", numeric: "hang2", meanings: ["row"] },
        ]),
      ],
      metadataSource: metadataSource([
        { sourceText: "行", sourcePronunciation: "xíng", sourcePath: "flac/cmn-x.flac" },
      ]),
      audioItems: [audio("行", "ambiguous", "a")],
    };
    const first = await derivePronunciationImportIdentity(input);
    const rerun = await derivePronunciationImportIdentity(input);
    const changed = await derivePronunciationImportIdentity({
      ...input,
      metadataSource: {
        ...input.metadataSource!,
        artifactSha256: "f".repeat(64),
      },
    });

    expect(rerun).toEqual(first);
    expect(changed.contentDigest).not.toBe(first.contentDigest);
    expect(changed.sourceVersion).not.toBe(first.sourceVersion);
    expect(first.sourceVersion).toContain("metadata-source@metadata:test");
  });
});

function lexeme(
  simplified: string,
  forms: Array<{
    pinyin: string;
    numeric: string;
    meanings: string[];
    traditional?: string;
  }>,
) {
  return {
    simplified,
    hskLevel: 1,
    forms: forms.map((form) => ({
      traditional: form.traditional ?? simplified,
      transcriptions: { pinyin: form.pinyin, numeric: form.numeric },
      meanings: form.meanings,
    })),
  };
}

function audio(
  simplified: string,
  status: "reliable" | "ambiguous",
  digest: string,
): PronunciationAudioItem {
  const base = {
    simplified,
    sourcePath: `64k/hsk/cmn-${simplified}.mp3`,
    contentSha256: digest.repeat(64),
    byteLength: 128,
  };
  if (status === "ambiguous") {
    return { ...base, status, resolutionReason: "multiple_canonical_rows_match" };
  }
  const canonical = lexeme(simplified, [{ pinyin: "ài", numeric: "ai4", meanings: ["love"] }]);
  return {
    ...base,
    status,
    targetReadingId: uniqueReadings(
      canonical,
      `lexeme:complete-hsk:${encodeURIComponent(simplified)}`,
    )[0]!.id,
    mappingBasis: AUDIO_MAPPING_BASIS_SINGLE_READING,
  };
}

function audioFile(digest: string) {
  return {
    sourcePath: "64k/hsk/cmn-test.mp3",
    contentSha256: digest.repeat(64),
    byteLength: 128,
  };
}

function metadataSource(
  records: Array<{ sourceText: string; sourcePronunciation: string; sourcePath: string }>,
) {
  return {
    id: "metadata:test",
    artifactSha256: "e".repeat(64),
    records: records.map((record) => ({
      ...record,
      normalizedSourcePinyin: normalizedPinyinTokens(
        normalizeSourcePinyin(record.sourcePronunciation),
      ),
    })),
  };
}
