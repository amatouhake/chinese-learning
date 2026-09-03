import { expect, test } from "bun:test";

import {
  assertProductionConfig,
  LOCAL_FAKE_D1_ID,
  parseJsonc,
  PRODUCTION_ACCOUNT_ID_PLACEHOLDER,
  PRODUCTION_D1_PLACEHOLDER,
  validateProductionConfig,
} from "../../scripts/check-production";

test("production guard accepts only a complete explicit production environment", () => {
  const config = productionConfig();
  expect(validateProductionConfig(config)).toEqual([]);
  expect(() => assertProductionConfig(config)).not.toThrow();
  expect(parseJsonc('{ "env": { "production": { "name": "x", }, }, }')).toEqual({
    env: { production: { name: "x" } },
  });
});

test("production guard rejects fake, placeholder, or missing D1 IDs", () => {
  for (const databaseId of [LOCAL_FAKE_D1_ID, PRODUCTION_D1_PLACEHOLDER, undefined]) {
    const errors = validateProductionConfig({
      ...productionConfig(),
      env: {
        production: {
          ...productionConfig().env.production,
          d1_databases: [
            {
              ...productionConfig().env.production.d1_databases[0],
              database_id: databaseId,
            },
          ],
        },
      },
    });
    expect(errors.some((error) => error.includes("real D1 UUID"))).toBe(true);
  }
});

test("production guard rejects missing, placeholder, or invalid Account IDs", () => {
  for (const accountId of [
    undefined,
    PRODUCTION_ACCOUNT_ID_PLACEHOLDER,
    "not-an-account-id",
    "00000000000000000000000000000000",
  ]) {
    const config = productionConfig();
    const errors = validateProductionConfig({
      ...config,
      env: {
        production: {
          ...config.env.production,
          account_id: accountId,
        },
      },
    });

    expect(errors).toContain(
      "env.production.account_id must be a valid Cloudflare Account ID supplied after account setup",
    );
  }
});

test("production guard rejects bypass, missing Access config, wrong environment, and R2", () => {
  const base = productionConfig();
  const production = base.env.production;
  expect(
    validateProductionConfig({
      ...base,
      env: {
        production: {
          ...production,
          vars: { ...production.vars, LOCAL_STUDY_BYPASS: "true" },
          r2_buckets: [{ binding: "MEDIA", bucket_name: "unexpected" }],
        },
      },
    }),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining("LOCAL_STUDY_BYPASS"),
      expect.stringContaining("r2_buckets"),
    ]),
  );
  expect(
    validateProductionConfig(
      {
        ...base,
        env: {
          production: {
            ...production,
            vars: { ...production.vars, ACCESS_AUDIENCE: "__SET_AFTER_ACCESS_SETUP__" },
          },
        },
      },
      "default",
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining("environment must be exactly production"),
      expect.stringContaining("ACCESS_AUDIENCE"),
    ]),
  );
});

function productionConfig() {
  return {
    name: "chinese-learning",
    vars: { ENVIRONMENT: "local", LOCAL_STUDY_BYPASS: "false" },
    secrets: { required: [] },
    env: {
      production: {
        name: "chinese-learning-production",
        account_id: "1234567890abcdef1234567890abcdef",
        workers_dev: true,
        preview_urls: false,
        compatibility_date: "2026-08-29",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          ENVIRONMENT: "production",
          LOCAL_STUDY_BYPASS: "false",
          ACCESS_ISSUER: "https://private-study.cloudflareaccess.com",
          ACCESS_AUDIENCE: "private-study-audience",
          ACCESS_OWNER_SUB: "owner-subject",
        },
        secrets: { required: [] },
        assets: {
          directory: "./dist",
          binding: "ASSETS",
          not_found_handling: "single-page-application",
          run_worker_first: ["/api/*", "/mcp", "/mcp/*"],
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: "chinese-learning-production",
            database_id: "123e4567-e89b-42d3-a456-426614174000",
            migrations_dir: "./migrations",
          },
        ],
        r2_buckets: [],
        observability: { enabled: true, logs: { head_sampling_rate: 1 } },
        build: {
          command:
            "bun run check:production && bun run build:web && bun run check:production:artifacts",
        },
      },
    },
  };
}
