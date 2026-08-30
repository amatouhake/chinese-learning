import type { AttemptInput } from "../domain/types";
import { parseAttemptInput } from "../domain/validation";

export const STUDY_STORAGE_KEY = "chinese-learning.study-browser.v1";

export interface BrowserStudyState {
  version: 1;
  deviceId: string;
  nextDeviceSeq: number;
  activeSessionId: string | null;
  pendingAttempt: AttemptInput | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type StudyAttemptDraft = Omit<
  AttemptInput,
  "eventId" | "deviceId" | "deviceSeq" | "occurredAt"
>;

export interface StagedAttempt {
  state: BrowserStudyState;
  attempt: AttemptInput;
}

export function loadOrCreateBrowserStudyState(
  storage: StorageLike,
  createId: () => string = () => crypto.randomUUID(),
): BrowserStudyState {
  const persisted = storage.getItem(STUDY_STORAGE_KEY);
  if (persisted !== null) return parseBrowserStudyState(persisted);

  const state: BrowserStudyState = {
    version: 1,
    deviceId: `browser:${createId()}`,
    nextDeviceSeq: 1,
    activeSessionId: null,
    pendingAttempt: null,
  };
  persist(storage, state);
  return state;
}

export function setActiveStudySession(
  storage: StorageLike,
  state: BrowserStudyState,
  sessionId: string | null,
): BrowserStudyState {
  if (sessionId !== null && sessionId.trim().length === 0) {
    throw new Error("study session ID must be non-empty");
  }
  if (state.pendingAttempt && sessionId !== state.activeSessionId) {
    throw new Error("cannot replace a session while its review is pending");
  }
  const next = { ...state, activeSessionId: sessionId };
  persist(storage, next);
  return next;
}

export function stageStudyAttempt(
  storage: StorageLike,
  state: BrowserStudyState,
  draft: StudyAttemptDraft,
  createId: () => string = () => crypto.randomUUID(),
  now: () => number = () => Date.now(),
): StagedAttempt {
  if (state.pendingAttempt) throw new Error("a study review is already pending delivery");
  if (!state.activeSessionId || draft.studySessionId !== state.activeSessionId) {
    throw new Error("a study review must belong to the active session");
  }
  if (state.nextDeviceSeq >= Number.MAX_SAFE_INTEGER) {
    throw new Error("browser device sequence is exhausted");
  }

  const occurredAt = now();
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
    throw new Error("study attempt time must be a non-negative integer");
  }
  const attempt: AttemptInput = {
    ...draft,
    eventId: `study-event:${createId()}`,
    deviceId: state.deviceId,
    deviceSeq: state.nextDeviceSeq,
    occurredAt: new Date(occurredAt).toISOString(),
  };
  const next: BrowserStudyState = {
    ...state,
    nextDeviceSeq: state.nextDeviceSeq + 1,
    pendingAttempt: attempt,
  };

  // The sequence reservation and complete retry payload reach durable storage
  // before the caller is allowed to send the request.
  persist(storage, next);
  return { state: next, attempt };
}

export function clearPendingStudyAttempt(
  storage: StorageLike,
  state: BrowserStudyState,
  eventId: string,
): BrowserStudyState {
  if (!state.pendingAttempt || state.pendingAttempt.eventId !== eventId) {
    throw new Error("pending study review identity changed before acknowledgement");
  }
  const next = { ...state, pendingAttempt: null };
  persist(storage, next);
  return next;
}

function parseBrowserStudyState(json: string): BrowserStudyState {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("stored study identity is unreadable; refusing to replace it");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stored study identity has an invalid shape; refusing to replace it");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.deviceId !== "string" ||
    record.deviceId.trim().length === 0 ||
    !Number.isSafeInteger(record.nextDeviceSeq) ||
    (record.nextDeviceSeq as number) < 1 ||
    !(
      record.activeSessionId === null ||
      (typeof record.activeSessionId === "string" && record.activeSessionId.trim().length > 0)
    )
  ) {
    throw new Error("stored study identity is invalid; refusing to replace it");
  }

  let pendingAttempt: AttemptInput | null = null;
  if (record.pendingAttempt !== null) {
    try {
      pendingAttempt = parseAttemptInput(record.pendingAttempt);
    } catch {
      throw new Error("stored pending study review is invalid; refusing to discard it");
    }
    if (
      pendingAttempt.deviceId !== record.deviceId ||
      pendingAttempt.deviceSeq >= (record.nextDeviceSeq as number) ||
      pendingAttempt.studySessionId !== record.activeSessionId
    ) {
      throw new Error("stored pending study review conflicts with browser identity");
    }
  }

  return {
    version: 1,
    deviceId: record.deviceId,
    nextDeviceSeq: record.nextDeviceSeq as number,
    activeSessionId: record.activeSessionId as string | null,
    pendingAttempt,
  };
}

function persist(storage: StorageLike, state: BrowserStudyState): void {
  storage.setItem(STUDY_STORAGE_KEY, JSON.stringify(state));
}
