import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  buildPronunciationImportSql,
  mediaIdentity,
  pronunciationCoverage,
  type PronunciationAudioItem,
  type PronunciationImportInput,
} from "../src/db/pronunciation-import";
import { uniqueReadings, type V1SourceLexeme } from "../src/db/v1-import";
import { classifyWordAudioMapping } from "../src/domain/pronunciation";
import { assertCleanImportedPaths, parseSourceLexemes } from "./import-v1";

const SUPPORTED_OPTIONS = new Set([
  "--vocabulary-root",
  "--audio-root",
  "--output",
  "--media-root",
  "--report",
  "--levels",
  "--limit",
]);

if (import.meta.main) {
  await main();
}

async function main(): Promise<void> {
  const options = parseArguments(Bun.argv.slice(2));
  const input = await loadPronunciationImportInput(options);
  const sql = await buildPronunciationImportSql(input);
  const coverage = pronunciationCoverage(input);

  await mkdir(dirname(options.output), { recursive: true });
  await Bun.write(options.output, sql);
  const staged = await stageReliableAudio(input, options.audioRoot, options.mediaRoot);
  const report = {
    ok: true,
    vocabularyVersion: input.vocabularyVersion,
    audioVersion: input.audioVersion,
    ...coverage,
    staged,
    ambiguous: input.audioItems
      .filter(({ status }) => status === "ambiguous")
      .map(({ simplified }) => simplified),
    missing: input.audioItems
      .filter(({ status }) => status === "missing")
      .map(({ simplified }) => simplified),
    sourceFirstFormProperNames: input.lexemes
      .filter(
        (lexeme) =>
          uniqueReadings(
            lexeme,
            `lexeme:complete-hsk:${encodeURIComponent(lexeme.simplified).replaceAll("'", "%27")}`,
          ).length > 1 && /^[A-Z]/u.test(lexeme.forms[0]?.transcriptions.pinyin ?? ""),
      )
      .map((lexeme) => ({
        simplified: lexeme.simplified,
        pinyin: lexeme.forms[0]!.transcriptions.pinyin,
        meanings: lexeme.forms[0]!.meanings,
      })),
  };
  await mkdir(dirname(options.report), { recursive: true });
  await Bun.write(options.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: options.output, report: options.report, ...coverage }));
}

export interface PronunciationCliOptions {
  vocabularyRoot: string;
  audioRoot: string;
  output: string;
  mediaRoot: string;
  report: string;
  levels: number[];
  limit?: number;
}

export async function loadPronunciationImportInput(
  options: Pick<PronunciationCliOptions, "vocabularyRoot" | "audioRoot" | "levels" | "limit">,
): Promise<PronunciationImportInput> {
  const vocabularyVersion = gitHead(options.vocabularyRoot);
  const audioVersion = gitHead(options.audioRoot);
  const vocabularyPaths = options.levels.map((level) => `wordlists/exclusive/old/${level}.json`);
  assertCleanImportedPaths(options.vocabularyRoot, vocabularyPaths, vocabularyVersion);

  const lexemes: V1SourceLexeme[] = [];
  for (const [index, level] of options.levels.entries()) {
    const path = join(options.vocabularyRoot, vocabularyPaths[index] ?? "");
    lexemes.push(...parseSourceLexemes(await Bun.file(path).json(), level));
  }
  const selectedLexemes = options.limit === undefined ? lexemes : lexemes.slice(0, options.limit);
  const audioItems = await inspectAudioItems(options.audioRoot, audioVersion, selectedLexemes);
  return { lexemes: selectedLexemes, vocabularyVersion, audioVersion, audioItems };
}

export async function stageReliableAudio(
  input: PronunciationImportInput,
  audioRoot: string,
  mediaRoot: string,
): Promise<number> {
  let staged = 0;
  for (const item of input.audioItems) {
    if (item.status !== "reliable") continue;
    const identity = mediaIdentity(input.audioVersion, item.simplified, item);
    const sourcePath = item.sourcePath;
    if (!sourcePath) throw new Error(`reliable audio lacks a source path: ${item.simplified}`);
    const destination = join(mediaRoot, identity.deliveryKey);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(audioRoot, sourcePath), destination);
    staged += 1;
  }
  return staged;
}

