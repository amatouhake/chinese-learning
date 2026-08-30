import type { AttemptInput } from "../domain/types";
import { parseAttemptInput } from "../domain/validation";
import { PRONUNCIATION_FOCUSES, type PronunciationFocus } from "../domain/pronunciation";

export const STUDY_STORAGE_KEY = "chinese-learning.study-browser.v1";
export const STUDY_STORAGE_LOCK = `${STUDY_STORAGE_KEY}.lock`;

export interface BrowserStudyState {
  version: 3;
  deviceId: string;
  nextDeviceSeq: number;
  activeSessionId: string | null;
  activePronunciationSessionId: string | null;
  activePronunciationFocus: PronunciationFocus | null;
  pendingAttempt: AttemptInput | null;
}

export interface ActivePronunciationSession {
  sessionId: string;
  focus: PronunciationFocus;
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

type StudyLockResult = BrowserStudyState | StagedAttempt;

export interface StudyLockManager {
  request<T extends StudyLockResult>(name: string, callback: () => T): Promise<T>;
}

export async function loadOrCreateBrowserStudyState(
  storage: StorageLike,
  createId: () => string = () => crypto.randomUUID(),
  lockManager: StudyLockManager = browserStudyLockManager(),
): Promise<BrowserStudyState> {
  return lockManager.request(STUDY_STORAGE_LOCK, () => {
    const persisted = storage.getItem(STUDY_STORAGE_KEY);
    if (persisted !== null) {
      const state = parseBrowserStudyState(persisted);
      if ((JSON.parse(persisted) as { version?: unknown }).version !== state.version) {
        persist(storage, state);
      }
      return state;
    }

    const state: BrowserStudyState = {
      version: 3,
      deviceId: `browser:${createId()}`,
      nextDeviceSeq: 1,
      activeSessionId: null,
      activePronunciationSessionId: null,
      activePronunciationFocus: null,
      pendingAttempt: null,
    };
    persist(storage, state);
    return state;
  });
}

export async function setActivePronunciationSession(
  storage: StorageLike,
  state: BrowserStudyState,
  activeSession: ActivePronunciationSession | null,
  lockManager: StudyLockManager = browserStudyLockManager(),
): Promise<BrowserStudyState> {
  if (activeSession !== null && activeSession.sessionId.trim().length === 0) {
    throw new Error("pronunciation session ID must be non-empty");
  }
  if (
    activeSession !== null &&
    !(PRONUNCIATION_FOCUSES as readonly string[]).includes(activeSession.focus)
  ) {
    throw new Error("pronunciation session focus is invalid");
  }
  const sessionId = activeSession?.sessionId ?? null;
  const focus = activeSession?.focus ?? null;
  return lockManager.request(STUDY_STORAGE_LOCK, () => {
    const latest = loadExistingState(storage);
    requireSameDevice(state, latest);
    if (
      latest.pendingAttempt?.mode === "pronunciation" &&
      (sessionId !== latest.activePronunciationSessionId ||
        focus !== latest.activePronunciationFocus)
    ) {
      throw new Error("cannot replace a pronunciation session while its attempt is pending");
    }
    if (
      latest.activePronunciationSessionId !== state.activePronunciationSessionId ||
      latest.activePronunciationFocus !== state.activePronunciationFocus
    ) {
      return latest;
    }
    if (
      sessionId !== null &&
      latest.activePronunciationSessionId !== null &&
      (sessionId !== latest.activePronunciationSessionId ||
        focus !== latest.activePronunciationFocus)
    ) {
      return latest;
    }
    const next = {
      ...latest,
      activePronunciationSessionId: sessionId,
      activePronunciationFocus: focus,
    };
    persist(storage, next);
    return next;
  });
}

export async function setActiveStudySession(
  storage: StorageLike,
  state: BrowserStudyState,
  sessionId: string | null,
  lockManager: StudyLockManager = browserStudyLockManager(),
): Promise<BrowserStudyState> {
  if (sessionId !== null && sessionId.trim().length === 0) {
    throw new Error("study session ID must be non-empty");
  }
  return lockManager.request(STUDY_STORAGE_LOCK, () => {
    const latest = loadExistingState(storage);
    requireSameDevice(state, latest);
    if (latest.pendingAttempt && sessionId !== latest.activeSessionId) {
      throw new Error("cannot replace a session while its review is pending");
    }
    if (latest.activeSessionId !== state.activeSessionId) return latest;
    if (
      sessionId !== null &&
      latest.activeSessionId !== null &&
      sessionId !== latest.activeSessionId
    ) {
      return latest;
    }
    const next = { ...latest, activeSessionId: sessionId };
    persist(storage, next);
    return next;
  });
}

export async function stageStudyAttempt(
  storage: StorageLike,
  state: BrowserStudyState,
  draft: StudyAttemptDraft,
  createId: () => string = () => crypto.randomUUID(),
  now: () => number = () => Date.now(),
  lockManager: StudyLockManager = browserStudyLockManager(),
): Promise<StagedAttempt> {
  return lockManager.request(STUDY_STORAGE_LOCK, () => {
    const latest = loadExistingState(storage);
    requireSameDevice(state, latest);
    if (latest.pendingAttempt) throw new Error("a study review is already pending delivery");
    requireCurrentStateForStaging(state, latest);
    const activeSessionId =
      draft.mode === "pronunciation"
        ? latest.activePronunciationSessionId
        : draft.mode === "study"
          ? latest.activeSessionId
          : null;
    if (!activeSessionId || draft.studySessionId !== activeSessionId) {
      throw new Error("a learning attempt must belong to its active session");
    }
    if (latest.nextDeviceSeq >= Number.MAX_SAFE_INTEGER) {
      throw new Error("browser device sequence is exhausted");
    }

    const occurredAt = now();
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
      throw new Error("study attempt time must be a non-negative integer");
    }
    const attempt: AttemptInput = {
      ...draft,
      eventId: `study-event:${createId()}`,
      deviceId: latest.deviceId,
      deviceSeq: latest.nextDeviceSeq,
      occurredAt: new Date(occurredAt).toISOString(),
    };
    const next: BrowserStudyState = {
      ...latest,
      nextDeviceSeq: latest.nextDeviceSeq + 1,
      pendingAttempt: attempt,
    };

    // The sequence reservation and complete retry payload reach durable storage
    // before the caller is allowed to send the request.
    persist(storage, next);
    return { state: next, attempt };
  });
}

