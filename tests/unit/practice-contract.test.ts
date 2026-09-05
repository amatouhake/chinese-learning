import { describe, expect, test } from "bun:test";

import {
  CURRENT_PRACTICE_CONTRACT_VERSIONS,
  LEGACY_PRACTICE_CONTRACT_VERSIONS,
  isCurrentPracticeContract,
  parsePracticeContractVersion,
  parsePracticeContractVersions,
} from "../../src/domain/practice-contract";

describe("practice contract versioning", () => {
  test("interprets omitted wire versions as the explicit legacy contract", () => {
    expect(parsePracticeContractVersions(undefined)).toEqual(LEGACY_PRACTICE_CONTRACT_VERSIONS);
    expect(parsePracticeContractVersion(undefined, "pronunciation")).toBe(1);
    expect(isCurrentPracticeContract("study", LEGACY_PRACTICE_CONTRACT_VERSIONS.study)).toBe(true);
    expect(
      isCurrentPracticeContract("pronunciation", LEGACY_PRACTICE_CONTRACT_VERSIONS.pronunciation),
    ).toBe(false);
  });

  test("keeps unaffected modes current while PR16 modes advance", () => {
    expect(CURRENT_PRACTICE_CONTRACT_VERSIONS).toEqual({
      study: 1,
      reflex: 1,
      pronunciation: 2,
      reading: 2,
      grammar: 2,
    });
    expect(isCurrentPracticeContract("study", 1)).toBe(true);
    expect(isCurrentPracticeContract("reflex", 1)).toBe(true);
    expect(isCurrentPracticeContract("reading", 1)).toBe(false);
  });

  test("rejects malformed positive-version fields", () => {
    expect(() => parsePracticeContractVersions({ pronunciation: 0 })).toThrow("positive integer");
    expect(() => parsePracticeContractVersion("2", "reading")).toThrow("positive integer");
  });
});
