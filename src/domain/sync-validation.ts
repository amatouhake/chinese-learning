import { InvalidInputError } from "./errors";

export interface SyncPullInput {
  cursor: number;
  contentRevision: number | null;
  deviceId: string;
  studySessionId?: string;
  reflexSessionId?: string;
  pronunciationSessionId?: string;
  readingSessionId?: string;
  grammarSessionId?: string;
}

export function parseSyncPullInput(value: unknown): SyncPullInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidInputError("sync pull body must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.cursor) || (record.cursor as number) < 0) {
    throw new InvalidInputError("sync cursor must be a non-negative safe integer");
  }
  if (
    record.contentRevision !== null &&
    (!Number.isSafeInteger(record.contentRevision) || (record.contentRevision as number) < 1)
  ) {
    throw new InvalidInputError("content revision must be null or a positive safe integer");
  }

  const input: SyncPullInput = {
    cursor: record.cursor as number,
    contentRevision: record.contentRevision as number | null,
    deviceId: requiredText(record.deviceId, "deviceId"),
  };
  if (record.studySessionId !== undefined) {
    input.studySessionId = requiredText(record.studySessionId, "studySessionId");
  }
  if (record.reflexSessionId !== undefined) {
    input.reflexSessionId = requiredText(record.reflexSessionId, "reflexSessionId");
  }
  if (record.pronunciationSessionId !== undefined) {
    input.pronunciationSessionId = requiredText(
      record.pronunciationSessionId,
      "pronunciationSessionId",
    );
  }
  if (record.readingSessionId !== undefined) {
    input.readingSessionId = requiredText(record.readingSessionId, "readingSessionId");
  }
  if (record.grammarSessionId !== undefined) {
    input.grammarSessionId = requiredText(record.grammarSessionId, "grammarSessionId");
  }
  return input;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new InvalidInputError(`${field} must be a non-empty string of at most 200 characters`);
  }
  return value;
}
