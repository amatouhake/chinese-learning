<script lang="ts">
  import { onMount } from "svelte";

  import type { FsrsRating, StudyCard, StudySessionView } from "../domain/types";
  import { postJson } from "./api";
  import { OfflineLearningStore, type BrowserOfflineState } from "./offline-store";
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
  let isOffline = !navigator.onLine;

  onMount(() => void initializeStudy());

  async function initializeStudy(): Promise<void> {
    phase = "loading";
    errorMessage = "";
    try {
      store ??= await OfflineLearningStore.open(localStorage);
      browserState = await store.snapshot();
      if (!browserState.activeSessionId) {
        if (isOffline) {
          errorMessage = "Reconnect once to prepare a new offline vocabulary set.";
          phase = "error";
          return;
        }
        await createNewSession();
        return;
      }
      if (!isOffline) {
        try {
          await ensureSession(browserState.activeSessionId, browserState.deviceId);
          await syncNow();
        } catch (error) {
          if (!(await store.getStudySession(browserState.activeSessionId))) throw error;
          isOffline = true;
          syncMessage = "Network unavailable · using the cached vocabulary set";
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
      if (isOffline) throw new Error("Reconnect to prepare another offline vocabulary set.");
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
    const [cachedSession, cachedCard, pending] = await Promise.all([
      store.getStudySession(sessionId),
      store.getCachedStudyCard(sessionId),
      store.countPendingAttempts(sessionId),
    ]);
    if (!cachedSession) {
      throw new Error(
        isOffline
          ? "This vocabulary set was not cached before the connection was lost."
          : "The canonical vocabulary set has not been pulled yet.",
      );
    }
    session = {
      ...cachedSession,
      reviewedCards: Math.min(cachedSession.maxCards, cachedSession.reviewedCards + pending),
    };
    card = cachedCard;
    if (cachedCard) {
      promptStartedAt = performance.now();
      phase = "prompt";
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
      if (!isOffline) await syncNow();
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  async function syncNow(): Promise<void> {
    if (!store || isOffline) return;
    const result = await synchronizeLearning(store);
    browserState = result.state;
    if (result.error) {
      syncMessage = `${result.pending} queued · ${result.error}`;
      return;
    }
    syncMessage =
      result.pending === 0 ? "Offline cache ready · synced" : `${result.pending} queued`;
  }

  async function handleOnline(): Promise<void> {
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
      phase = "revealed";
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
  <div><p class="eyebrow">Vocabulary study</p></div>
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
    <h2>{phase === "submitting" ? "Saving review…" : "Preparing your session…"}</h2>
    <p>
      {phase === "submitting"
        ? "The same event will be retried safely if needed."
        : "Due cards come first."}
    </p>
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
    <p class="completion-mark" aria-hidden="true">○</p>
    <h2>No cards are ready right now</h2>
    <p>You may be caught up for now. On a fresh setup, complete the HSK import first.</p>
    <button class="primary-button" onclick={() => void createNewSession()}>Check again</button>
  </section>
{:else if phase === "completed"}
  <section class="status-panel">
    <p class="completion-mark" aria-hidden="true">好</p>
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
      <button class="reveal-button" onclick={() => (phase = "revealed")}
        ><span>Reveal answer</span><kbd>Space</kbd></button
      >
    {:else}
      <div class="answer" aria-label="Answer">
        <div class="answer-heading">
          <p class="answer-hanzi">{card.lexeme.simplified}</p>
          <div>
            {#if card.lexeme.traditional && card.lexeme.traditional !== card.lexeme.simplified}<p
                class="traditional"
              >
                Traditional: {card.lexeme.traditional}
              </p>{/if}
            {#if card.lexeme.pinyin}<p class="pinyin">{card.lexeme.pinyin}</p>{/if}
          </div>
        </div>
        <div class="meanings">
          {#each card.lexeme.meanings as meaning}<p>
              <span>{meaning.language.toUpperCase()}</span>{meaning.text}
            </p>{/each}
        </div>
        {#if card.example}
          <div class="example">
            <p class="example-label">Example</p>
            <p class="example-chinese">{card.example.chinese}</p>
            {#if card.example.pinyin}<p class="example-pinyin">{card.example.pinyin}</p>{/if}
            {#if card.example.meaningJa || card.example.meaningEn}<p class="example-meaning">
                {card.example.meaningJa ?? card.example.meaningEn}
              </p>{/if}
          </div>
        {/if}
      </div>
      <div class="rating-area">
        <p>How did recall feel?</p>
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
    {/if}
  </section>
{/if}

<footer>
  <span>FSRS rating records recall difficulty.</span><span
    >Correctness stays unset in this self-check flow.</span
  >
</footer>
