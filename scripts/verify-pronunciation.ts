import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VOCABULARY_REVISION = "7ac65bf1a6387d35f1ade478906172a19311c7f9";
const EXPECTED_V1_REVISION = "6bd4b8dfc45a97fdeca20efeeab0d6d81d236847";
const EXPECTED_AUDIO_REVISION = "ff9ed3d0c631195bd2c06f39450f3264c7124040";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

interface PronunciationDatabaseSummary {
  readings: number;
  scheduled_vocabulary_cards: number;
  vocabulary_card_states: number;
  pronunciation_cards: number;
  pinyin_cards: number;
  single_tone_cards: number;
  tone_pair_cards: number;
  audio_cards: number;
  production_cards: number;
  media_assets: number;
  reading_media_mappings: number;
  ambiguous_media_mappings: number;
  audio_cards_without_media: number;
  pronunciation_card_states: number;
  pronunciation_fsrs_reviews: number;
  content_changes: number;
  source_version: string;
}

interface PronunciationSourceReport {
  lexemes: number;
  readings: number;
  multiReadingLexemes: number;
  sourceFirstFormProperNames: Array<{
    simplified: string;
    pinyin: string;
    meanings: string[];
  }>;
  completeToneReadings: number;
  singleToneReadings: number;
  tonePairReadings: number;
  audioReliable: number;
  audioAmbiguous: number;
  audioMissing: number;
  cards: number;
  staged: number;
  ambiguous: string[];
  missing: string[];
}

if (import.meta.main) await main();

async function main(): Promise<void> {
  const { vocabularyRoot, v1Root, audioRoot } = parseArguments(Bun.argv.slice(2));
  assertRevision(vocabularyRoot, EXPECTED_VOCABULARY_REVISION, "vocabulary");
  assertRevision(v1Root, EXPECTED_V1_REVISION, "v1 enrichment");
  assertRevision(audioRoot, EXPECTED_AUDIO_REVISION, "audio");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "chinese-learning-pronunciation-"));
  const vocabularyImportPath = join(temporaryRoot, "v1-import.sql");
  const pronunciationImportPath = join(temporaryRoot, "pronunciation-import.sql");
  const reportPath = join(temporaryRoot, "pronunciation-report.json");
  const mediaRoot = join(temporaryRoot, "public/media");
  const persistencePath = join(temporaryRoot, "d1");
  const wrangler = join(projectRoot, "node_modules/.bin/wrangler");

  try {
    run([
      process.execPath,
      "run",
      "scripts/import-v1.ts",
      "--vocabulary-root",
      vocabularyRoot,
      "--v1-root",
      v1Root,
      "--output",
      vocabularyImportPath,
    ]);
    run([
      process.execPath,
      "run",
      "scripts/import-pronunciation.ts",
      "--vocabulary-root",
      vocabularyRoot,
      "--audio-root",
      audioRoot,
      "--output",
      pronunciationImportPath,
      "--media-root",
      mediaRoot,
      "--report",
      reportPath,
    ]);
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
      temporaryRoot,
    );
    for (const importPath of [vocabularyImportPath, pronunciationImportPath]) {
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
        temporaryRoot,
      );
    }

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
      temporaryRoot,
      true,
    );
    const databaseSummary = firstResult(JSON.parse(output));
    assertDatabaseSummary(databaseSummary);
    const sourceReport = (await Bun.file(reportPath).json()) as PronunciationSourceReport;
    assertSourceReport(sourceReport);
    console.log(
      JSON.stringify(
        {
          ok: true,
          source: sourceReport,
          database: databaseSummary,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function assertDatabaseSummary(value: unknown): asserts value is PronunciationDatabaseSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pronunciation verification did not return a database summary");
  }
  const summary = value as Record<string, unknown>;
  const expected: Record<string, number> = {
    readings: 800,
    scheduled_vocabulary_cards: 1190,
    vocabulary_card_states: 1190,
    pronunciation_cards: 4039,
    pinyin_cards: 1600,
    single_tone_cards: 435,
    tone_pair_cards: 346,
    audio_cards: 858,
    production_cards: 800,
    media_assets: 429,
    reading_media_mappings: 429,
    ambiguous_media_mappings: 0,
    audio_cards_without_media: 0,
    pronunciation_card_states: 0,
    pronunciation_fsrs_reviews: 0,
    content_changes: 2,
  };
  for (const [field, count] of Object.entries(expected)) {
    if (summary[field] !== count) {
      throw new Error(
        `pronunciation database ${field} mismatch: expected ${count}, received ${String(summary[field])}`,
      );
    }
  }
  const prefix =
    `complete-hsk-vocabulary@${EXPECTED_VOCABULARY_REVISION};` +
    `audio-cmn@${EXPECTED_AUDIO_REVISION};content-sha256:`;
  if (
    typeof summary.source_version !== "string" ||
    !summary.source_version.startsWith(prefix) ||
    !/^[0-9a-f]{64}$/u.test(summary.source_version.slice(prefix.length))
  ) {
    throw new Error("pronunciation source version does not preserve pinned provenance");
  }
}

function assertSourceReport(value: PronunciationSourceReport): void {
  const actual: Record<string, number> = {
    lexemes: value.lexemes,
    readings: value.readings,
    multiReadingLexemes: value.multiReadingLexemes,
    sourceFirstFormProperNames: value.sourceFirstFormProperNames.length,
    completeToneReadings: value.completeToneReadings,
    singleToneReadings: value.singleToneReadings,
    tonePairReadings: value.tonePairReadings,
    audioReliable: value.audioReliable,
    audioAmbiguous: value.audioAmbiguous,
    audioMissing: value.audioMissing,
    cards: value.cards,
    staged: value.staged,
  };
  const expected: Record<string, number> = {
    lexemes: 595,
    readings: 800,
    multiReadingLexemes: 141,
    sourceFirstFormProperNames: 51,
    completeToneReadings: 800,
    singleToneReadings: 435,
    tonePairReadings: 346,
    audioReliable: 429,
    audioAmbiguous: 140,
    audioMissing: 26,
    cards: 4039,
    staged: 429,
  };
  for (const [field, count] of Object.entries(expected)) {
    if (actual[field] !== count) {
      throw new Error(`pronunciation source ${field} mismatch`);
    }
  }
  if (
    value.ambiguous.length !== value.audioAmbiguous ||
    value.missing.length !== value.audioMissing
  ) {
    throw new Error("pronunciation source issue lists do not match their reported counts");
  }
}

function firstResult(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Wrangler returned an unexpected pronunciation verification result");
  }
  const execution = value[0];
  if (typeof execution !== "object" || execution === null) {
    throw new Error("Wrangler returned an invalid pronunciation verification result");
  }
  const results = (execution as Record<string, unknown>).results;
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error("pronunciation verification expected exactly one summary row");
  }
  return results[0];
}

