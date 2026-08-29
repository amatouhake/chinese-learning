import type { CanonicalFsrsReview } from "./types";
import { InvalidInputError } from "./errors";

const UTC_OFFSET_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/i;

export function normalizeUtcInstant(value: string): number {
  if (!UTC_OFFSET_SUFFIX.test(value)) {
    throw new InvalidInputError("occurredAt must include Z or an explicit UTC offset");
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new InvalidInputError("occurredAt must be a valid non-negative UTC instant");
  }

  return milliseconds;
}

export function compareCanonicalReviews(
  left: CanonicalFsrsReview,
  right: CanonicalFsrsReview,
): number {
  return (
    left.occurredAt - right.occurredAt ||
    compareText(left.deviceId, right.deviceId) ||
    left.deviceSeq - right.deviceSeq ||
    compareText(left.eventId, right.eventId)
  );
}

export function semanticOrderKey(review: CanonicalFsrsReview): string {
  const instant = review.occurredAt.toString().padStart(16, "0");
  const deviceSequence = review.deviceSeq.toString().padStart(20, "0");
  return `${instant}\u001f${review.deviceId}\u001f${deviceSequence}\u001f${review.eventId}`;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