export async function clearPendingStudyAttempt(
  storage: StorageLike,
  state: BrowserStudyState,
  eventId: string,
  lockManager: StudyLockManager = browserStudyLockManager(),
): Promise<BrowserStudyState> {
  if (state.pendingAttempt?.eventId !== eventId) {
    throw new Error("pending study review identity changed before acknowledgement");
  }
  return lockManager.request(STUDY_STORAGE_LOCK, () => {
    const latest = loadExistingState(storage);
    requireSameDevice(state, latest);
    if (latest.pendingAttempt === null) return latest;
    if (latest.pendingAttempt.eventId !== eventId) {
      throw new Error("pending study review identity changed before acknowledgement");
    }
    const next = { ...latest, pendingAttempt: null };
    persist(storage, next);
    return next;
  });
}

function browserStudyLockManager(): StudyLockManager {
  const locks = globalThis.navigator?.locks;
  if (!locks) {
    throw new Error("This browser cannot safely coordinate study identity across tabs.");
  }
  return {
    request<T extends StudyLockResult>(name: string, callback: () => T): Promise<T> {
      return locks.request(name, callback);
    },
  };
}

function loadExistingState(storage: StorageLike): BrowserStudyState {
  const persisted = storage.getItem(STUDY_STORAGE_KEY);
  if (persisted === null) {
    throw new Error("stored study identity disappeared; refusing to create a replacement");
  }
  return parseBrowserStudyState(persisted);
}

function requireSameDevice(state: BrowserStudyState, latest: BrowserStudyState): void {
  if (state.deviceId !== latest.deviceId) {
    throw new Error("stored study device identity changed unexpectedly");
  }
}

function requireCurrentStateForStaging(state: BrowserStudyState, latest: BrowserStudyState): void {
  if (
    state.nextDeviceSeq !== latest.nextDeviceSeq ||
    state.activeSessionId !== latest.activeSessionId ||
    state.activePronunciationSessionId !== latest.activePronunciationSessionId ||
    state.activePronunciationFocus !== latest.activePronunciationFocus ||
    state.pendingAttempt?.eventId !== latest.pendingAttempt?.eventId
  ) {
    throw new Error("study state changed in another tab; reload before rating this card");
  }
}

export function parseBrowserStudyState(json: string): BrowserStudyState {
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
  const supportedVersion = record.version === 1 || record.version === 2 || record.version === 3;
  const activePronunciationSessionId =
    record.version === 1 ? null : record.activePronunciationSessionId;
  const activePronunciationFocus =
    record.version === 3
      ? record.activePronunciationFocus
      : activePronunciationSessionId === null
        ? null
        : "mixed";
  if (
    !supportedVersion ||
    typeof record.deviceId !== "string" ||
    record.deviceId.trim().length === 0 ||
    !Number.isSafeInteger(record.nextDeviceSeq) ||
    (record.nextDeviceSeq as number) < 1 ||
    !(
      record.activeSessionId === null ||
      (typeof record.activeSessionId === "string" && record.activeSessionId.trim().length > 0)
    ) ||
    !(
      (activePronunciationSessionId === null && activePronunciationFocus === null) ||
      (typeof activePronunciationSessionId === "string" &&
        activePronunciationSessionId.trim().length > 0 &&
        typeof activePronunciationFocus === "string" &&
        (PRONUNCIATION_FOCUSES as readonly string[]).includes(activePronunciationFocus))
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
      pendingAttempt.studySessionId !==
        (pendingAttempt.mode === "pronunciation"
          ? activePronunciationSessionId
          : record.activeSessionId)
    ) {
      throw new Error("stored pending study review conflicts with browser identity");
    }
  }

  return {
    version: 3,
    deviceId: record.deviceId,
    nextDeviceSeq: record.nextDeviceSeq as number,
    activeSessionId: record.activeSessionId as string | null,
    activePronunciationSessionId: activePronunciationSessionId as string | null,
    activePronunciationFocus: activePronunciationFocus as PronunciationFocus | null,
    pendingAttempt,
  };
}

function persist(storage: StorageLike, state: BrowserStudyState): void {
  storage.setItem(STUDY_STORAGE_KEY, JSON.stringify(state));
}
