import type { IngestResult, SyncPullResponse } from "../domain/types";
import { cachePronunciationAudio } from "./audio-cache";
import { ApiError, postJson } from "./api";
import { OfflineLearningStore, type BrowserOfflineState } from "./offline-store";

export interface LearningSyncResult {
  state: BrowserOfflineState;
  pushed: number;
  pending: number;
  pulledThrough: number;
  audioCacheFailures: string[];
  error: string | null;
  retryable: boolean;
}

export function synchronizeLearning(store: OfflineLearningStore): Promise<LearningSyncResult> {
  return store.runSyncExclusive(async () => {
    let pushed = 0;
    const pending = await store.listPendingAttempts();
    for (const attempt of pending) {
      try {
        const result = await postJson<IngestResult>("/api/attempts", attempt);
        await store.acknowledgeAttempt(attempt.eventId, result);
        pushed += 1;
      } catch (error) {
        const state = await store.snapshot();
        return {
          state,
          pushed,
          pending: state.pendingCount,
          pulledThrough: state.learnerCursor,
          audioCacheFailures: [],
          error: error instanceof Error ? error.message : "Pending events could not be pushed.",
          retryable: !(error instanceof ApiError) || error.status >= 500,
        };
      }
    }

    let state = await store.snapshot();
    const audioCacheFailures = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      let pull: SyncPullResponse;
      try {
        pull = await postJson<SyncPullResponse>("/api/sync/pull", {
          cursor: state.learnerCursor,
          contentRevision: state.contentRevision,
          deviceId: state.deviceId,
          studySessionId: state.activeSessionId ?? undefined,
          pronunciationSessionId: state.activePronunciationSessionId ?? undefined,
        });
      } catch (error) {
        state = await store.snapshot();
        return {
          state,
          pushed,
          pending: state.pendingCount,
          pulledThrough: state.learnerCursor,
          audioCacheFailures: [...audioCacheFailures],
          error: error instanceof Error ? error.message : "Canonical changes could not be pulled.",
          retryable: !(error instanceof ApiError) || error.status >= 500,
        };
      }

      if (pull.pronunciationPack) {
        const audio = await cachePronunciationAudio(pull.pronunciationPack.cards);
        audio.failedUrls.forEach((url) => audioCacheFailures.add(url));
      }
      state = await store.applyPull(pull);
      if (!pull.hasMore) {
        return {
          state,
          pushed,
          pending: state.pendingCount,
          pulledThrough: state.learnerCursor,
          audioCacheFailures: [...audioCacheFailures],
          error: null,
          retryable: false,
        };
      }
    }
    throw new Error("sync pull exceeded the bounded page limit");
  });
}
