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
  networkUnavailable: boolean;
}

export function synchronizeLearning(store: OfflineLearningStore): Promise<LearningSyncResult> {
  return store.runSyncExclusive(async () => {
    let pushed = 0;
    await store.reconcileLegacyState();
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
          networkUnavailable: !(error instanceof ApiError),
        };
      }
    }

    let state = await store.snapshot();
    const [studySession, reflexSession, pronunciationSession, readingSession, grammarSession] =
      await Promise.all([
        state.activeSessionId ? store.getStudySession(state.activeSessionId) : null,
        state.activeReflexSessionId ? store.getReflexSession(state.activeReflexSessionId) : null,
        state.activePronunciationSessionId
          ? store.getPronunciationSession(state.activePronunciationSessionId)
          : null,
        state.activeReadingSessionId ? store.getReadingSession(state.activeReadingSessionId) : null,
        state.activeGrammarSessionId ? store.getGrammarSession(state.activeGrammarSessionId) : null,
      ]);
    const studySessionId = studySession?.id === state.activeSessionId ? studySession.id : undefined;
    const reflexSessionId =
      reflexSession?.session.id === state.activeReflexSessionId
        ? reflexSession.session.id
        : undefined;
    const pronunciationSessionId =
      pronunciationSession?.id === state.activePronunciationSessionId
        ? pronunciationSession.id
        : undefined;
    const readingSessionId =
      readingSession?.id === state.activeReadingSessionId ? readingSession.id : undefined;
    const grammarSessionId =
      grammarSession?.id === state.activeGrammarSessionId ? grammarSession.id : undefined;
    const audioCacheFailures = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      let pull: SyncPullResponse;
      try {
        pull = await postJson<SyncPullResponse>("/api/sync/pull", {
          cursor: state.learnerCursor,
          contentRevision: state.contentRevision,
          deviceId: state.deviceId,
          studySessionId,
          reflexSessionId,
          pronunciationSessionId,
          readingSessionId,
          grammarSessionId,
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
          networkUnavailable: !(error instanceof ApiError),
        };
      }

      const audioCards = [
        ...(pull.studyPack?.cards ?? []),
        ...(pull.reflexPack?.cards ?? []),
        ...(pull.pronunciationPack?.cards ?? []),
      ];
      if (audioCards.length > 0) {
        const audio = await cachePronunciationAudio(audioCards);
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
          networkUnavailable: false,
        };
      }
    }
    throw new Error("sync pull exceeded the bounded page limit");
  });
}
