import { isActivityType, isFsrsRating, isPracticeMode, type AttemptInput } from "./types";

export function parseAttemptInput(value: unknown): AttemptInput {
  if (!isRecord(value)) {
    throw new Error("attempt body must be an object");
  }

  const eventId = requiredText(value.eventId, "eventId");
  const deviceId = requiredText(value.deviceId, "deviceId");
  const cardId = requiredText(value.cardId, "cardId");
  const occurredAt = requiredText(value.occurredAt, "occurredAt");

  if (!isPositiveInteger(value.deviceSeq)) {
    throw new Error("deviceSeq must be a positive integer");
  }
  if (!isPracticeMode(value.mode)) {
    throw new Error("unknown practice mode");
  }
  if (!isActivityType(value.activityType)) {
    throw new Error("unknown activity type");
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
    if (typeof value.correct !== "boolean") throw new Error("correct must be boolean");
    input.correct = value.correct;
  }
  if (value.score !== undefined) {
    input.score = finiteNumber(value.score, "score");
  }
  if (value.selfRating !== undefined) {
    if (!isIntegerInRange(value.selfRating, 1, 4)) {
      throw new Error("selfRating must be an integer from 1 to 4");
    }
    input.selfRating = value.selfRating;
  }
  if (value.responseMs !== undefined) {
    if (!isNonNegativeInteger(value.responseMs)) {
      throw new Error("responseMs must be a non-negative integer");
    }
    input.responseMs = value.responseMs;
  }
  if (value.expectedCardStateVersion !== undefined) {
    if (!isNonNegativeInteger(value.expectedCardStateVersion)) {
      throw new Error("expectedCardStateVersion must be a non-negative integer");
    }
    input.expectedCardStateVersion = value.expectedCardStateVersion;
  }
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) throw new Error("metadata must be an object");
    input.metadata = value.metadata;
  }
  if (value.fsrsReview !== undefined) {
    if (!isRecord(value.fsrsReview)) throw new Error("fsrsReview must be an object");
    if (!isFsrsRating(value.fsrsReview.rating)) {
      throw new Error("FSRS rating must be an integer from 1 to 4");
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
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}
