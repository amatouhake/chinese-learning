import { InvalidInputError } from "./errors";
import { parsePracticeContractVersion } from "./practice-contract";
import type { StudyDirection } from "./types";

export const DEFAULT_STUDY_SESSION_SIZE = 10;
export const MAX_STUDY_SESSION_SIZE = 20;

export interface CreateStudySessionInput {
  sessionId: string;
  deviceId: string;
  maxCards: number;
  direction?: StudyDirection;
  practiceContractVersion?: number;
}

export interface NextStudyCardInput {
  deviceId: string;
  practiceContractVersion?: number;
}

export function parseCreateStudySessionInput(value: unknown): CreateStudySessionInput {
  const body = requiredRecord(value, "study session body");
  const maxCards =
    body.maxCards === undefined
      ? DEFAULT_STUDY_SESSION_SIZE
      : boundedInteger(body.maxCards, "maxCards", 1, MAX_STUDY_SESSION_SIZE);

  return {
    sessionId: boundedText(body.sessionId, "sessionId"),
    deviceId: boundedText(body.deviceId, "deviceId"),
    maxCards,
    direction: studyDirection(body.direction),
    practiceContractVersion: parsePracticeContractVersion(body.practiceContractVersion, "study"),
  };
}

export function parseNextStudyCardInput(value: unknown): NextStudyCardInput {
  const body = requiredRecord(value, "next-card body");
  return {
    deviceId: boundedText(body.deviceId, "deviceId"),
    practiceContractVersion: parsePracticeContractVersion(body.practiceContractVersion, "study"),
  };
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidInputError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new InvalidInputError(`${field} must be a non-empty string of at most 200 characters`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new InvalidInputError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function studyDirection(value: unknown): StudyDirection {
  if (value === undefined || value === "mixed") return "mixed";
  if (value === "hanzi_to_meaning" || value === "meaning_to_hanzi") return value;
  throw new InvalidInputError("direction must be mixed, hanzi_to_meaning, or meaning_to_hanzi");
}
