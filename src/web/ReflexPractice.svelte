<script lang="ts">
  import { onMount } from "svelte";

  import {
    REFLEX_INTERACTION,
    REFLEX_SLOW_RESPONSE_MS,
    presentReflexQuestion,
    selectNextReflexCard,
    type PresentedReflexQuestion,
  } from "../domain/reflex";
  import type { ReflexAnswerRecord, ReflexCard, ReflexSessionView } from "../domain/types";
  import { ApiError, postJson } from "./api";
  import { OfflineLearningStore, type BrowserOfflineState } from "./offline-store";
  import { synchronizeLearning } from "./sync";

  type Phase = "loading" | "choose" | "prompt" | "feedback" | "empty" | "completed" | "error";

  let phase: Phase = "loading";
  let store: OfflineLearningStore | null = null;
  let browserState: BrowserOfflineState | null = null;
  let session: ReflexSessionView | null = null;
  let cards: ReflexCard[] = [];
  let answers: ReflexAnswerRecord[] = [];
  let question: PresentedReflexQuestion | null = null;
  let promptStartedAt = 0;
  let selectedChoiceId: string | null = null;
  let selectedResponseMs = 0;
  let answerStored = false;
  let errorMessage = "";
  let syncMessage = "Start online once to prepare a short offline drill.";
  let browserOffline = !navigator.onLine;
  let isOffline = browserOffline;
  let advanceTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    void initializeReflex();
    const online = () => {
      browserOffline = false;
      if (store) void syncNow().then(loadNextQuestion).catch(showError);
    };
    const offline = () => {
      browserOffline = true;
      isOffline = true;
      syncMessage = "Offline · answers are queued on this device";
    };
    addEventListener("online", online);
    addEventListener("offline", offline);
    return () => {
      removeEventListener("online", online);
      removeEventListener("offline", offline);
      if (advanceTimer) clearTimeout(advanceTimer);
      store?.close();
    };
  });

  async function initializeReflex(): Promise<void> {
    phase = "loading";
    errorMessage = "";
    try {
      store ??= await OfflineLearningStore.open(localStorage);
      browserState = await store.snapshot();
      if (!browserState.activeReflexSessionId) {
        phase = "choose";
        return;
      }
      if (!browserOffline) {
        try {
          await ensureSession(browserState.activeReflexSessionId, browserState.deviceId);
          await syncNow();
        } catch (error) {
          if (!(await store.getReflexSession(browserState.activeReflexSessionId))) throw error;
          isOffline = browserOffline || !(error instanceof ApiError);
          syncMessage = "Network unavailable · using the prepared Reflex drill";
        }
      }
      await loadNextQuestion();
    } catch (error) {
      showError(error);
    }
  }

  async function createNewSession(): Promise<void> {
    phase = "loading";
    errorMessage = "";
    try {
      if (browserOffline) throw new Error("Reconnect to prepare a new Reflex drill.");
      store ??= await OfflineLearningStore.open(localStorage);
      browserState ??= await store.snapshot();
      browserState = await store.setActiveReflexSession(`reflex-session:${crypto.randomUUID()}`);
      if (!browserState.activeReflexSessionId) throw new Error("No Reflex session is active.");
      await ensureSession(browserState.activeReflexSessionId, browserState.deviceId);
      await syncNow();
      await loadNextQuestion();
    } catch (error) {
      showError(error);
    }
  }

  async function ensureSession(sessionId: string, deviceId: string): Promise<void> {
    const result = await postJson<{ session: ReflexSessionView }>("/api/reflex/sessions", {
      sessionId,
      deviceId,
      maxItems: 12,
    });
    if (!store) throw new Error("Offline storage is not ready.");
    session = result.session;
    await store.rememberReflexSession(result.session);
  }

  async function loadNextQuestion(): Promise<void> {
    if (!store || !browserState?.activeReflexSessionId) {
      phase = "choose";
      return;
    }
    const sessionId = browserState.activeReflexSessionId;
    const [cached, cachedCards] = await Promise.all([
      store.getReflexSession(sessionId),
      store.getCachedReflexCards(sessionId),
    ]);
    if (!cached) {
      throw new Error(
        isOffline
          ? "This Reflex drill was not prepared before the connection was lost."
          : "The canonical Reflex drill has not been pulled yet.",
      );
    }
    session = cached.session;
    answers = cached.answers;
    cards = cachedCards;
    selectedChoiceId = null;
    answerStored = false;
    if (session.completedItems >= session.maxItems || session.endedAt !== null) {
      question = null;
      if (session.endedAt !== null) {
        browserState = await store.clearActiveReflexSession(sessionId);
      }
      phase = session.completedItems === 0 ? "empty" : "completed";
      return;
    }
    const card = selectNextReflexCard(cards, answers, session.completedItems + 1);
    if (!card) {
      question = null;
      phase = "empty";
      return;
    }
    const exposure = answers.filter(({ cardId }) => cardId === card.cardId).length;
    question = presentReflexQuestion(card, sessionId, session.completedItems + 1, exposure);
    promptStartedAt = performance.now();
    phase = "prompt";
  }

  async function choose(choiceId: string): Promise<void> {
    if (phase !== "prompt" || !question || !store || !browserState?.activeReflexSessionId) return;
    if (advanceTimer) clearTimeout(advanceTimer);
    selectedChoiceId = choiceId;
    selectedResponseMs = Math.max(0, Math.round(performance.now() - promptStartedAt));
    const correct = choiceId === question.card.answerChoiceId;
    answerStored = false;
    phase = "feedback";
    try {
      const staged = await store.stageAttempt(browserState, {
        cardId: question.card.cardId,
        studySessionId: browserState.activeReflexSessionId,
        mode: "reflex",
        activityType: question.card.activityType,
        correct,
        responseMs: selectedResponseMs,
        metadata: {
          interaction: REFLEX_INTERACTION,
          presentationId: question.presentationId,
          round: question.round,
          prompt: question.card.prompt,
          promptHint: question.card.promptHint,
          answerChoiceId: question.card.answerChoiceId,
          selectedChoiceId: choiceId,
          options: question.choices.map((choice, index) => ({ ...choice, position: index + 1 })),
        },
      });
      browserState = staged.state;
      if (!browserOffline) await syncNow();
      answerStored = true;
      advanceTimer = setTimeout(
        () => void loadNextQuestion().catch(showError),
        correct ? 650 : 1_200,
      );
    } catch (error) {
      showError(error);
    }
  }

  async function continueNow(): Promise<void> {
    if (!answerStored) return;
    if (advanceTimer) clearTimeout(advanceTimer);
    advanceTimer = null;
    await loadNextQuestion();
  }

  async function syncNow(): Promise<void> {
    if (!store || browserOffline) return;
    const result = await synchronizeLearning(store);
    browserState = result.state;
    isOffline = result.networkUnavailable;
    if (result.error) {
      syncMessage = `${result.pending} queued · ${result.error}`;
    } else {
      syncMessage = result.pending === 0 ? "Reflex history synced" : `${result.pending} queued`;
    }
  }

  function showError(error: unknown): void {
    if (advanceTimer) clearTimeout(advanceTimer);
    errorMessage = error instanceof Error ? error.message : "Reflex could not continue.";
    phase = "error";
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (phase === "prompt") {
      const index = Number(event.key) - 1;
      const choice = question?.choices[index];
      if (choice) {
        event.preventDefault();
        void choose(choice.id);
      }
    } else if (
      phase === "feedback" &&
      answerStored &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      void continueNow();
    }
  }

  function activityLabel(activity: ReflexCard["activityType"]): string {
    return {
      hanzi_to_meaning: "Hanzi → meaning",
      meaning_to_hanzi: "Meaning → Hanzi",
      hanzi_to_pinyin: "Hanzi → pinyin",
      pinyin_to_hanzi: "Pinyin → Hanzi",
    }[activity];
  }

  function answerLabel(): string {
    return question?.choices.find(({ id }) => id === question?.card.answerChoiceId)?.label ?? "";
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<section class="learning-surface reflex-surface">
  <div class="surface-heading">
    <div>
      <p class="eyebrow">Automaticity</p>
      <h2>Reflex</h2>
      <p>Fast retrieval on material you have already met. No FSRS scheduling changes.</p>
    </div>
    <p class="sync-status" class:offline={isOffline}>{syncMessage}</p>
  </div>

  {#if phase === "loading"}
    <div class="empty-state"><p>Preparing a bounded drill…</p></div>
  {:else if phase === "choose"}
    <div class="mode-grid reflex-start">
      <button class="mode-card" onclick={createNewSession}>
        <strong>Start 12 quick answers</strong>
        <span>4 choices · keyboard or touch · weak and slow items recur</span>
      </button>
      <p class="boundary-note">
        Only introduced vocabulary is eligible. Preparing a new drill requires a connection.
      </p>
    </div>
  {:else if (phase === "prompt" || phase === "feedback") && question && session}
    <article
      class="study-card reflex-card"
      data-card-id={question.card.cardId}
      data-activity={question.card.activityType}
    >
      <div class="card-meta">
        <span>{session.completedItems + 1} / {session.maxItems}</span>
        <span>{activityLabel(question.card.activityType)}</span>
      </div>
      <div class="reflex-prompt">
        <h3>{question.card.prompt}</h3>
        {#if question.card.promptHint}<p>{question.card.promptHint}</p>{/if}
      </div>
      <div class="choice-grid reflex-choice-grid">
        {#each question.choices as choice, index}
          <button
            class:correct={phase === "feedback" && choice.id === question.card.answerChoiceId}
            class:incorrect={phase === "feedback" &&
              choice.id === selectedChoiceId &&
              choice.id !== question.card.answerChoiceId}
            disabled={phase === "feedback"}
            data-choice-id={choice.id}
            onclick={() => choose(choice.id)}
          >
            <span class="option-key">{index + 1}</span>
            <span>{choice.label}</span>
          </button>
        {/each}
      </div>
      {#if phase === "feedback"}
        <div class="reflex-feedback" aria-live="polite">
          <strong
            >{selectedChoiceId === question.card.answerChoiceId
              ? "Correct"
              : `Answer: ${answerLabel()}`}</strong
          >
          <span class:slow={selectedResponseMs >= REFLEX_SLOW_RESPONSE_MS}
            >{selectedResponseMs} ms</span
          >
          <button class="secondary-button" disabled={!answerStored} onclick={continueNow}
            >Continue</button
          >
        </div>
      {/if}
    </article>
  {:else if phase === "empty"}
    <div class="empty-state">
      <h3>No introduced Reflex material yet</h3>
      <p>Complete a few Vocabulary Study cards first, then prepare another drill online.</p>
      <button class="primary-button" onclick={createNewSession}>Try again</button>
    </div>
  {:else if phase === "completed" && session}
    <div class="empty-state session-summary">
      <p class="eyebrow">Bounded drill finished</p>
      <h3>Reflex complete</h3>
      <p>
        {session.completedItems} objective attempts are safely {isOffline
          ? "queued"
          : "synchronized"}.
      </p>
      <p>
        {answers.filter(({ correct }) => correct).length} correct · {answers.filter(
          ({ responseMs }) => responseMs >= REFLEX_SLOW_RESPONSE_MS,
        ).length} slow
      </p>
      {#if !browserState?.activeReflexSessionId}
        <button class="primary-button" onclick={createNewSession}>Start another drill</button>
      {:else}
        <p class="boundary-note">
          Reconnect to canonically close this prepared session before restarting.
        </p>
      {/if}
    </div>
  {:else if phase === "error"}
    <div class="empty-state" role="alert">
      <h3>Reflex paused</h3>
      <p>{errorMessage}</p>
      <button class="primary-button" onclick={initializeReflex}>Try again</button>
    </div>
  {/if}
</section>
