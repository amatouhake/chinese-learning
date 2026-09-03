import { expect, test } from "bun:test";

import {
  assertProductionConfig,
  LOCAL_FAKE_D1_ID,
  parseJsonc,
  PRODUCTION_ACCESS_SECRET_NAMES,
  PRODUCTION_BUILD_COMMAND,
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

test("production guard requires the standalone production build pipeline", () => {
  const config = productionConfig();
  const errors = validateProductionConfig({
    ...config,
    env: {
      production: {
        ...config.env.production,
        build: { command: "bun run check:production:artifacts" },
      },
    },
  });

  expect(errors).toContain(
    "env.production.build.command must run check:production and check:production:artifacts",
  );
  expect(config.env.production.build.command).toBe(PRODUCTION_BUILD_COMMAND);
});

test("production guard leaves Account ID selection to Wrangler", () => {
  const config = productionConfig();
  expect(config.env.production).not.toHaveProperty("account_id");
  expect(validateProductionConfig(config)).toEqual([]);
});

test("production guard requires Access secrets and rejects plain vars, bypass, and R2", () => {
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
    validateProductionConfig({
      ...base,
      env: {
        production: {
          ...production,
          secrets: { required: ["ACCESS_ISSUER", "ACCESS_AUDIENCE"] },
        },
      },
    }),
  ).toContain(
    "env.production.secrets.required must contain exactly ACCESS_ISSUER, ACCESS_AUDIENCE, and ACCESS_OWNER_SUB",
  );

  expect(
    validateProductionConfig(
      {
        ...base,
        env: {
          production: {
            ...production,
            vars: {
              ...production.vars,
              ACCESS_ISSUER: "https://private-study.cloudflareaccess.com",
              ACCESS_AUDIENCE: "private-study-audience",
              ACCESS_OWNER_SUB: "owner-subject",
            },
          },
        },
      },
      "default",
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining("environment must be exactly production"),
      ...PRODUCTION_ACCESS_SECRET_NAMES.map((name) =>
        expect.stringContaining(`env.production.vars.${name}`),
      ),
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
        workers_dev: true,
        preview_urls: false,
        compatibility_date: "2026-08-29",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          ENVIRONMENT: "production",
          LOCAL_STUDY_BYPASS: "false",
        },
        secrets: { required: [...PRODUCTION_ACCESS_SECRET_NAMES] },
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
