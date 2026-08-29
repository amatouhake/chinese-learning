import { InvalidInputError } from "./errors";
import type { CanonicalFsrsReview } from "./types";

const UTF8_ENCODER = new TextEncoder();
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

export function normalizeUtcInstant(value: string): number {
  const match = ISO_INSTANT.exec(value);
  if (!match) {
    throw new InvalidInputError(
      "occurredAt must be an ISO instant with seconds and Z or an explicit UTC offset",
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[10]);
  const validCalendar =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59;
  if (!validCalendar) {
    throw new InvalidInputError("occurredAt contains an invalid calendar or time field");
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new InvalidInputError("occurredAt must be a valid non-negative UTC instant");
  }

  return milliseconds;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }

  if (leftBytes.length < rightBytes.length) return -1;
  if (leftBytes.length > rightBytes.length) return 1;
  return 0;
}
