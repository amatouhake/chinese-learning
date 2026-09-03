import { readFileSync } from "node:fs";

import { configuredValue } from "../src/worker/auth";

export const PRODUCTION_ENVIRONMENT = "production";
export const PRODUCTION_WORKER_NAME = "chinese-learning-production";
export const PRODUCTION_DATABASE_NAME = "chinese-learning-production";
export const PRODUCTION_ACCOUNT_ID_PLACEHOLDER = "__SET_AFTER_CLOUDFLARE_ACCOUNT_SETUP__";
export const LOCAL_FAKE_D1_ID = "00000000-0000-0000-0000-000000000001";
export const PRODUCTION_D1_PLACEHOLDER = "__SET_AFTER_D1_CREATE__";
export const ACCESS_CONFIG_PLACEHOLDER = "__SET_AFTER_ACCESS_SETUP__";

export function validateProductionConfig(config: unknown, environment = "production"): string[] {
  const errors: string[] = [];
  if (environment !== PRODUCTION_ENVIRONMENT) {
    errors.push(`environment must be exactly ${PRODUCTION_ENVIRONMENT}`);
  }
  if (!isRecord(config)) return ["Wrangler configuration must be an object"];
  expectEqual(errors, config.name, "chinese-learning", "top-level name");

  const environments = config.env;
  if (!isRecord(environments)) return ["wrangler.jsonc must declare env.production explicitly"];
  const production = environments[PRODUCTION_ENVIRONMENT];
  if (!isRecord(production)) return ["wrangler.jsonc is missing env.production"];

  expectEqual(errors, production.name, PRODUCTION_WORKER_NAME, "env.production.name");
  if (!isCloudflareAccountId(stringValue(production.account_id))) {
    errors.push(
      "env.production.account_id must be a valid Cloudflare Account ID supplied after account setup",
    );
  }
  expectEqual(errors, production.workers_dev, true, "env.production.workers_dev");
  expectEqual(errors, production.preview_urls, false, "env.production.preview_urls");
  expectEqual(
    errors,
    production.compatibility_date,
    "2026-08-29",
    "env.production.compatibility_date",
  );
  if (
    !Array.isArray(production.compatibility_flags) ||
    !production.compatibility_flags.includes("nodejs_compat")
  ) {
    errors.push("env.production.compatibility_flags must include nodejs_compat");
  }

  const vars = production.vars;
  if (!isRecord(vars)) {
    errors.push("env.production.vars must be explicit");
  } else {
    expectEqual(
      errors,
      vars.ENVIRONMENT,
      PRODUCTION_ENVIRONMENT,
      "env.production.vars.ENVIRONMENT",
    );
    expectEqual(errors, vars.LOCAL_STUDY_BYPASS, "false", "env.production.vars.LOCAL_STUDY_BYPASS");
    if (!validAccessIssuer(vars.ACCESS_ISSUER)) {
      errors.push("env.production.vars.ACCESS_ISSUER must be a configured HTTPS Access issuer");
    }
    for (const name of ["ACCESS_AUDIENCE", "ACCESS_OWNER_SUB"] as const) {
      if (!configuredValue(stringValue(vars[name]))) {
        errors.push(`env.production.vars.${name} must be configured`);
      }
    }
    if (Object.hasOwn(vars, "ATTEMPT_WRITE_TOKEN")) {
      errors.push("env.production.vars must not contain ATTEMPT_WRITE_TOKEN");
    }
  }

  const secrets = production.secrets;
  if (!isRecord(secrets) || !Array.isArray(secrets.required)) {
    errors.push("env.production.secrets.required must be explicit");
  } else if (secrets.required.length > 0) {
    errors.push("env.production must not require the browser ATTEMPT_WRITE_TOKEN secret");
  }

  const assets = production.assets;
  if (!isRecord(assets)) {
    errors.push("env.production.assets must be explicit");
  } else {
    expectEqual(errors, assets.directory, "./dist", "env.production.assets.directory");
    expectEqual(errors, assets.binding, "ASSETS", "env.production.assets.binding");
    expectEqual(
      errors,
      assets.not_found_handling,
      "single-page-application",
      "env.production.assets.not_found_handling",
    );
    if (!sameStringArray(assets.run_worker_first, ["/api/*", "/mcp", "/mcp/*"])) {
      errors.push("env.production.assets.run_worker_first must cover /api/* and /mcp/*");
    }
  }

  const databases = production.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 1 || !isRecord(databases[0])) {
    errors.push("env.production.d1_databases must contain exactly one explicit DB binding");
  } else {
    const database = databases[0];
    expectEqual(errors, database.binding, "DB", "env.production.d1_databases[0].binding");
    expectEqual(
      errors,
      database.database_name,
      PRODUCTION_DATABASE_NAME,
      "env.production.d1_databases[0].database_name",
    );
    expectEqual(
      errors,
      database.migrations_dir,
      "./migrations",
      "env.production.d1_databases[0].migrations_dir",
    );
    const databaseId = stringValue(database.database_id);
    if (!databaseId || !isRealUuid(databaseId)) {
      errors.push(
        "env.production.d1_databases[0].database_id must be the real D1 UUID returned by D1 creation",
      );
    }
  }

  if (!Array.isArray(production.r2_buckets) || production.r2_buckets.length !== 0) {
    errors.push(
      "env.production.r2_buckets must be explicitly empty; pronunciation media uses Static Assets",
    );
  }

  const build = production.build;
  if (!isRecord(build) || typeof build.command !== "string") {
    errors.push("env.production.build.command must run the production and artifact guards");
  } else if (
    !build.command.includes("check:production") ||
    !build.command.includes("check:production:artifacts")
  ) {
    errors.push(
      "env.production.build.command must run check:production and check:production:artifacts",
    );
  }

  const rootVars = config.vars;
  if (isRecord(rootVars) && Object.hasOwn(rootVars, "ATTEMPT_WRITE_TOKEN")) {
    errors.push("top-level vars must not contain ATTEMPT_WRITE_TOKEN");
  }
  const rootSecrets = config.secrets;
  if (isRecord(rootSecrets) && Array.isArray(rootSecrets.required)) {
    if (rootSecrets.required.includes("ATTEMPT_WRITE_TOKEN")) {
      errors.push("top-level secrets must not require ATTEMPT_WRITE_TOKEN");
    }
  }

  return errors;
}

