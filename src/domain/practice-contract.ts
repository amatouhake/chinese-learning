import type { PracticeMode } from "./types";
import { InvalidInputError } from "./errors";

/**
 * Contract versions describe the learner-facing interaction and prepared-card
 * shape. They are deliberately independent from imported content revisions.
 *
 * Increment a mode only when its prepared interaction can no longer be safely
 * understood or answered by the previous UI. Keep the old version in
 * LEGACY_PRACTICE_CONTRACT_VERSIONS so omitted wire fields and unversioned
 * browser records have one deterministic meaning.
 */
export const LEGACY_PRACTICE_CONTRACT_VERSIONS = {
  study: 1,
  reflex: 1,
  pronunciation: 1,
  reading: 1,
  grammar: 1,
} as const satisfies Record<PracticeMode, number>;

export const CURRENT_PRACTICE_CONTRACT_VERSIONS = {
  study: 1,
  reflex: 1,
  pronunciation: 2,
  reading: 2,
  grammar: 2,
} as const satisfies Record<PracticeMode, number>;

export type PracticeContractVersions = Record<PracticeMode, number>;

export function currentPracticeContractVersion(mode: PracticeMode): number {
  return CURRENT_PRACTICE_CONTRACT_VERSIONS[mode];
}

export function legacyPracticeContractVersion(mode: PracticeMode): number {
  return LEGACY_PRACTICE_CONTRACT_VERSIONS[mode];
}

export function isCurrentPracticeContract(mode: PracticeMode, version: number): boolean {
  return version === currentPracticeContractVersion(mode);
}

/**
 * Normalize a wire map. A missing map or missing mode is legacy, never current
 * by accident. The returned object is a fresh mutable map for request flow.
 */
export function parsePracticeContractVersions(value: unknown): PracticeContractVersions {
  if (value === undefined) return { ...LEGACY_PRACTICE_CONTRACT_VERSIONS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidInputError("practiceContracts must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    study: parseVersion(record.study, "study"),
    reflex: parseVersion(record.reflex, "reflex"),
    pronunciation: parseVersion(record.pronunciation, "pronunciation"),
    reading: parseVersion(record.reading, "reading"),
    grammar: parseVersion(record.grammar, "grammar"),
  };
}

export function parsePracticeContractVersion(value: unknown, mode: PracticeMode): number {
  return parseVersion(value, mode);
}

function parseVersion(value: unknown, mode: PracticeMode): number {
  if (value === undefined) return legacyPracticeContractVersion(mode);
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new InvalidInputError(`practice contract version for ${mode} must be a positive integer`);
  }
  return value as number;
}
