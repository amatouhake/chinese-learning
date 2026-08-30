import { PRONUNCIATION_FOCUSES, type PronunciationFocus } from "./pronunciation";
import { InvalidInputError } from "./errors";

export const DEFAULT_PRONUNCIATION_SESSION_SIZE = 10;
export const MAX_PRONUNCIATION_SESSION_SIZE = 20;

export interface CreatePronunciationSessionInput {
  sessionId: string;
  deviceId: string;
  focus: PronunciationFocus;
  maxItems: number;
}

export interface NextPronunciationCardInput {
  deviceId: string;
}

export function parseCreatePronunciationSessionInput(
  value: unknown,
): CreatePronunciationSessionInput {
  const body = requiredRecord(value, "pronunciation session body");
  const focus = body.focus ?? "mixed";
  if (typeof focus !== "string" || !(PRONUNCIATION_FOCUSES as readonly string[]).includes(focus)) {
    throw new InvalidInputError("unknown pronunciation focus");
  }
  return {
    sessionId: boundedText(body.sessionId, "sessionId"),
    deviceId: boundedText(body.deviceId, "deviceId"),
    focus: focus as PronunciationFocus,
    maxItems:
      body.maxItems === undefined
        ? DEFAULT_PRONUNCIATION_SESSION_SIZE
        : boundedInteger(body.maxItems, "maxItems", 1, MAX_PRONUNCIATION_SESSION_SIZE),
  };
}

export function parseNextPronunciationCardInput(value: unknown): NextPronunciationCardInput {
  const body = requiredRecord(value, "next pronunciation card body");
  return { deviceId: boundedText(body.deviceId, "deviceId") };
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
