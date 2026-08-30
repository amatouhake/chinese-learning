<script lang="ts">
  import { onMount } from "svelte";

  import type { FsrsRating, StudyCard, StudyNextResult, StudySessionView } from "../domain/types";
  import {
    clearPendingStudyAttempt,
    loadOrCreateBrowserStudyState,
    setActiveStudySession,
    stageStudyAttempt,
    type BrowserStudyState,
  } from "./study-storage";

  type Phase = "loading" | "prompt" | "revealed" | "submitting" | "empty" | "completed" | "error";

  const ratings: Array<{ rating: FsrsRating; label: string; hint: string }> = [
    { rating: 1, label: "Again", hint: "Forgot" },
    { rating: 2, label: "Hard", hint: "Barely" },
    { rating: 3, label: "Good", hint: "Recalled" },
    { rating: 4, label: "Easy", hint: "Immediate" },
  ];

  let phase: Phase = "loading";
  let browserState: BrowserStudyState | null = null;
  let session: StudySessionView | null = null;
  let card: StudyCard | null = null;
  let errorMessage = "";
  let promptStartedAt = 0;

  onMount(() => {
    void initializeStudy();
  });

  async function initializeStudy(): Promise<void> {
    phase = "loading";
    errorMessage = "";
    try {
      browserState = await loadOrCreateBrowserStudyState(localStorage);
      if (!browserState.activeSessionId) {
        await createNewSession();
        return;
      }

      await ensureSession(browserState.activeSessionId, browserState.deviceId);
      if (browserState.pendingAttempt) {
        phase = "submitting";
        await deliverPendingAttempt();
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
      browserState ??= await loadOrCreateBrowserStudyState(localStorage);
      if (browserState.pendingAttempt) {
        throw new Error("Finish delivering the pending review before starting another session.");
      }
      const requestedSessionId = `study-session:${crypto.randomUUID()}`;
      browserState = await setActiveStudySession(localStorage, browserState, requestedSessionId);
      if (!browserState.activeSessionId) throw new Error("No active study session is available.");
      await ensureSession(browserState.activeSessionId, browserState.deviceId);
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
  }

  async function loadNextCard(): Promise<void> {
    if (!browserState?.activeSessionId) throw new Error("No active study session is available.");
    phase = "loading";
    const result = await postJson<StudyNextResult>(
      `/api/study/sessions/${encodeURIComponent(browserState.activeSessionId)}/next`,
      { deviceId: browserState.deviceId },
    );
    session = result.session;
    card = result.card;

    if (result.status === "card" && result.card) {
      promptStartedAt = performance.now();
      phase = "prompt";
      return;
    }

    browserState = await setActiveStudySession(localStorage, browserState, null);
    phase = result.status === "empty" ? "empty" : "completed";
  }

  function revealAnswer(): void {
    if (phase !== "prompt") return;
    phase = "revealed";
  }

  async function rateCard(rating: FsrsRating): Promise<void> {
    if (phase !== "revealed" || !card || !browserState?.activeSessionId) return;

    const responseMs = Math.max(0, Math.round(performance.now() - promptStartedAt));
    try {
      phase = "submitting";
      const staged = await stageStudyAttempt(localStorage, browserState, {
        cardId: card.cardId,
        studySessionId: browserState.activeSessionId,
        mode: "study",
        activityType: card.activityType,
        responseMs,
        expectedCardStateVersion: card.state.version,
        metadata: {
          interaction: "reveal-and-rate",
          queueSource: card.source,
        },
        fsrsReview: {
          rating,
          schedulerConfigId: card.schedulerConfigId,
        },
      });
      browserState = staged.state;
      await deliverPendingAttempt();
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  async function deliverPendingAttempt(): Promise<void> {
    if (!browserState?.pendingAttempt) return;
    const eventId = browserState.pendingAttempt.eventId;
    await postJson("/api/attempts", browserState.pendingAttempt);
    browserState = await clearPendingStudyAttempt(localStorage, browserState, eventId);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    ) {
      return;
    }

    if (phase === "prompt" && (event.key === " " || event.key === "Enter")) {
      event.preventDefault();
      revealAnswer();
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

  function directionLabel(value: StudyCard): string {
    return value.activityType === "hanzi_to_meaning" ? "Chinese → meaning" : "Meaning → Chinese";
  }

  function showError(error: unknown): void {
    errorMessage = error instanceof Error ? error.message : "Something went wrong.";
    phase = "error";
  }

  async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const serverMessage =
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as Record<string, unknown>).error === "string"
          ? ((payload as Record<string, unknown>).error as string)
          : `Request failed (${response.status})`;
      if (response.status === 401 || response.status === 503) {
        throw new Error(
          "Local study access is not enabled. Use bun run dev:worker with LOCAL_STUDY_BYPASS=true in .dev.vars.",
        );
      }
      throw new Error(serverMessage);
    }
    return payload as T;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
  <meta
    name="description"
    content="A focused Chinese vocabulary study session with durable FSRS reviews."
  />
</svelte:head>

<main>
  <header class="app-header">
    <div>
      <p class="eyebrow">Vocabulary study</p>
      <h1>中文学习</h1>
    </div>
    {#if session && (phase === "prompt" || phase === "revealed" || phase === "submitting")}
      <p class="progress" aria-label={`Card ${session.reviewedCards + 1} of ${session.maxCards}`}>
        <strong>{session.reviewedCards + 1}</strong><span>/ {session.maxCards}</span>
      </p>
    {/if}
  </header>

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
      <p>{session?.reviewedCards ?? 0} reviews are safely persisted.</p>
      <button class="primary-button" onclick={() => void createNewSession()}
        >Study another 10</button
      >
    </section>
  {:else if card}
    <section class="study-card" aria-live="polite">
      <div class="card-meta">
        <span class:due={card.source === "due"} class="queue-badge">
          {card.source === "due" ? "Due" : "New"}
        </span>
        <span>{directionLabel(card)}</span>
        {#if card.lexeme.hskLevel}
          <span>HSK {card.lexeme.hskLevel}</span>
        {/if}
      </div>

      <div class="prompt-block">
        <p class="prompt-instruction">
          {card.activityType === "hanzi_to_meaning" ? "Recall the meaning" : "Recall the Chinese"}
        </p>
        <h2 class:hanzi-prompt={card.activityType === "hanzi_to_meaning"}>
          {promptText(card)}
        </h2>
      </div>

      {#if phase === "prompt"}
        <button class="reveal-button" onclick={revealAnswer}>
          <span>Reveal answer</span><kbd>Space</kbd>
        </button>
      {:else}
        <div class="answer" aria-label="Answer">
          <div class="answer-heading">
            <p class="answer-hanzi">{card.lexeme.simplified}</p>
            <div>
              {#if card.lexeme.traditional && card.lexeme.traditional !== card.lexeme.simplified}
                <p class="traditional">Traditional: {card.lexeme.traditional}</p>
              {/if}
              {#if card.lexeme.pinyin}<p class="pinyin">{card.lexeme.pinyin}</p>{/if}
            </div>
          </div>

          <div class="meanings">
            {#each card.lexeme.meanings as meaning}
              <p><span>{meaning.language.toUpperCase()}</span>{meaning.text}</p>
            {/each}
          </div>

          {#if card.example}
            <div class="example">
              <p class="example-label">Example</p>
              <p class="example-chinese">{card.example.chinese}</p>
              {#if card.example.pinyin}<p class="example-pinyin">{card.example.pinyin}</p>{/if}
              {#if card.example.meaningJa || card.example.meaningEn}
                <p class="example-meaning">{card.example.meaningJa ?? card.example.meaningEn}</p>
              {/if}
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
                <kbd>{option.rating}</kbd>
                <strong>{option.label}</strong>
                <span>{option.hint}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </section>
  {/if}

  <footer>
    <span>FSRS rating records recall difficulty.</span>
    <span>Correctness stays unset in this self-check flow.</span>
  </footer>
</main>
