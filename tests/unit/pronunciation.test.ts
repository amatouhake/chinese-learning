import { describe, expect, test } from "bun:test";

import {
  pronunciationCoverage,
  type PronunciationImportInput,
} from "../../src/db/pronunciation-import";
import {
  classifyWordAudioMapping,
  deriveTonePair,
  normalizeNumericPinyin,
  singleTone,
  untonedPinyin,
} from "../../src/domain/pronunciation";

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
});

describe("pronunciation source classification", () => {
  test("never guesses a Hanzi-keyed word recording onto one of several readings", () => {
    expect(classifyWordAudioMapping(true, 1)).toBe("reliable");
    expect(classifyWordAudioMapping(true, 2)).toBe("ambiguous");
    expect(classifyWordAudioMapping(false, 1)).toBe("missing");
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
      audioReliable: 1,
      audioAmbiguous: 1,
      audioMissing: 1,
      cards: 18,
    });
  });
});

function lexeme(
  simplified: string,
  forms: Array<{ pinyin: string; numeric: string; meanings: string[] }>,
) {
  return {
    simplified,
    hskLevel: 1,
    forms: forms.map((form) => ({
      traditional: simplified,
      transcriptions: { pinyin: form.pinyin, numeric: form.numeric },
      meanings: form.meanings,
    })),
  };
}

function audio(simplified: string, status: "reliable" | "ambiguous", digest: string) {
  return {
    simplified,
    status,
    sourcePath: `64k/hsk/cmn-${simplified}.mp3`,
    contentSha256: digest.repeat(64),
    byteLength: 128,
  };
}
