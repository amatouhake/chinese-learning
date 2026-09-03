import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assertProductionConfig,
  parseJsonc,
  PRODUCTION_DATABASE_NAME,
  PRODUCTION_ENVIRONMENT,
} from "./check-production";
import { assertDatabaseSummary, verificationQuery } from "./verify-pronunciation";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export function buildProductionVerificationCommand(
  wrangler = `${projectRoot}/node_modules/.bin/wrangler`,
): string[] {
  const query = verificationQuery();
  assertSelectOnlySql(query);
  return [
    wrangler,
    "d1",
    "execute",
    PRODUCTION_DATABASE_NAME,
    "--remote",
    "--env",
    PRODUCTION_ENVIRONMENT,
    "--command",
    query,
    "--json",
  ];
}

export function assertSelectOnlySql(sql: string): void {
  const normalized = sql.trim();
  if (!/^SELECT\b/iu.test(normalized)) {
    throw new Error("production verification query must start with SELECT");
  }
  if (/[;][\s\S]*\S/u.test(normalized.replace(/;\s*$/u, ""))) {
    throw new Error("production verification query must contain one statement");
  }
  if (
    /\b(?:ALTER|ATTACH|CREATE|DELETE|DROP|DETACH|INSERT|PRAGMA|REPLACE|UPDATE|VACUUM)\b/iu.test(
      normalized,
    )
  ) {
    throw new Error("production verification query contains a mutating SQL keyword");
  }
}

if (import.meta.main) {
  try {
    const options = parseArguments(Bun.argv.slice(2));
    const config = parseJsonc(readFileSync(options.config, "utf8"));
    assertProductionConfig(config, options.environment);

    const command = buildProductionVerificationCommand();
    const result = Bun.spawnSync(command, {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        new TextDecoder().decode(result.stderr).trim() || "remote verification failed",
      );
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
    const summary = firstResult(parsed);
    assertDatabaseSummary(summary);
    console.log(
      JSON.stringify({ ok: true, environment: options.environment, database: summary }, null, 2),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseArguments(arguments_: string[]): { config: string; environment: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!(key === "--config" || key === "--env") || value === undefined || values.has(key)) {
      throw new Error(
        "Usage: bun run verify:production -- --env production [--config wrangler.jsonc]",
      );
    }
    values.set(key, value);
  }
  const environment = values.get("--env");
  if (!environment) {
    throw new Error(
      "Usage: bun run verify:production -- --env production [--config wrangler.jsonc]",
    );
  }
  return { config: values.get("--config") ?? "wrangler.jsonc", environment };
}

function firstResult(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Wrangler returned an unexpected production verification result");
  }
  const execution = value[0];
  if (typeof execution !== "object" || execution === null) {
    throw new Error("Wrangler returned an invalid production verification result");
  }
  const results = (execution as Record<string, unknown>).results;
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error("production verification expected exactly one summary row");
  }
  return results[0];
}
