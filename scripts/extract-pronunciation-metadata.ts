import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { format as formatWithPrettier } from "prettier";

import { normalizeSourcePinyin, normalizedPinyinTokens } from "../src/domain/pronunciation";
import { uniqueReadings, type V1SourceLexeme } from "../src/db/v1-import";
import { assertCleanImportedPaths, parseSourceLexemes } from "./import-v1";

const SUPPORTED_OPTIONS = new Set([
  "--index",
  "--vocabulary-root",
  "--audio-root",
  "--output",
  "--levels",
]);
const SOURCE_ID = "shtooka:cmn-caen-tan";
const ARCHIVE_URL =
  "https://fsi-languages.yojik.eu/audiocollections/archives/cmn-caen-tan_flac.tar.xz";
const METADATA_URL =
  "https://fsi-languages.yojik.eu/audiocollections/detailled/cmn-caen-tan/flac/index.tags.txt";
const README_URL =
  "https://fsi-languages.yojik.eu/audiocollections/detailled/cmn-caen-tan/readme.txt";

interface SourceRecord {
  sourceText: string;
  sourcePronunciation: string;
  normalizedSourcePinyin: string[];
  sourcePath: string;
  sourceSection?: string;
}

if (import.meta.main) await main();

async function main(): Promise<void> {
  const options = parseArguments(Bun.argv.slice(2));
  const levels = options.levels;
  const vocabularyPaths = levels.map((level) => `wordlists/exclusive/old/${level}.json`);
  const vocabularyVersion = gitHead(options.vocabularyRoot);
  assertCleanImportedPaths(options.vocabularyRoot, vocabularyPaths, vocabularyVersion);
  const audioVersion = gitHead(options.audioRoot);
  const lexemes: V1SourceLexeme[] = [];
  for (const [index, level] of levels.entries()) {
    const sourcePath = join(options.vocabularyRoot, vocabularyPaths[index] ?? "");
    lexemes.push(...parseSourceLexemes(await Bun.file(sourcePath).json(), level));
  }

  const audioPaths = gitAudioPaths(options.audioRoot, audioVersion);
  const selected = lexemes.filter(
    (lexeme) =>
      uniqueReadings(lexeme, `lexeme:complete-hsk:${encodeURIComponent(lexeme.simplified)}`)
        .length > 1 && audioPaths.has(`64k/hsk/cmn-${lexeme.simplified}.mp3`),
  );
  const source = await parseSourceIndex(options.index);
  const records: SourceRecord[] = [];
  for (const lexeme of selected) {
    const record = source.recordsByText.get(lexeme.simplified);
    if (!record) continue;
    const normalized = normalizedPinyinTokens(normalizeSourcePinyin(record.sourcePronunciation));
    records.push({ ...record, normalizedSourcePinyin: normalized });
  }
  records.sort((left, right) => compareStrings(left.sourceText, right.sourceText));

  const snapshot = {
    schemaVersion: 1,
    source: {
      id: SOURCE_ID,
      name: "cmn-caen-tan / Yue Tan / University of Caen",
      archiveUrl: ARCHIVE_URL,
      archiveBytes: 513222000,
      archiveEtag: '"1e972570-5d81fd0393ded"',
      metadataUrl: METADATA_URL,
      sourceReadmeUrl: README_URL,
      artifactBytes: source.artifactBytes,
      artifactSha256: source.artifactSha256,
      audioCopyright: source.global.SWAC_COLL_COPYRIGHT,
      audioLicense: source.global.SWAC_COLL_LICENSE,
      selectionRevision: `complete-hsk-vocabulary@${vocabularyVersion};audio-cmn@${audioVersion}`,
      extractionMethod:
        "scripts/extract-pronunciation-metadata.ts parses SWAC index tags and selects active multi-reading lexemes with a tracked audio-cmn MP3; no network is used by import.",
      trustedFields: ["SWAC_TEXT", "SWAC_PRON_PHON"],
    },
    records,
  };
  await mkdir(dirname(options.output), { recursive: true });
  await Bun.write(
    options.output,
    await formatWithPrettier(JSON.stringify(snapshot), { filepath: options.output }),
  );
  console.log(
    JSON.stringify({
      output: options.output,
      vocabularyVersion,
      audioVersion,
      multiReadingCandidates: selected.length,
      metadataRecords: records.length,
      missingMetadata: selected.length - records.length,
      artifactSha256: source.artifactSha256,
    }),
  );
}