function verificationQuery(): string {
  return `SELECT
    (SELECT COUNT(*) FROM lexeme_readings WHERE retired_at IS NULL) AS readings,
    (SELECT COUNT(*) FROM cards WHERE retired_at IS NULL AND scheduler_eligible = 1)
      AS scheduled_vocabulary_cards,
    (SELECT COUNT(*) FROM card_state) AS vocabulary_card_states,
    (SELECT COUNT(*) FROM cards WHERE retired_at IS NULL AND subject_type = 'lexeme_reading')
      AS pronunciation_cards,
    (SELECT COUNT(*) FROM cards WHERE retired_at IS NULL
      AND activity_type IN ('hanzi_to_pinyin', 'pinyin_to_hanzi')) AS pinyin_cards,
    (SELECT COUNT(*) FROM cards WHERE retired_at IS NULL
      AND activity_type = 'tone_identification') AS single_tone_cards,
    (SELECT COUNT(*) FROM cards WHERE retired_at IS NULL
      AND activity_type = 'tone_pair_identification') AS tone_pair_cards,
    (SELECT COUNT(*) FROM cards WHERE retired_at IS NULL
      AND activity_type IN ('audio_to_hanzi', 'audio_to_meaning')) AS audio_cards,
    (SELECT COUNT(*) FROM cards WHERE retired_at IS NULL
      AND activity_type = 'pronunciation_production') AS production_cards,
    (SELECT COUNT(*) FROM media_assets) AS media_assets,
    (SELECT COUNT(*) FROM lexeme_reading_media) AS reading_media_mappings,
    (SELECT COUNT(*) FROM lexeme_reading_media rm
      JOIN lexeme_readings r ON r.id = rm.lexeme_reading_id
      WHERE (SELECT COUNT(*) FROM lexeme_readings sibling
        WHERE sibling.lexeme_id = r.lexeme_id AND sibling.retired_at IS NULL) <> 1)
      AS ambiguous_media_mappings,
    (SELECT COUNT(*) FROM cards c
      LEFT JOIN lexeme_reading_media rm ON rm.lexeme_reading_id = c.lexeme_reading_id
      WHERE c.retired_at IS NULL
        AND c.activity_type IN ('audio_to_hanzi', 'audio_to_meaning')
        AND rm.media_asset_id IS NULL) AS audio_cards_without_media,
    (SELECT COUNT(*) FROM card_state cs JOIN cards c ON c.id = cs.card_id
      WHERE c.subject_type = 'lexeme_reading') AS pronunciation_card_states,
    (SELECT COUNT(*) FROM fsrs_reviews fr JOIN cards c ON c.id = fr.card_id
      WHERE c.subject_type = 'lexeme_reading') AS pronunciation_fsrs_reviews,
    (SELECT COUNT(*) FROM server_changes WHERE entity_type = 'content') AS content_changes,
    (SELECT source_version FROM content_revisions
      WHERE source = 'chinese-learning pronunciation foundation') AS source_version;`;
}

function parseArguments(arguments_: string[]): {
  vocabularyRoot: string;
  v1Root: string;
  audioRoot: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--vocabulary-root", "--v1-root", "--audio-root"].includes(key ?? "") ||
      value === undefined
    )
      throw usageError();
    if (values.has(key!)) throw usageError(`duplicate option: ${key}`);
    values.set(key!, value);
  }
  const vocabularyRoot = values.get("--vocabulary-root");
  const v1Root = values.get("--v1-root");
  const audioRoot = values.get("--audio-root");
  if (!vocabularyRoot || !v1Root || !audioRoot) throw usageError();
  return { vocabularyRoot, v1Root, audioRoot };
}

function assertRevision(directory: string, expected: string, label: string): void {
  const revision = run(["git", "-C", directory, "rev-parse", "HEAD"], tmpdir(), true).trim();
  if (revision !== expected) {
    throw new Error(`${label} checkout must be pinned to ${expected}; received ${revision}`);
  }
}

function run(command: string[], logDirectory: string = tmpdir(), captureStdout = false): string {
  const result = Bun.spawnSync(command, {
    cwd: projectRoot,
    env: { ...process.env, WRANGLER_LOG_PATH: join(logDirectory, "wrangler.log") },
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
      "Usage: bun run verify:pronunciation -- --vocabulary-root <pinned checkout> " +
      "--v1-root <pinned checkout> --audio-root <pinned checkout>",
  );
}
