import { isActivityType, isFsrsRating, isPracticeMode, type AttemptInput } from "./types";
import { InvalidInputError } from "./errors";

export function parseAttemptInput(value: unknown): AttemptInput {
  if (!isRecord(value)) {
    throw new InvalidInputError("attempt body must be an object");
  }

  const eventId = requiredText(value.eventId, "eventId");
  const deviceId = requiredText(value.deviceId, "deviceId");
  const cardId = requiredText(value.cardId, "cardId");
  const occurredAt = requiredText(value.occurredAt, "occurredAt");

  if (!isPositiveSafeInteger(value.deviceSeq)) {
    throw new InvalidInputError("deviceSeq must be a positive integer");
  }
  if (!isPracticeMode(value.mode)) {
    throw new InvalidInputError("unknown practice mode");
  }
  if (!isActivityType(value.activityType)) {
    throw new InvalidInputError("unknown activity type");
  }

  const input: AttemptInput = {
    eventId,
    deviceId,
    deviceSeq: value.deviceSeq,
    occurredAt,
    cardId,
    mode: value.mode,
    activityType: value.activityType,
  };

  if (value.studySessionId !== undefined) {
    input.studySessionId = requiredText(value.studySessionId, "studySessionId");
  }
  if (value.correct !== undefined) {
    if (typeof value.correct !== "boolean") {
      throw new InvalidInputError("correct must be boolean");
    }
    input.correct = value.correct;
  }
  if (value.score !== undefined) {
    input.score = finiteNumber(value.score, "score");
  }
  if (value.selfRating !== undefined) {
    if (!isIntegerInRange(value.selfRating, 1, 4)) {
      throw new InvalidInputError("selfRating must be an integer from 1 to 4");
    }
    input.selfRating = value.selfRating;
  }
  if (value.responseMs !== undefined) {
    if (!isNonNegativeSafeInteger(value.responseMs)) {
      throw new InvalidInputError("responseMs must be a non-negative integer");
    }
    input.responseMs = value.responseMs;
  }
  if (value.expectedCardStateVersion !== undefined) {
    if (!isNonNegativeSafeInteger(value.expectedCardStateVersion)) {
      throw new InvalidInputError("expectedCardStateVersion must be a non-negative integer");
    }
    input.expectedCardStateVersion = value.expectedCardStateVersion;
  }
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) throw new InvalidInputError("metadata must be an object");
    input.metadata = value.metadata;
  }
  if (value.fsrsReview !== undefined) {
    if (!isRecord(value.fsrsReview)) {
      throw new InvalidInputError("fsrsReview must be an object");
    }
    if (!isFsrsRating(value.fsrsReview.rating)) {
      throw new InvalidInputError("FSRS rating must be an integer from 1 to 4");
    }
    input.fsrsReview = {
      rating: value.fsrsReview.rating,
      schedulerConfigId: requiredText(
        value.fsrsReview.schedulerConfigId,
        "fsrsReview.schedulerConfigId",
      ),
    };
  }

  return input;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidInputError(`${field} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidInputError(`${field} must be a finite number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}
