import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VOCABULARY_REVISION = "7ac65bf1a6387d35f1ade478906172a19311c7f9";
const EXPECTED_V1_REVISION = "6bd4b8dfc45a97fdeca20efeeab0d6d81d236847";
const EXPECTED_AUDIO_REVISION = "ff9ed3d0c631195bd2c06f39450f3264c7124040";
const EXPECTED_METADATA_SOURCE_ID = "shtooka:cmn-caen-tan";
const EXPECTED_METADATA_ARTIFACT_SHA256 =
  "b6dae2557ee6245d83bb12de1b4ea0ad3b10da9fc25e1e55b206b0c305cd2511";
const EXPECTED_METADATA_SNAPSHOT_SHA256 =
  "b3cb696adef27aa132aa9e219cd619a0baef6188b720ffa779d72e2813ea899b";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export interface PronunciationDatabaseSummary {
  lexemes: number;
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
  legacy_single_reading_mappings: number;
  recovered_exact_mappings: number;
  retired_reading_media: number;
  invalid_mapping_evidence: number;
  metadata_provenance_mismatches: number;
  source_pinyin_mismatches: number;
  unrelated_source_text_mappings: number;
  media_assets_with_multiple_mappings: number;
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
  sourceAudioPresent: number;
  existingReliable: number;
  recoveredExact: number;
  totalReliable: number;
  stillAmbiguous: number;
  missing: number;
  pronunciationCards: number;
  audioCards: number;
  metadataSource: {
    id: string;
    artifactSha256: string;
    snapshotSha256: string;
    recordCount: number;
  };
  newlyRecovered: Array<Record<string, unknown>>;
  unresolvedAmbiguous: Array<{ hanzi: string; reason: string }>;
  missingAudio: Array<{ hanzi: string; reason: string }>;
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

export function assertDatabaseSummary(
  value: unknown,
): asserts value is PronunciationDatabaseSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pronunciation verification did not return a database summary");
  }
  const summary = value as Record<string, unknown>;
  const expected: Record<string, number> = {
    lexemes: 595,
    readings: 800,
    scheduled_vocabulary_cards: 1190,
    vocabulary_card_states: 1190,
    pronunciation_cards: 4141,
    pinyin_cards: 1600,
    single_tone_cards: 435,
    tone_pair_cards: 346,
    audio_cards: 960,
    production_cards: 800,
    media_assets: 480,
    reading_media_mappings: 480,
    legacy_single_reading_mappings: 429,
    recovered_exact_mappings: 51,
    retired_reading_media: 0,
    invalid_mapping_evidence: 0,
    metadata_provenance_mismatches: 0,
    source_pinyin_mismatches: 0,
    unrelated_source_text_mappings: 0,
    media_assets_with_multiple_mappings: 0,
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
    `audio-cmn@${EXPECTED_AUDIO_REVISION};` +
    `metadata-source@${EXPECTED_METADATA_SOURCE_ID};` +
    `metadata-artifact-sha256:${EXPECTED_METADATA_ARTIFACT_SHA256};` +
    `metadata-snapshot-sha256:${EXPECTED_METADATA_SNAPSHOT_SHA256};content-sha256:`;
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
    sourceAudioPresent: value.sourceAudioPresent,
    existingReliable: value.existingReliable,
    recoveredExact: value.recoveredExact,
    totalReliable: value.totalReliable,
    stillAmbiguous: value.stillAmbiguous,
    missing: value.missing,
    pronunciationCards: value.pronunciationCards,
    audioCards: value.audioCards,
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
    sourceAudioPresent: 569,
    existingReliable: 429,
    recoveredExact: 51,
    totalReliable: 480,
    stillAmbiguous: 89,
    missing: 26,
    pronunciationCards: 4141,
    audioCards: 960,
    audioReliable: 480,
    audioAmbiguous: 89,
    audioMissing: 26,
    cards: 4141,
    staged: 480,
  };
  for (const [field, count] of Object.entries(expected)) {
    if (actual[field] !== count) {
      throw new Error(`pronunciation source ${field} mismatch`);
    }
  }
  if (
    value.metadataSource.id !== EXPECTED_METADATA_SOURCE_ID ||
    value.metadataSource.artifactSha256 !== EXPECTED_METADATA_ARTIFACT_SHA256 ||
    value.metadataSource.snapshotSha256 !== EXPECTED_METADATA_SNAPSHOT_SHA256 ||
    value.metadataSource.recordCount !== 140 ||
    value.newlyRecovered.length !== value.recoveredExact ||
    value.unresolvedAmbiguous.length !== value.stillAmbiguous ||
    value.missingAudio.length !== value.missing
  ) {
    throw new Error("pronunciation source evidence report is inconsistent");
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

export function verificationQuery(): string {
  return `SELECT
    (SELECT COUNT(*) FROM lexemes) AS lexemes,
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
      WHERE r.retired_at IS NOT NULL) AS retired_reading_media,
    (SELECT COUNT(*) FROM lexeme_reading_media rm
      WHERE (rm.mapping_basis = 'exact_source_pronunciation_active_reading'
        AND (rm.source_text IS NULL OR rm.source_pronunciation IS NULL
          OR rm.normalized_source_pinyin IS NULL OR rm.metadata_source_id IS NULL
          OR rm.metadata_source_digest IS NULL OR rm.metadata_source_record_path IS NULL))
        OR (rm.mapping_basis = 'exact_hanzi_filename_single_active_reading'
          AND (rm.source_text IS NOT NULL OR rm.source_pronunciation IS NOT NULL
            OR rm.normalized_source_pinyin IS NOT NULL OR rm.metadata_source_id IS NOT NULL
            OR rm.metadata_source_digest IS NOT NULL OR rm.metadata_source_record_path IS NOT NULL)))
      AS invalid_mapping_evidence,
    (SELECT COUNT(*) FROM lexeme_reading_media rm
      WHERE rm.mapping_basis = 'exact_source_pronunciation_active_reading'
        AND (rm.metadata_source_id IS NULL
          OR rm.metadata_source_id <> '${EXPECTED_METADATA_SOURCE_ID}'
          OR rm.metadata_source_digest IS NULL
          OR rm.metadata_source_digest <> '${EXPECTED_METADATA_ARTIFACT_SHA256}'))
      AS metadata_provenance_mismatches,
    (SELECT COUNT(*) FROM lexeme_reading_media rm
      JOIN lexeme_readings r ON r.id = rm.lexeme_reading_id
      WHERE rm.mapping_basis = 'exact_source_pronunciation_active_reading'
        AND (
          json_array_length(rm.normalized_source_pinyin) < 1
          OR json_array_length(rm.normalized_source_pinyin) <> json_array_length(r.normalized_syllables_json)
          OR EXISTS (
            SELECT 1
            FROM json_each(rm.normalized_source_pinyin) source_token
            LEFT JOIN json_each(r.normalized_syllables_json) canonical_token
              ON canonical_token.key = source_token.key
            WHERE canonical_token.key IS NULL
              OR typeof(source_token.value) <> 'text'
              OR length(source_token.value) < 2
              OR substr(source_token.value, -1) NOT IN ('1', '2', '3', '4', '5')
              OR substr(source_token.value, 1, length(source_token.value) - 1)
                <> json_extract(canonical_token.value, '$.syllable')
              OR (
                substr(source_token.value, -1) <> '5'
                AND CAST(substr(source_token.value, -1) AS INTEGER)
                  <> COALESCE(CAST(json_extract(canonical_token.value, '$.tone') AS INTEGER), 0)
              )
              OR (
                substr(source_token.value, -1) = '5'
                AND json_extract(canonical_token.value, '$.tone') IS NOT NULL
                AND json_extract(canonical_token.value, '$.tone') <> 5
              )
          )
        )) AS source_pinyin_mismatches,
    (SELECT COUNT(*) FROM lexeme_reading_media rm
      JOIN lexeme_readings r ON r.id = rm.lexeme_reading_id
      JOIN lexemes l ON l.id = r.lexeme_id
      WHERE rm.mapping_basis = 'exact_source_pronunciation_active_reading'
        AND (rm.source_text IS NULL OR rm.source_text <> l.simplified))
      AS unrelated_source_text_mappings,
    (SELECT COUNT(*) FROM (
      SELECT media_asset_id, role FROM lexeme_reading_media
      GROUP BY media_asset_id, role HAVING COUNT(*) > 1
    )) AS media_assets_with_multiple_mappings,
    (SELECT COUNT(*) FROM lexeme_reading_media
      WHERE mapping_basis = 'exact_hanzi_filename_single_active_reading')
      AS legacy_single_reading_mappings,
    (SELECT COUNT(*) FROM lexeme_reading_media
      WHERE mapping_basis = 'exact_source_pronunciation_active_reading')
      AS recovered_exact_mappings,
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
  const vocabularyRoot =
    values.get("--vocabulary-root") ?? join(tmpdir(), "chinese-learning-complete-hsk-vocabulary");
  const v1Root = values.get("--v1-root") ?? join(tmpdir(), "chinese-learning-v1-source");
  const audioRoot = values.get("--audio-root") ?? join(tmpdir(), "chinese-learning-audio-cmn");
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
      "--v1-root <pinned checkout> --audio-root <pinned checkout> " +
      "(all options default to the documented temporary paths)",
  );
}