async function inspectAudioItems(
  audioRoot: string,
  audioVersion: string,
  lexemes: V1SourceLexeme[],
): Promise<PronunciationAudioItem[]> {
  const treeBlobs = gitTreeBlobs(audioRoot, audioVersion, "64k/hsk");
  const items: PronunciationAudioItem[] = [];
  for (const lexeme of lexemes) {
    const sourcePath = `64k/hsk/cmn-${lexeme.simplified}.mp3`;
    const committedBlob = treeBlobs.get(sourcePath);
    const file = Bun.file(join(audioRoot, sourcePath));
    const fileExists = await file.exists();
    if (fileExists && committedBlob === undefined) {
      throw new Error(`audio path is not tracked at ${audioVersion}: ${sourcePath}`);
    }
    if (!fileExists && committedBlob !== undefined) {
      throw new Error(
        `audio path tracked at ${audioVersion} is missing from worktree: ${sourcePath}`,
      );
    }
    const readingCount = uniqueReadings(
      lexeme,
      `lexeme:complete-hsk:${encodeURIComponent(lexeme.simplified).replaceAll("'", "%27")}`,
    ).length;
    const status = classifyWordAudioMapping(fileExists, readingCount);
    if (!fileExists) {
      items.push({ simplified: lexeme.simplified, status });
      continue;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error(`audio file is empty: ${sourcePath}`);
    const worktreeBlob = await gitBlobSha1(bytes);
    if (worktreeBlob !== committedBlob) {
      throw new Error(
        `refusing to attribute modified audio bytes to ${audioVersion}: ${sourcePath}`,
      );
    }
    items.push({
      simplified: lexeme.simplified,
      status,
      sourcePath,
      contentSha256: await digestHex("SHA-256", bytes),
      byteLength: bytes.byteLength,
    });
  }
  return items;
}

function gitTreeBlobs(directory: string, revision: string, treePath: string): Map<string, string> {
  const result = Bun.spawnSync([
    "git",
    "-C",
    directory,
    "ls-tree",
    "-rz",
    revision,
    "--",
    treePath,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`could not inspect audio source tree at ${revision}: ${directory}`);
  }
  const output = new TextDecoder().decode(result.stdout);
  const entries = new Map<string, string>();
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("unexpected git ls-tree output for audio source");
    const metadata = entry.slice(0, tab).split(" ");
    const objectId = metadata[2];
    const path = entry.slice(tab + 1);
    if (!objectId) throw new Error("audio source tree entry has no object ID");
    entries.set(path, objectId);
  }
  return entries;
}

async function gitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const blob = new Uint8Array(header.byteLength + bytes.byteLength);
  blob.set(header);
  blob.set(bytes, header.byteLength);
  return digestHex("SHA-1", blob);
}

async function digestHex(algorithm: "SHA-1" | "SHA-256", bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest(algorithm, input.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseArguments(arguments_: string[]): PronunciationCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || !SUPPORTED_OPTIONS.has(key)) {
      throw usageError(key?.startsWith("--") ? `unsupported import option: ${key}` : undefined);
    }
    if (values.has(key)) throw usageError(`duplicate import option: ${key}`);
    values.set(key, value);
  }

  const vocabularyRoot = values.get("--vocabulary-root");
  const audioRoot = values.get("--audio-root");
  if (!vocabularyRoot || !audioRoot) throw usageError();
  const levels = (values.get("--levels") ?? "1,2,3").split(",").map(Number);
  if (levels.some((level) => !Number.isInteger(level) || level < 1)) throw usageError();
  const limitText = values.get("--limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw usageError();

  return {
    vocabularyRoot,
    audioRoot,
    output: values.get("--output") ?? ".generated/pronunciation-import.sql",
    mediaRoot: values.get("--media-root") ?? ".generated/public/media",
    report: values.get("--report") ?? ".generated/pronunciation-report.json",
    levels,
    limit,
  };
}

function gitHead(directory: string): string {
  const result = Bun.spawnSync(["git", "-C", directory, "rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error(`source directory is not a readable Git checkout: ${directory}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function usageError(reason?: string): Error {
  return new Error(
    (reason === undefined ? "" : `${reason}\n`) +
      "Usage: bun run import:pronunciation -- --vocabulary-root <checkout> " +
      "--audio-root <checkout> [--output .generated/pronunciation-import.sql] " +
      "[--media-root .generated/public/media] [--report path] [--levels 1,2,3] [--limit N]",
  );
}
