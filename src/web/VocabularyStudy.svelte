<script lang="ts">
  import { onMount } from "svelte";

  import type { FsrsRating, StudyCard, StudySessionView } from "../domain/types";
  import { ApiError, postJson } from "./api";
  import { OfflineLearningStore, type BrowserOfflineState } from "./offline-store";
  import { getSoundEnabled, playPronunciationAudio, prepareSound } from "./sound";
  import { synchronizeLearning } from "./sync";

  type Phase = "loading" | "prompt" | "revealed" | "submitting" | "empty" | "completed" | "error";
  const ratings: Array<{ rating: FsrsRating; label: string; hint: string }> = [
    { rating: 1, label: "Again", hint: "Forgot" },
    { rating: 2, label: "Hard", hint: "Barely" },
    { rating: 3, label: "Good", hint: "Recalled" },
    { rating: 4, label: "Easy", hint: "Immediate" },
  ];

  let phase: Phase = "loading";
  let store: OfflineLearningStore | null = null;
  let browserState: BrowserOfflineState | null = null;
  let session: StudySessionView | null = null;
  let card: StudyCard | null = null;
  let errorMessage = "";
  let promptStartedAt = 0;
  let syncMessage = "Preparing offline cache…";
  let browserOffline = !navigator.onLine;
  let isOffline = browserOffline;
  let audioMessage = "";
  let autoplayedCardKey: string | null = null;

  onMount(() => void initializeStudy());

  async function initializeStudy(): Promise<void> {
    phase = "loading";
    errorMessage = "";
    try {
      store ??= await OfflineLearningStore.open(localStorage);
      browserState = await store.snapshot();
      if (!browserState.activeSessionId) {
        if (browserOffline) {
          errorMessage = "Reconnect once to prepare a new offline vocabulary set.";
          phase = "error";
          return;
        }
        await createNewSession();
        return;
      }
      if (!browserOffline) {
        try {
          await ensureSession(browserState.activeSessionId, browserState.deviceId);
          await syncNow();
        } catch (error) {
          if (!(await store.getStudySession(browserState.activeSessionId))) throw error;
          isOffline = browserOffline || !(error instanceof ApiError);
          syncMessage = isOffline
            ? "Network unavailable · using the cached vocabulary set"
            : "Service unavailable · using the cached vocabulary set";
        }
      }
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  async function createNewSession(): Promise<void> {
    phase = "loading";
    errorMessage = "";
    try {
      if (browserOffline) throw new Error("Reconnect to prepare another offline vocabulary set.");
      store ??= await OfflineLearningStore.open(localStorage);
      browserState ??= await store.snapshot();
      browserState = await store.setActiveStudySession(`study-session:${crypto.randomUUID()}`);
      if (!browserState.activeSessionId) throw new Error("No active study session is available.");
      await ensureSession(browserState.activeSessionId, browserState.deviceId);
      await syncNow();
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  async function ensureSession(sessionId: string, deviceId: string): Promise<void> {
    const result = await postJson<{ session: StudySessionView }>("/api/study/sessions", {
      sessionId,
      deviceId,
      maxCards: 10,
    });
    session = result.session;
    if (!store) throw new Error("Offline storage is not ready.");
    await store.rememberStudySession(result.session);
  }

  async function loadNextCard(): Promise<void> {
    if (!store || !browserState?.activeSessionId) {
      throw new Error("No active study session is available.");
    }
    phase = "loading";
    const sessionId = browserState.activeSessionId;
    const [cachedSession, cachedCard] = await Promise.all([
      store.getStudySession(sessionId),
      store.getCachedStudyCard(sessionId),
    ]);
    if (!cachedSession) {
      throw new Error(
        isOffline
          ? "This vocabulary set was not cached before the connection was lost."
          : "The canonical vocabulary set has not been pulled yet.",
      );
    }
    session = cachedSession;
    card = cachedCard;
    audioMessage = "";
    if (cachedCard) {
      promptStartedAt = performance.now();
      phase = "prompt";
      if (cachedCard.activityType === "hanzi_to_meaning") {
        void autoplayCardAudio();
      }
      return;
    }
    if (cachedSession.endedAt !== null) {
      browserState = await store.clearActiveStudySession(sessionId);
    }
    phase = session.reviewedCards === 0 ? "empty" : "completed";
  }

  async function rateCard(rating: FsrsRating): Promise<void> {
    if (phase !== "revealed" || !card || !browserState?.activeSessionId) return;
    try {
      phase = "submitting";
      if (!store) throw new Error("Offline storage is not ready.");
      const staged = await store.stageAttempt(browserState, {
        cardId: card.cardId,
        studySessionId: browserState.activeSessionId,
        mode: "study",
        activityType: card.activityType,
        responseMs: Math.max(0, Math.round(performance.now() - promptStartedAt)),
        expectedCardStateVersion: card.state.version,
        metadata: { interaction: "reveal-and-rate", queueSource: card.source },
        fsrsReview: { rating, schedulerConfigId: card.schedulerConfigId },
      });
      browserState = staged.state;
      if (!browserOffline) await syncNow();
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  async function syncNow(): Promise<void> {
    if (!store || browserOffline) return;
    const result = await synchronizeLearning(store);
    browserState = result.state;
    isOffline = browserOffline || result.networkUnavailable;
    if (result.error) {
      syncMessage = `${result.pending} queued · ${result.error}`;
      return;
    }
    syncMessage =
      result.pending === 0 ? "Offline cache ready · synced" : `${result.pending} queued`;
  }

  async function handleOnline(): Promise<void> {
    browserOffline = false;
    isOffline = false;
    syncMessage = "Connection restored · synchronizing…";
    try {
      if (!store) return await initializeStudy();
      await syncNow();
      if (phase !== "revealed") await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  function handleOffline(): void {
    browserOffline = true;
    isOffline = true;
    syncMessage = `${browserState?.pendingCount ?? 0} queued · offline`;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    )
      return;
    if (phase === "prompt" && (event.key === " " || event.key === "Enter")) {
      event.preventDefault();
      revealCard();
      return;
    }
    if (phase === "revealed") {
      const selected = ratings.find(({ rating }) => String(rating) === event.key);
      if (selected) {
        event.preventDefault();
        void rateCard(selected.rating);
      }
    }
  }

  function promptText(value: StudyCard): string {
    if (value.activityType === "hanzi_to_meaning") return value.lexeme.simplified;
    const japanese = value.lexeme.meanings.filter(({ language }) => language === "ja");
    const english = value.lexeme.meanings.filter(({ language }) => language === "en");
    const preferred = japanese.length > 0 ? japanese : english;
    return (preferred.length > 0 ? preferred : value.lexeme.meanings)
      .slice(0, 2)
      .map(({ text }) => text)
      .join(" / ");
  }

  function revealCard(): void {
    if (phase !== "prompt") return;
    prepareSound();
    phase = "revealed";
    if (card?.activityType === "meaning_to_hanzi") {
      void autoplayCardAudio();
    }
  }

  async function playCardAudio(): Promise<void> {
    if (!card?.media || !getSoundEnabled()) return;
    const played = await playPronunciationAudio(card.media.url);
    if (!played) {
      audioMessage = isOffline
        ? "Pronunciation is not cached on this device."
        : "Audio unavailable.";
    }
  }

  async function autoplayCardAudio(): Promise<void> {
    if (!card?.media || !getSoundEnabled()) return;
    const cardKey = `${browserState?.activeSessionId ?? "study"}:${session?.reviewedCards ?? 0}:${card.cardId}`;
    if (autoplayedCardKey === cardKey) return;
    autoplayedCardKey = cardKey;
    await playCardAudio();
  }

  function showError(error: unknown): void {
    errorMessage = error instanceof Error ? error.message : "Something went wrong.";
    phase = "error";
  }
</script>

<svelte:window
  onkeydown={handleKeydown}
  ononline={() => void handleOnline()}
  onoffline={handleOffline}
/>

<header class="app-header surface-header">
  <div class="surface-title">
    <span class="section-mark">01</span>
    <h2>Study</h2>
  </div>
  {#if session && (phase === "prompt" || phase === "revealed" || phase === "submitting")}
    <p class="progress" aria-label={`Card ${session.reviewedCards + 1} of ${session.maxCards}`}>
      <strong>{session.reviewedCards + 1}</strong><span>/ {session.maxCards}</span>
    </p>
  {/if}
</header>

<p class:offline={isOffline} class="sync-status" aria-live="polite">
  {isOffline ? `${browserState?.pendingCount ?? 0} queued · offline` : syncMessage}
</p>

{#if phase === "loading" || phase === "submitting"}
  <section class="status-panel" aria-live="polite">
    <div class="pulse" aria-hidden="true"></div>
    <h2>{phase === "submitting" ? "Saving review…" : "Loading today’s set…"}</h2>
    <p>{phase === "submitting" ? "Your place is safe." : "Due cards are first."}</p>
  </section>
{:else if phase === "error"}
  <section class="status-panel error-panel" role="alert">
    <p class="status-kicker">Study paused safely</p>
    <h2>Nothing was discarded</h2>
    <p>{errorMessage}</p>
    <button class="primary-button" onclick={() => void initializeStudy()}>Try again</button>
  </section>
{:else if phase === "empty"}
  <section class="status-panel">
    <p class="completion-mark" aria-hidden="true">—</p>
    <h2>No cards are ready right now</h2>
    <p>You’re caught up for now.</p>
    <button class="primary-button" onclick={() => void createNewSession()}>Check again</button>
  </section>
{:else if phase === "completed"}
  <section class="status-panel">
    <p class="completion-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19 7" /></svg>
    </p>
    <h2>Session complete</h2>
    <p>
      {session?.reviewedCards ?? 0} reviews are {browserState?.pendingCount
        ? "durably queued for reconnect"
        : "safely synchronized"}.
    </p>
    <button
      class="primary-button"
      onclick={() => void (browserState?.pendingCount ? initializeStudy() : createNewSession())}
    >
      {browserState?.pendingCount ? "Retry synchronization" : "Study another 10"}
    </button>
  </section>
{:else if card}
  <section class="study-card" aria-live="polite">
    <div class="card-meta">
      <span class:due={card.source === "due"} class="queue-badge"
        >{card.source === "due" ? "Due" : "New"}</span
      >
      <span
        >{card.activityType === "hanzi_to_meaning"
          ? "Chinese → meaning"
          : "Meaning → Chinese"}</span
      >
      {#if card.lexeme.hskLevel}<span>HSK {card.lexeme.hskLevel}</span>{/if}
    </div>
    <div class="prompt-block">
      <p class="prompt-instruction">
        {card.activityType === "hanzi_to_meaning" ? "Recall the meaning" : "Recall the Chinese"}
      </p>
      <h2 class:hanzi-prompt={card.activityType === "hanzi_to_meaning"}>{promptText(card)}</h2>
    </div>
    {#if phase === "prompt"}
      <button class="reveal-button" onclick={revealCard}
        ><span>Reveal answer</span><kbd>Space</kbd></button
      >
    {:else}
      <div class="answer" aria-label="Answer">
        <div class="answer-heading">
          <p class="answer-hanzi">{card.lexeme.simplified}</p>
          <div class="answer-reading">
            {#if card.lexeme.traditional && card.lexeme.traditional !== card.lexeme.simplified}<p
                class="traditional"
              >
                Traditional: {card.lexeme.traditional}
              </p>{/if}
            {#if card.lexeme.pinyin}<p class="pinyin">{card.lexeme.pinyin}</p>{/if}
          </div>
          {#if card.media}
            <button
              class="word-audio"
              aria-label="Play pronunciation"
              onclick={() => void playCardAudio()}
            >
              <svg aria-hidden="true" viewBox="0 0 20 20"
                ><path d="M3.5 8.1h3l3.3-2.8v9.4l-3.3-2.8h-3z" /><path
                  d="M13 7a4.2 4.2 0 0 1 0 6M15.2 4.8a7.3 7.3 0 0 1 0 10.4"
                /></svg
              >
              <span>Listen</span>
            </button>
          {/if}
        </div>
        <div class="meanings">
          {#each card.lexeme.meanings.slice(0, 3) as meaning}<p>
              <span>{meaning.language.toUpperCase()}</span>{meaning.text}
            </p>{/each}
        </div>
        {#if card.example}
          <details class="example">
            <summary>Example sentence</summary>
            <p class="example-chinese">{card.example.chinese}</p>
            {#if card.example.pinyin}<p class="example-pinyin">{card.example.pinyin}</p>{/if}
            {#if card.example.meaningJa || card.example.meaningEn}<p class="example-meaning">
                {card.example.meaningJa ?? card.example.meaningEn}
              </p>{/if}
          </details>
        {/if}
      </div>
      <div class="rating-area">
        <p>How did it feel?</p>
        <div class="rating-grid">
          {#each ratings as option}
            <button
              class={`rating rating-${option.rating}`}
              onclick={() => void rateCard(option.rating)}
              aria-label={`${option.rating}: ${option.label} — ${option.hint}`}
            >
              <kbd>{option.rating}</kbd><strong>{option.label}</strong><span>{option.hint}</span>
            </button>
          {/each}
        </div>
      </div>
      <p class="audio-note" class:visible={Boolean(audioMessage)} role="status">
        {audioMessage}
      </p>
    {/if}
  </section>
{/if}
