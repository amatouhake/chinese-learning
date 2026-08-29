import { describe, expect, test } from "bun:test";

import {
  deriveV1ImportIdentity,
  type V1Enrichment,
  type V1ImportInput,
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
});

function importInput(enrichments: V1Enrichment[]): V1ImportInput {
  return {
    lexemes: [
      {
        simplified: "重",
        hskLevel: 1,
        forms: [
          {
            traditional: "重",
            transcriptions: { pinyin: "zhòng", numeric: "zhong4" },
            meanings: ["heavy"],
          },
        ],
      },
    ],
    enrichments,
    vocabularyVersion: "duplicate-enrichment-vocabulary-commit",
    v1Version: "duplicate-enrichment-v1-commit",
  };
}
