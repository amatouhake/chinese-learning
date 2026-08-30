import { describe, expect, test } from "bun:test";

import {
  STUDY_STORAGE_KEY,
  clearPendingStudyAttempt,
  loadOrCreateBrowserStudyState,
  setActivePronunciationSession,
  setActiveStudySession,
  stageStudyAttempt,
  type BrowserStudyState,
  type StagedAttempt,
  type StorageLike,
  type StudyLockManager,
} from "../../src/web/study-storage";

describe("browser study identity", () => {
  test("survives reload while reserving every device sequence before delivery", async () => {
    const storage = new MemoryStorage();
    const locks = new QueuedStudyLockManager();
    const ids = idFactory("device", "session", "event-1", "event-2");
    let state = await loadOrCreateBrowserStudyState(storage, ids, locks);
    const deviceId = state.deviceId;
    state = await setActiveStudySession(storage, state, `study-session:${ids()}`, locks);

    const first = await stageStudyAttempt(
      storage,
      state,
      attemptDraft(state.activeSessionId),
      ids,
      () => Date.parse("2026-08-30T01:00:00Z"),
      locks,
    );
    expect(first.attempt).toMatchObject({
      eventId: "study-event:event-1",
      deviceId,
      deviceSeq: 1,
    });

    const afterFailedDeliveryReload = await loadOrCreateBrowserStudyState(
      storage,
      () => never("reload must not create another identity"),
      locks,
    );
    expect(afterFailedDeliveryReload).toMatchObject({
      deviceId,
      nextDeviceSeq: 2,
      activeSessionId: state.activeSessionId,
      pendingAttempt: { eventId: first.attempt.eventId, deviceSeq: 1 },
    });

    state = await clearPendingStudyAttempt(
      storage,
      afterFailedDeliveryReload,
      first.attempt.eventId,
      locks,
    );
    const second = await stageStudyAttempt(
      storage,
      state,
      attemptDraft(state.activeSessionId),
      ids,
      () => Date.parse("2026-08-30T01:01:00Z"),
      locks,
    );
    expect(second.attempt).toMatchObject({
      eventId: "study-event:event-2",
      deviceId,
      deviceSeq: 2,
    });

    const finalReload = await loadOrCreateBrowserStudyState(
      storage,
      () => never("reload must not create another identity"),
      locks,
    );
    expect(finalReload.nextDeviceSeq).toBe(3);
    expect(finalReload.pendingAttempt?.eventId).toBe(second.attempt.eventId);
  });

  test("serializes stale tabs without sequence reuse, duplicate presentations, or overwritten reviews", async () => {
    const storage = new MemoryStorage();
    const locks = new QueuedStudyLockManager();
    let state = await loadOrCreateBrowserStudyState(storage, () => "device", locks);
    state = await setActiveStudySession(storage, state, "study-session:shared", locks);
    const preservedSession = await setActiveStudySession(
      storage,
      state,
      "study-session:stale-tab-replacement",
      locks,
    );
    expect(preservedSession.activeSessionId).toBe("study-session:shared");

    const attempts = await Promise.allSettled([
      stageStudyAttempt(
        storage,
        state,
        attemptDraft(state.activeSessionId),
        () => "event-1",
        () => Date.parse("2026-08-30T01:00:00Z"),
        locks,
      ),
      stageStudyAttempt(
        storage,
        state,
        attemptDraft(state.activeSessionId),
        () => "event-raced",
        () => Date.parse("2026-08-30T01:00:01Z"),
        locks,
      ),
    ]);

    expect(attempts[0].status).toBe("fulfilled");
    expect(attempts[1]).toMatchObject({
      status: "rejected",
      reason: new Error("a study review is already pending delivery"),
    });
    if (attempts[0].status !== "fulfilled") throw attempts[0].reason;
    const first = attempts[0].value;
    expect(first.attempt.deviceSeq).toBe(1);

    const cleared = await clearPendingStudyAttempt(
      storage,
      first.state,
      first.attempt.eventId,
      locks,
    );
    await expect(
      stageStudyAttempt(
        storage,
        state,
        attemptDraft(state.activeSessionId),
        () => "event-from-stale-card",
        () => Date.parse("2026-08-30T01:00:30Z"),
        locks,
      ),
    ).rejects.toThrow("study state changed in another tab");

    const second = await stageStudyAttempt(
      storage,
      cleared,
      attemptDraft(cleared.activeSessionId),
      () => "event-2",
      () => Date.parse("2026-08-30T01:01:00Z"),
      locks,
    );
    expect(second.attempt.deviceSeq).toBe(2);

    await expect(
      clearPendingStudyAttempt(storage, first.state, first.attempt.eventId, locks),
    ).rejects.toThrow("pending study review identity changed");
    const latest = await loadOrCreateBrowserStudyState(
      storage,
      () => never("existing identity must win"),
      locks,
    );
    expect(latest.pendingAttempt?.eventId).toBe(second.attempt.eventId);
    expect(latest.nextDeviceSeq).toBe(3);
  });

  test("fails closed instead of silently replacing corrupt identity or pending review", async () => {
    const storage = new MemoryStorage();
    const locks = new QueuedStudyLockManager();
    storage.setItem(STUDY_STORAGE_KEY, "{not json");
    await expect(
      loadOrCreateBrowserStudyState(storage, () => "replacement", locks),
    ).rejects.toThrow("refusing to replace it");

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
    await expect(
      loadOrCreateBrowserStudyState(storage, () => "replacement", locks),
    ).rejects.toThrow("refusing to discard it");
  });

  test("migrates the v1 browser envelope and reloads a pending pronunciation attempt", async () => {
    const storage = new MemoryStorage();
    const locks = new QueuedStudyLockManager();
    storage.setItem(
      STUDY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        deviceId: "browser:existing",
        nextDeviceSeq: 7,
        activeSessionId: null,
        pendingAttempt: null,
      }),
    );
    let state = await loadOrCreateBrowserStudyState(
      storage,
      () => never("migration must preserve the device"),
      locks,
    );
    expect(state).toMatchObject({
      version: 2,
      deviceId: "browser:existing",
      nextDeviceSeq: 7,
      activePronunciationSessionId: null,
    });

    state = await setActivePronunciationSession(
      storage,
      state,
      "pronunciation-session:reload",
      locks,
    );
    const staged = await stageStudyAttempt(
      storage,
      state,
      {
        cardId: "card:reading:test:tone_identification",
        studySessionId: state.activePronunciationSessionId ?? undefined,
        mode: "pronunciation",
        activityType: "tone_identification",
        correct: true,
      },
      () => "pronunciation-event",
      () => Date.parse("2026-08-30T02:00:00Z"),
      locks,
    );
    const reloaded = await loadOrCreateBrowserStudyState(
      storage,
      () => never("reload must preserve the device"),
      locks,
    );
    expect(reloaded).toMatchObject({
      nextDeviceSeq: 8,
      activePronunciationSessionId: "pronunciation-session:reload",
      pendingAttempt: {
        eventId: staged.attempt.eventId,
        mode: "pronunciation",
        correct: true,
      },
    });
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

class QueuedStudyLockManager implements StudyLockManager {
  readonly tails = new Map<string, Promise<void>>();

  request<T extends BrowserStudyState | StagedAttempt>(
    name: string,
    callback: () => T,
  ): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    const result = previous.then(callback);
    this.tails.set(
      name,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
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