export function assertProductionConfig(config: unknown, environment = "production"): void {
  const errors = validateProductionConfig(config, environment);
  if (errors.length > 0) {
    throw new Error(`production configuration rejected:\n- ${errors.join("\n- ")}`);
  }
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(removeJsonCommentsAndTrailingCommas(text));
}

if (import.meta.main) {
  try {
    const options = parseArguments(Bun.argv.slice(2));
    const config = parseJsonc(readFileSync(options.config, "utf8"));
    assertProductionConfig(config, options.environment);
    console.log(
      JSON.stringify({
        ok: true,
        environment: options.environment,
        worker: PRODUCTION_WORKER_NAME,
        database: PRODUCTION_DATABASE_NAME,
      }),
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
        "Usage: bun run check:production -- --env production [--config wrangler.jsonc]",
      );
    }
    values.set(key, value);
  }
  const environment = values.get("--env");
  if (!environment) {
    throw new Error(
      "Usage: bun run check:production -- --env production [--config wrangler.jsonc]",
    );
  }
  return { config: values.get("--config") ?? "wrangler.jsonc", environment };
}

function validAccessIssuer(value: unknown): boolean {
  const issuer = configuredValue(stringValue(value));
  if (!issuer) return false;
  try {
    const url = new URL(issuer);
    return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isRealUuid(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) &&
    value.toLowerCase() !== LOCAL_FAKE_D1_ID &&
    value !== "00000000-0000-0000-0000-000000000000" &&
    value !== PRODUCTION_D1_PLACEHOLDER
  );
}

function isCloudflareAccountId(value: string | undefined): boolean {
  return typeof value === "string" && /^[0-9a-f]{32}$/iu.test(value) && !/^0+$/u.test(value);
}

function expectEqual(errors: string[], actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) errors.push(`${field} must equal ${String(expected)}`);
}

function sameStringArray(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, i) => item === expected[i])
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeJsonCommentsAndTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false;
        output += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (character === "\n") {
        output += character;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      inLineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }

  return output.replace(/,\s*([}\]])/gu, "$1");
}
