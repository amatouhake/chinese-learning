import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  buildV1ImportSql,
  type V1Enrichment,
  type V1SourceForm,
  type V1SourceLexeme,
} from "../src/db/v1-import";

if (import.meta.main) {
  await main();
}

async function main(): Promise<void> {
  const options = parseArguments(Bun.argv.slice(2));
  const vocabularyVersion = gitHead(options.vocabularyRoot);
  const v1Version = gitHead(options.v1Root);
  const lexemes: V1SourceLexeme[] = [];

  for (const level of options.levels) {
    const path = join(options.vocabularyRoot, "wordlists", "exclusive", "old", `${level}.json`);
    const entries = parseSourceLexemes(await Bun.file(path).json(), level);
    lexemes.push(...entries);
  }
  const selectedLexemes = options.limit === undefined ? lexemes : lexemes.slice(0, options.limit);
  const enrichments = parseEnrichments(
    await Bun.file(join(options.v1Root, "data", "llm_generated.json")).json(),
  );
  const sql = buildV1ImportSql({
    lexemes: selectedLexemes,
    enrichments,
    vocabularyVersion,
    v1Version,
  });

  await mkdir(dirname(options.output), { recursive: true });
  await Bun.write(options.output, sql);
  console.log(
    JSON.stringify({
      output: options.output,
      lexemes: selectedLexemes.length,
      vocabularyVersion,
      v1Version,
    }),
  );
}

interface CliOptions {
  vocabularyRoot: string;
  v1Root: string;
  output: string;
  levels: number[];
  limit?: number;
}

function parseArguments(arguments_: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw usageError();
    }
    values.set(key, value);
  }

  const vocabularyRoot = values.get("--vocabulary-root");
  const v1Root = values.get("--v1-root");
  if (!vocabularyRoot || !v1Root) throw usageError();
  const levels = (values.get("--levels") ?? "1,2,3").split(",").map(Number);
  if (levels.some((level) => !Number.isInteger(level) || level < 1)) throw usageError();
  const limitText = values.get("--limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw usageError();

  return {
    vocabularyRoot,
    v1Root,
    output: values.get("--output") ?? ".generated/v1-import.sql",
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

function parseSourceLexemes(value: unknown, hskLevel: number): V1SourceLexeme[] {
  if (!Array.isArray(value)) throw new Error("vocabulary source must be an array");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.simplified !== "string" || !Array.isArray(entry.forms)) {
      throw new Error("invalid vocabulary source entry");
    }
    const forms = entry.forms.map(parseSourceForm);
    return {
      simplified: entry.simplified,
      frequency: optionalNumber(entry.frequency),
      pos: optionalStringArray(entry.pos),
      forms,
      hskLevel,
    };
  });
}

function parseSourceForm(value: unknown): V1SourceForm {
  if (
    !isRecord(value) ||
    !isRecord(value.transcriptions) ||
    typeof value.transcriptions.pinyin !== "string" ||
    typeof value.transcriptions.numeric !== "string" ||
    !Array.isArray(value.meanings) ||
    !value.meanings.every((meaning) => typeof meaning === "string")
  ) {
    throw new Error("invalid vocabulary reading form");
  }
  return {
    traditional: typeof value.traditional === "string" ? value.traditional : undefined,
    transcriptions: {
      pinyin: value.transcriptions.pinyin,
      numeric: value.transcriptions.numeric,
    },
    meanings: value.meanings,
  };
}

function parseEnrichments(value: unknown): V1Enrichment[] {
  if (!Array.isArray(value)) throw new Error("v1 enrichment source must be an array");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.simplified !== "string") {
      throw new Error("invalid v1 enrichment entry");
    }
    return {
      simplified: entry.simplified,
      meaning_ja: optionalString(entry.meaning_ja),
      example_zh: optionalString(entry.example_zh),
      example_pinyin: optionalString(entry.example_pinyin),
      example_en: optionalString(entry.example_en),
      example_ja: optionalString(entry.example_ja),
    };
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageError(): Error {
  return new Error(
    "Usage: bun run import:v1 -- --vocabulary-root <checkout> --v1-root <checkout> " +
      "[--output .generated/v1-import.sql] [--levels 1,2,3] [--limit N]",
  );
}