interface CliOptions {
  index: string;
  vocabularyRoot: string;
  audioRoot: string;
  output: string;
  levels: number[];
}

async function parseSourceIndex(indexPath: string): Promise<{
  artifactBytes: number;
  artifactSha256: string;
  global: Record<string, string>;
  recordsByText: Map<string, SourceRecord>;
}> {
  const bytes = new Uint8Array(await Bun.file(indexPath).arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`SWAC metadata index is empty: ${indexPath}`);
  const text = new TextDecoder().decode(bytes).replaceAll("\r\n", "\n");
  const blocks = text.split(/\n\n+/u);
  const globalBlock = blocks.find((block) => block.startsWith("[GLOBAL]"));
  if (!globalBlock) throw new Error("SWAC metadata index has no GLOBAL block");
  const global = parseFields(globalBlock);
  const recordsByText = new Map<string, SourceRecord>();
  for (const block of blocks) {
    const fileName = /^\[([^\]]+\.flac)\]$/mu.exec(block)?.[1];
    if (!fileName) continue;
    const fields = parseFields(block);
    const sourceText = fields.SWAC_TEXT;
    const sourcePronunciation = fields.SWAC_PRON_PHON;
    if (!sourceText || !sourcePronunciation) continue;
    if (recordsByText.has(sourceText)) {
      throw new Error(`SWAC metadata has duplicate source text: ${sourceText}`);
    }
    recordsByText.set(sourceText, {
      sourceText,
      sourcePronunciation,
      normalizedSourcePinyin: [],
      sourcePath: `flac/${fileName}`,
      sourceSection: fields.SWAC_COLL_SECTION,
    });
  }
  return {
    artifactBytes: bytes.byteLength,
    artifactSha256: await digestHex(bytes),
    global,
    recordsByText,
  };
}

function parseFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of block.split("\n").slice(1)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return fields;
}

function gitAudioPaths(directory: string, revision: string): Set<string> {
  const result = Bun.spawnSync(["git", "-C", directory, "ls-tree", "-rz", "--name-only", revision]);
  if (result.exitCode !== 0) throw new Error(`could not inspect audio source tree at ${revision}`);
  return new Set(new TextDecoder().decode(result.stdout).split("\0").filter(Boolean));
}

function gitHead(directory: string): string {
  const result = Bun.spawnSync(["git", "-C", directory, "rev-parse", "HEAD"]);
  if (result.exitCode !== 0)
    throw new Error(`source directory is not a readable Git checkout: ${directory}`);
  return new TextDecoder().decode(result.stdout).trim();
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseArguments(arguments_: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || !SUPPORTED_OPTIONS.has(key)) {
      throw usageError();
    }
    if (values.has(key)) throw usageError(`duplicate option: ${key}`);
    values.set(key, value);
  }
  const index = values.get("--index");
  const vocabularyRoot = values.get("--vocabulary-root");
  const audioRoot = values.get("--audio-root");
  if (!index || !vocabularyRoot || !audioRoot) throw usageError();
  const levels = (values.get("--levels") ?? "1,2,3").split(",").map(Number);
  if (levels.some((level) => !Number.isInteger(level) || level < 1)) throw usageError();
  return {
    index,
    vocabularyRoot,
    audioRoot,
    output: values.get("--output") ?? "data/pronunciation/shtooka-cmn-caen-tan.json",
    levels,
  };
}

function usageError(reason?: string): Error {
  return new Error(
    (reason ? `${reason}\n` : "") +
      "Usage: bun run scripts/extract-pronunciation-metadata.ts --index <index.tags.txt> " +
      "--vocabulary-root <checkout> --audio-root <checkout> " +
      "[--output data/pronunciation/shtooka-cmn-caen-tan.json] [--levels 1,2,3]",
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
