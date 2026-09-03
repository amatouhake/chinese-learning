import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const migrationsRoot = fileURLToPath(new URL("../../migrations/", import.meta.url));
const reflexMigrationNames = [
  "0013_reflex_session_sequence_guards.sql",
  "0015_learner_identity_foundation.sql",
];

describe("D1 migration compatibility", () => {
  test("migration SQL stays LF-only", () => {
    for (const name of readdirSync(migrationsRoot).filter((entry) => entry.endsWith(".sql"))) {
      expect(readFileSync(`${migrationsRoot}${name}`, "utf8")).not.toContain("\r");
    }
  });

  test("Reflex trigger CASE expressions remain remote-safe", () => {
    for (const name of reflexMigrationNames) {
      const sql = readFileSync(`${migrationsRoot}${name}`, "utf8");
      const parenthesizedCaseCount = [...sql.matchAll(/\bSELECT\s+\(CASE\b/giu)].length;

      expect(parenthesizedCaseCount).toBe(5);
      expect(sql).not.toMatch(/\bSELECT\s+CASE\b/iu);
    }
  });
});
