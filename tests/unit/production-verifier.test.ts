import { expect, test } from "bun:test";

import {
  assertSelectOnlySql,
  buildProductionVerificationCommand,
} from "../../scripts/verify-production";

test("production verifier targets only the explicit production D1 environment", () => {
  const command = buildProductionVerificationCommand("wrangler");
  expect(command).toEqual([
    "wrangler",
    "d1",
    "execute",
    "chinese-learning-production",
    "--remote",
    "--env",
    "production",
    "--config",
    "wrangler.jsonc",
    "--command",
    expect.stringMatching(/^SELECT\b/u),
    "--json",
  ]);
  expect(command[command.indexOf("--command") + 1]).toContain("FROM lexemes");
  expect(command).not.toContain("--local");
});

test("production verifier passes an alternate config path to Wrangler", () => {
  const command = buildProductionVerificationCommand("wrangler", "./alternate-wrangler.jsonc");
  expect(command).toContain("--config");
  expect(command[command.indexOf("--config") + 1]).toBe("./alternate-wrangler.jsonc");
});

test("production verifier refuses non-SELECT or multi-statement SQL", () => {
  expect(() => assertSelectOnlySql("UPDATE cards SET id = id")).toThrow("must start with SELECT");
  expect(() => assertSelectOnlySql("SELECT 1; DELETE FROM cards")).toThrow("one statement");
  expect(() => assertSelectOnlySql("SELECT 1 FROM cards WHERE note = 'UPDATE'")).toThrow(
    "mutating SQL keyword",
  );
  expect(() => assertSelectOnlySql("SELECT COUNT(*) FROM cards;")).not.toThrow();
});
