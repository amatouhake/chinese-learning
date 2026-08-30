import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VOCABULARY_REVISION = "7ac65bf1a6387d35f1ade478906172a19311c7f9";
const EXPECTED_V1_REVISION = "6bd4b8dfc45a97fdeca20efeeab0d6d81d236847";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export interface FullImportSummary {
  lexemes: number;
  level_1: number;
  level_2: number;
  level_3: number;
  active_readings: number;
  active_examples: number;
  cards: number;
  card_states: number;
  reading_cards: number;
  grammar_cards: number;
  grammar_topics: number;
  grammar_practice_versions: number;
  grammar_sentence_links: number;
  exact_curated_lexeme_links: number;
  curated_examples: number;
  sample_lexemes: number;
  current_scheduler: number;
  content_changes: number;
  source_version: string;
}

if (import.meta.main) await main();

async function main(): Promise<void> {
  const { vocabularyRoot, v1Root } = parseArguments(Bun.argv.slice(2));
  assertRevision(vocabularyRoot, EXPECTED_VOCABULARY_REVISION, "vocabulary");
  assertRevision(v1Root, EXPECTED_V1_REVISION, "v1 enrichment");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "chinese-learning-full-import-"));
  const importPath = join(temporaryRoot, "v1-import.sql");
  const persistencePath = join(temporaryRoot, "d1");
  const wrangler = join(projectRoot, "node_modules/.bin/wrangler");

  try {
    run(
      [
        process.execPath,
        "run",
        "scripts/import-v1.ts",
        "--vocabulary-root",
        vocabularyRoot,
        "--v1-root",
        v1Root,
        "--output",
        importPath,
      ],
      false,
    );
    run(
      [
        wrangler,
        "d1",
        "migrations",
        "apply",
        "chinese-learning",
        "--local",
        "--persist-to",
        persistencePath,
      ],
      false,
      temporaryRoot,
    );
    run(
      [
        wrangler,
        "d1",
        "execute",
        "chinese-learning",
        "--local",
        "--persist-to",
        persistencePath,
        "--file",
        importPath,
        "--json",
      ],
      false,
      temporaryRoot,
    );

    const output = run(
      [
        wrangler,
        "d1",
        "execute",
        "chinese-learning",
        "--local",
        "--persist-to",
        persistencePath,
        "--command",
        verificationQuery(),
        "--json",
      ],
      true,
      temporaryRoot,
    );
    const parsed: unknown = JSON.parse(output);
    const summary = firstResult(parsed);
    assertFullImportSummary(summary);
    console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function assertFullImportSummary(value: unknown): asserts value is FullImportSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("full import verification did not return a summary row");
  }
  const summary = value as Record<string, unknown>;
  const expected: Record<string, number> = {
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
    grammar_practice_versions: 5,
    grammar_sentence_links: 5,
    exact_curated_lexeme_links: 18,
    curated_examples: 5,
    sample_lexemes: 3,
    current_scheduler: 1,
    content_changes: 1,
  };
  for (const [field, count] of Object.entries(expected)) {
    if (summary[field] !== count) {
      throw new Error(
        `full import ${field} mismatch: expected ${count}, received ${String(summary[field])}`,
      );
    }
  }

  const expectedPrefix =
    `complete-hsk-vocabulary@${EXPECTED_VOCABULARY_REVISION};` +
    `v1@${EXPECTED_V1_REVISION};content-sha256:`;
  if (
    typeof summary.source_version !== "string" ||
    !summary.source_version.startsWith(expectedPrefix) ||
    !/^[0-9a-f]{64}$/.test(summary.source_version.slice(expectedPrefix.length))
  ) {
    throw new Error("full import source version does not preserve the pinned provenance identity");
  }
}

function firstResult(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Wrangler returned an unexpected verification result");
  }
  const execution = value[0];
  if (typeof execution !== "object" || execution === null) {
    throw new Error("Wrangler returned an invalid verification result");
  }
  const results = (execution as Record<string, unknown>).results;
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error("full import verification expected exactly one summary row");
  }
  return results[0];
}

