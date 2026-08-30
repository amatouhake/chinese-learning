import { describe, expect, test } from "bun:test";

import {
  STUDY_STORAGE_KEY,
  clearPendingStudyAttempt,
  loadOrCreateBrowserStudyState,
  setActiveStudySession,
  stageStudyAttempt,
  type StorageLike,
} from "../../src/web/study-storage";

describe("browser study identity", () => {
  test("survives reload while reserving every device sequence before delivery", () => {
    const storage = new MemoryStorage();
    const ids = idFactory("device", "session", "event-1", "event-2");
    let state = loadOrCreateBrowserStudyState(storage, ids);
    const deviceId = state.deviceId;
    state = setActiveStudySession(storage, state, `study-session:${ids()}`);

    const first = stageStudyAttempt(storage, state, attemptDraft(state.activeSessionId), ids, () =>
      Date.parse("2026-08-30T01:00:00Z"),
    );
    expect(first.attempt).toMatchObject({
      eventId: "study-event:event-1",
      deviceId,
      deviceSeq: 1,
    });

    const afterFailedDeliveryReload = loadOrCreateBrowserStudyState(storage, () =>
      never("reload must not create another identity"),
    );
    expect(afterFailedDeliveryReload).toMatchObject({
      deviceId,
      nextDeviceSeq: 2,
      activeSessionId: state.activeSessionId,
      pendingAttempt: { eventId: first.attempt.eventId, deviceSeq: 1 },
    });

    state = clearPendingStudyAttempt(storage, afterFailedDeliveryReload, first.attempt.eventId);
    const second = stageStudyAttempt(storage, state, attemptDraft(state.activeSessionId), ids, () =>
      Date.parse("2026-08-30T01:01:00Z"),
    );
    expect(second.attempt).toMatchObject({
      eventId: "study-event:event-2",
      deviceId,
      deviceSeq: 2,
    });

    const finalReload = loadOrCreateBrowserStudyState(storage, () =>
      never("reload must not create another identity"),
    );
    expect(finalReload.nextDeviceSeq).toBe(3);
    expect(finalReload.pendingAttempt?.eventId).toBe(second.attempt.eventId);
  });

  test("fails closed instead of silently replacing corrupt identity or pending review", () => {
    const storage = new MemoryStorage();
    storage.setItem(STUDY_STORAGE_KEY, "{not json");
    expect(() => loadOrCreateBrowserStudyState(storage, () => "replacement")).toThrow(
      "refusing to replace it",
    );

    storage.setItem(
      STUDY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        deviceId: "browser:stable",
        nextDeviceSeq: 1,
        activeSessionId: "study-session:stable",
        pendingAttempt: { eventId: "partial" },
      }),
    );
    expect(() => loadOrCreateBrowserStudyState(storage, () => "replacement")).toThrow(
      "refusing to discard it",
    );
  });
});

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function attemptDraft(studySessionId: string | null) {
  if (!studySessionId) throw new Error("test session must exist");
  return {
    cardId: "card:test",
    studySessionId,
    mode: "study" as const,
    activityType: "hanzi_to_meaning" as const,
    expectedCardStateVersion: 0,
    fsrsReview: { rating: 3 as const, schedulerConfigId: "config:test" },
  };
}

function idFactory(...ids: string[]): () => string {
  return () => ids.shift() ?? never("test ID factory exhausted");
}

function never(message: string): never {
  throw new Error(message);
}
