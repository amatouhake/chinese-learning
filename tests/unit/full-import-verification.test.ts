import { expect, test } from "bun:test";

import { assertFullImportSummary } from "../../scripts/verify-full-import";

const sourceVersion =
  "complete-hsk-vocabulary@7ac65bf1a6387d35f1ade478906172a19311c7f9;" +
  "v1@6bd4b8dfc45a97fdeca20efeeab0d6d81d236847;content-sha256:" +
  "a".repeat(64);

test("full import verification locks the expected corpus shape and provenance", () => {
  const summary = {
    lexemes: 595,
    level_1: 150,
    level_2: 147,
    level_3: 298,
    active_readings: 800,
    active_examples: 595,
    cards: 1190,
    card_states: 1190,
    reading_cards: 5,
    grammar_cards: 5,
    grammar_topics: 5,
    grammar_sentence_links: 5,
    exact_curated_lexeme_links: 18,
    curated_examples: 5,
    sample_lexemes: 3,
    current_scheduler: 1,
    content_changes: 1,
    source_version: sourceVersion,
  };
  expect(() => assertFullImportSummary(summary)).not.toThrow();
  expect(() => assertFullImportSummary({ ...summary, cards: 1189 })).toThrow(
    "full import cards mismatch",
  );
  expect(() => assertFullImportSummary({ ...summary, source_version: "unpinned" })).toThrow(
    "pinned provenance identity",
  );
});
