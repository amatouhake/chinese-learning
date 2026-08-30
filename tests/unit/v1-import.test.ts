import { describe, expect, test } from "bun:test";

import {
  buildV1ImportStatements,
  deriveV1ImportIdentity,
  type V1Enrichment,
  type V1ImportInput,
  type V1SourceLexeme,
} from "../../src/db/v1-import";
import { BEGINNER_GRAMMAR_TOPICS } from "../../src/domain/reading-grammar";

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

  test("fails closed when an included foundation example drifts", async () => {
    const topic = BEGINNER_GRAMMAR_TOPICS[0];
    const input: V1ImportInput = {
      ...importInput([]),
      lexemes: foundationLexemes(topic),
      enrichments: [
        {
          simplified: topic.anchorSimplified,
          meaning_ja: topic.teaching.summaryJa,
          example_zh: "这是学生。",
          example_pinyin: topic.expectedSentence.pinyin,
          example_ja: topic.expectedSentence.meaningJa,
          example_en: topic.expectedSentence.meaningEn,
        },
      ],
    };

    await expect(buildV1ImportStatements(input)).rejects.toThrow(
      `curated grammar sentence drifted for ${topic.id}`,
    );
  });

  test("skips foundation activation when a partial import lacks sentence lexemes", async () => {
    const topic = BEGINNER_GRAMMAR_TOPICS[1];
    const anchor = foundationLexemes(topic).find(
      ({ simplified }) => simplified === topic.anchorSimplified,
    );
    if (!anchor) throw new Error("missing topic anchor fixture");
    const statements = await buildV1ImportStatements({
      ...importInput([]),
      lexemes: [anchor],
      enrichments: [
        {
          simplified: topic.anchorSimplified,
          meaning_ja: topic.teaching.summaryJa,
          example_zh: topic.expectedSentence.chinese,
          example_pinyin: topic.expectedSentence.pinyin,
          example_ja: topic.expectedSentence.meaningJa,
          example_en: topic.expectedSentence.meaningEn,
        },
      ],
    });

    expect(statements.join("\n")).not.toContain(topic.id);
  });
});

function foundationLexemes(topic: (typeof BEGINNER_GRAMMAR_TOPICS)[number]): V1SourceLexeme[] {
  return topic.lexemes.map((link) => ({
    simplified: link.simplified,
    hskLevel: 1,
    forms: [
      {
        traditional: link.simplified,
        transcriptions: { pinyin: link.numericPinyin, numeric: link.numericPinyin },
        meanings: [link.senseIncludes ?? link.simplified],
      },
    ],
  }));
}

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