function verificationQuery(): string {
  return `SELECT
    (SELECT COUNT(*) FROM lexemes) AS lexemes,
    (SELECT COUNT(*) FROM lexeme_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE t.kind = 'hsk-2.0' AND t.label = 'level-1') AS level_1,
    (SELECT COUNT(*) FROM lexeme_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE t.kind = 'hsk-2.0' AND t.label = 'level-2') AS level_2,
    (SELECT COUNT(*) FROM lexeme_tags lt JOIN tags t ON t.id = lt.tag_id
      WHERE t.kind = 'hsk-2.0' AND t.label = 'level-3') AS level_3,
    (SELECT COUNT(*) FROM lexeme_readings WHERE retired_at IS NULL) AS active_readings,
    (SELECT COUNT(*) FROM sentences WHERE retired_at IS NULL) AS active_examples,
    (SELECT COUNT(*) FROM cards WHERE retired_at IS NULL AND scheduler_eligible = 1) AS cards,
    (SELECT COUNT(*) FROM card_state) AS card_states,
    (SELECT COUNT(*) FROM cards
      WHERE retired_at IS NULL AND subject_type = 'sentence'
        AND activity_type = 'sentence_reading' AND scheduler_eligible = 0) AS reading_cards,
    (SELECT COUNT(*) FROM cards
      WHERE retired_at IS NULL AND subject_type = 'grammar_topic'
        AND activity_type = 'sentence_reading' AND scheduler_eligible = 0) AS grammar_cards,
    (SELECT COUNT(*) FROM grammar_topics
      WHERE source = 'chinese-learning:reading-grammar-foundation') AS grammar_topics,
    (SELECT COUNT(*) FROM grammar_practice_versions) AS grammar_practice_versions,
    (SELECT COUNT(*) FROM sentence_grammar_topics sgt
      JOIN grammar_topics g ON g.id = sgt.grammar_topic_id
      WHERE g.source = 'chinese-learning:reading-grammar-foundation') AS grammar_sentence_links,
    (SELECT COUNT(*) FROM sentence_lexemes sl
      JOIN sentence_grammar_topics sgt ON sgt.sentence_id = sl.sentence_id
      JOIN grammar_topics g ON g.id = sgt.grammar_topic_id
      WHERE g.source = 'chinese-learning:reading-grammar-foundation'
        AND sl.lexeme_reading_id IS NOT NULL) AS exact_curated_lexeme_links,
    (SELECT COUNT(*) FROM sentences
      WHERE retired_at IS NULL
        AND json_extract(metadata_json, '$.reviewStatus') = 'curated-foundation') AS curated_examples,
    (SELECT COUNT(*) FROM lexemes WHERE simplified IN ('爱', '中国', '电脑')) AS sample_lexemes,
    (SELECT COUNT(*) FROM scheduler_configs WHERE is_current = 1) AS current_scheduler,
    (SELECT COUNT(*) FROM server_changes WHERE entity_type = 'content') AS content_changes,
    (SELECT source_version FROM content_revisions
      WHERE source = 'complete-hsk-vocabulary + chinese-learning-v1-enrichment') AS source_version;`;
}

function parseArguments(arguments_: string[]): { vocabularyRoot: string; v1Root: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if ((key !== "--vocabulary-root" && key !== "--v1-root") || value === undefined) {
      throw usageError();
    }
    if (values.has(key)) throw usageError(`duplicate option: ${key}`);
    values.set(key, value);
  }
  const vocabularyRoot = values.get("--vocabulary-root");
  const v1Root = values.get("--v1-root");
  if (!vocabularyRoot || !v1Root) throw usageError();
  return { vocabularyRoot, v1Root };
}

function assertRevision(directory: string, expected: string, label: string): void {
  const revision = run(["git", "-C", directory, "rev-parse", "HEAD"], true).trim();
  if (revision !== expected) {
    throw new Error(`${label} checkout must be pinned to ${expected}; received ${revision}`);
  }
}

function run(command: string[], captureStdout: boolean, logDirectory: string = tmpdir()): string {
  const result = Bun.spawnSync(command, {
    cwd: projectRoot,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: join(logDirectory, "wrangler.log"),
    },
    stdout: captureStdout ? "pipe" : "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`command failed (${command[0]}): ${detail}`);
  }
  return captureStdout ? new TextDecoder().decode(result.stdout) : "";
}

function usageError(reason?: string): Error {
  return new Error(
    (reason ? `${reason}\n` : "") +
      "Usage: bun run verify:full-import -- --vocabulary-root <pinned checkout> " +
      "--v1-root <pinned checkout>",
  );
}
