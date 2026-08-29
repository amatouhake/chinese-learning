import { describe, expect, test } from "bun:test";

import {
  deriveV1ImportIdentity,
  type V1Enrichment,
  type V1ImportInput,
  type V1SourceLexeme,
} from "../../src/db/v1-import";

describe("v1 import identity", () => {
  test("rejects duplicate enrichment identities before deriving a revision", async () => {
    const first: V1Enrichment = {
      simplified: "重",
      meaning_ja: "重い",
      example_zh: "这个很重。",
    };
    const second: V1Enrichment = {
      simplified: "重",
      meaning_ja: "再び",
      example_zh: "请再说一次。",
    };

    for (const enrichments of [
      [first, second],
      [second, first],
    ]) {
      await expect(deriveV1ImportIdentity(importInput(enrichments))).rejects.toThrow(
        "duplicate enrichment identity: 重",
      );
    }
  });

  test("rejects duplicate lexeme identities before deriving a revision", async () => {
    const first = sourceLexeme(1, "zhong4", "heavy");
    const second = sourceLexeme(2, "chong2", "again");

    for (const lexemes of [
      [first, second],
      [second, first],
    ]) {
      await expect(deriveV1ImportIdentity(importInput([], lexemes))).rejects.toThrow(
        "duplicate lexeme identity: 重",
      );
    }
  });
});

function importInput(
  enrichments: V1Enrichment[],
  lexemes: V1SourceLexeme[] = [sourceLexeme(1, "zhong4", "heavy")],
): V1ImportInput {
  return {
    lexemes,
    enrichments,
    vocabularyVersion: "duplicate-enrichment-vocabulary-commit",
    v1Version: "duplicate-enrichment-v1-commit",
  };
}

function sourceLexeme(hskLevel: number, numeric: string, meaning: string): V1SourceLexeme {
  return {
    simplified: "重",
    hskLevel,
    forms: [
      {
        traditional: "重",
        transcriptions: { pinyin: numeric === "zhong4" ? "zhòng" : "chóng", numeric },
        meanings: [meaning],
      },
    ],
  };
}
