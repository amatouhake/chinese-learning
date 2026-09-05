import { InvalidInputError } from "./errors";
import { parsePracticeContractVersion } from "./practice-contract";

export const DEFAULT_GUIDED_SESSION_SIZE = 5;
export const MAX_GUIDED_SESSION_SIZE = 10;

export interface CreateReadingSessionInput {
  sessionId: string;
  deviceId: string;
  maxItems: number;
  practiceContractVersion?: number;
}

export interface CreateGrammarSessionInput extends CreateReadingSessionInput {
  topicId?: string;
}

export interface NextGuidedCardInput {
  deviceId: string;
  practiceContractVersion?: number;
}

export function parseCreateReadingSessionInput(value: unknown): CreateReadingSessionInput {
  const body = requiredRecord(value, "reading session body");
  return parseBaseSession(body, "reading");
}

export function parseCreateGrammarSessionInput(value: unknown): CreateGrammarSessionInput {
  const body = requiredRecord(value, "grammar session body");
  const input: CreateGrammarSessionInput = parseBaseSession(body, "grammar");
  if (body.topicId !== undefined) input.topicId = boundedText(body.topicId, "topicId");
  return input;
}

export function parseNextGuidedCardInput(
  value: unknown,
  mode: "reading" | "grammar" = "reading",
): NextGuidedCardInput {
  const body = requiredRecord(value, "next guided card body");
  return {
    deviceId: boundedText(body.deviceId, "deviceId"),
    practiceContractVersion: parsePracticeContractVersion(body.practiceContractVersion, mode),
  };
}

function parseBaseSession(
  body: Record<string, unknown>,
  mode: "reading" | "grammar",
): CreateReadingSessionInput {
  return {
    sessionId: boundedText(body.sessionId, "sessionId"),
    deviceId: boundedText(body.deviceId, "deviceId"),
    maxItems:
      body.maxItems === undefined
        ? DEFAULT_GUIDED_SESSION_SIZE
        : boundedInteger(body.maxItems, "maxItems", 1, MAX_GUIDED_SESSION_SIZE),
    practiceContractVersion: parsePracticeContractVersion(body.practiceContractVersion, mode),
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
