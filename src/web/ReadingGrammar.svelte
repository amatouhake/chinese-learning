<script lang="ts">
  import { onMount, tick } from "svelte";

  import type { GrammarCard, GuidedSessionView, ReadingCard } from "../domain/types";
  import { ApiError, postJson } from "./api";
  import { OfflineLearningStore, type BrowserOfflineState } from "./offline-store";
  import { synchronizeLearning } from "./sync";

  type SurfaceMode = "reading" | "grammar";
  type ReadingPhase = "loading" | "prompt" | "submitting" | "empty" | "completed" | "error";
  type GrammarPhase =
    | "loading"
    | "introduction"
    | "practice"
    | "feedback"
    | "submitting"
    | "empty"
    | "completed"
    | "error";

  const confidenceRatings = [
    { value: 1, label: "Lost", hint: "Need the explanation again" },
    { value: 2, label: "With help", hint: "Hints carried me" },
    { value: 3, label: "Mostly", hint: "Structure is becoming clear" },
    { value: 4, label: "Understood", hint: "Could explain the pattern" },
  ] as const;

  let mode: SurfaceMode = "reading";
  let store: OfflineLearningStore | null = null;
  let browserState: BrowserOfflineState | null = null;
  let session: GuidedSessionView | null = null;
  let readingCard: ReadingCard | null = null;
  let grammarCard: GrammarCard | null = null;
  let readingPhase: ReadingPhase = "loading";
  let grammarPhase: GrammarPhase = "loading";
  let revealStage = 0;
  let exampleHelpRevealed = false;
  let selectedGrammarChoice = "";
  let grammarCorrect = false;
  let errorMessage = "";
  let promptStartedAt = 0;
  let browserOffline = !navigator.onLine;
  let isOffline = browserOffline;
  let syncMessage = "Preparing a five-item offline set…";

  onMount(() => void initializeMode());

  async function selectMode(
    next: SurfaceMode,
    requestedGrammarTopicId: string | null = null,
  ): Promise<void> {
    mode = next;
    session = null;
    readingCard = null;
    grammarCard = null;
    errorMessage = "";
    await initializeMode(requestedGrammarTopicId);
  }

  async function initializeMode(requestedGrammarTopicId: string | null = null): Promise<void> {
    setLoading();
    try {
      store ??= await OfflineLearningStore.open(localStorage);
      browserState = await store.snapshot();
      if (
        mode === "grammar" &&
        requestedGrammarTopicId &&
        browserState.activeGrammarSessionId &&
        browserState.activeGrammarTopicId !== requestedGrammarTopicId
      ) {
        if (browserOffline) {
          throw new Error("Reconnect once to open this connected grammar topic.");
        }
        browserState = await store.clearActiveGrammarSession(browserState.activeGrammarSessionId);
      }
      const activeId = activeSessionId();
      if (!activeId) {
        if (browserOffline) {
          throw new Error(`Reconnect once to prepare a new offline ${mode} set.`);
        }
        await createSession(mode === "grammar" ? requestedGrammarTopicId : null);
        return;
      }
      if (!browserOffline) {
        try {
          await ensureSession(activeId, browserState.deviceId);
          await syncNow();
        } catch (error) {
          const cached =
            mode === "reading"
              ? await store.getReadingSession(activeId)
              : await store.getGrammarSession(activeId);
          if (!cached) throw error;
          isOffline = browserOffline || !(error instanceof ApiError);
          syncMessage = isOffline
            ? `Network unavailable · using cached ${mode} content`
            : `Service unavailable · using cached ${mode} content`;
        }
      }
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  async function createSession(topicId: string | null = null): Promise<void> {
    setLoading();
    try {
      if (browserOffline) throw new Error(`Reconnect to prepare another offline ${mode} set.`);
      store ??= await OfflineLearningStore.open(localStorage);
      browserState ??= await store.snapshot();
      if (mode === "reading") {
        browserState = await store.setActiveReadingSession(
          `reading-session:${crypto.randomUUID()}`,
        );
      } else {
        browserState = await store.setActiveGrammarSession(
          `grammar-session:${crypto.randomUUID()}`,
          topicId,
        );
      }
      const activeId = activeSessionId();
      if (!activeId) throw new Error(`No active ${mode} session is available.`);
      await ensureSession(activeId, browserState.deviceId);
      await syncNow();
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  async function ensureSession(sessionId: string, deviceId: string): Promise<void> {
    const body: Record<string, unknown> = { sessionId, deviceId, maxItems: 5 };
    if (mode === "grammar" && browserState?.activeGrammarTopicId) {
      body.topicId = browserState.activeGrammarTopicId;
    }
    const result = await postJson<{ session: GuidedSessionView }>(`/api/${mode}/sessions`, body);
    session = result.session;
    if (!store) throw new Error("Offline storage is not ready.");
    await store.rememberGuidedSession(result.session);
  }

  async function loadNextCard(): Promise<void> {
    if (!store) throw new Error("Offline storage is not ready.");
    const activeId = activeSessionId();
    if (!activeId) throw new Error(`No ${mode} session is active.`);
    setLoading();
    if (mode === "reading") {
      const [cachedSession, cachedCard] = await Promise.all([
        store.getReadingSession(activeId),
        store.getCachedReadingCard(activeId),
      ]);
      if (!cachedSession) throw missingCacheError("reading");
      session = cachedSession;
      readingCard = cachedCard;
      revealStage = 0;
      if (cachedCard) {
        promptStartedAt = performance.now();
        readingPhase = "prompt";
        return;
      }
      if (cachedSession.endedAt !== null) {
        browserState = await store.clearActiveReadingSession(activeId);
      }
      readingPhase = cachedSession.completedItems === 0 ? "empty" : "completed";
      return;
    }

    const [cachedSession, cachedCard] = await Promise.all([
      store.getGrammarSession(activeId),
      store.getCachedGrammarCard(activeId),
    ]);
    if (!cachedSession) throw missingCacheError("grammar");
    session = cachedSession;
    grammarCard = cachedCard;
    exampleHelpRevealed = false;
    selectedGrammarChoice = "";
    if (cachedCard) {
      promptStartedAt = performance.now();
      grammarPhase = "introduction";
      return;
    }
    if (cachedSession.endedAt !== null) {
      browserState = await store.clearActiveGrammarSession(activeId);
    }
    grammarPhase = cachedSession.completedItems === 0 ? "empty" : "completed";
  }

  async function revealNext(): Promise<void> {
    if (readingPhase !== "prompt" || revealStage >= 4) return;
    revealStage += 1;
    await tick();
    followReveal(revealStage);
  }

  function followReveal(stage: number): void {
    const revealedSection = document.querySelector<HTMLElement>(
      `.reading-card [data-reveal-stage="${stage}"]`,
    );
    const nextAction = document.querySelector<HTMLElement>(
      stage === 4 ? ".reading-card .rating-area" : ".reading-card .staged-reveal",
    );
    if (nextAction && !isComfortablyVisible(nextAction)) {
      nextAction.scrollIntoView({ behavior: revealScrollBehavior(), block: "nearest" });
      return;
    }
    if (revealedSection && !isComfortablyVisible(revealedSection)) {
      revealedSection.scrollIntoView({ behavior: revealScrollBehavior(), block: "nearest" });
    }
  }

  function isComfortablyVisible(element: HTMLElement): boolean {
    const bounds = element.getBoundingClientRect();
    const margin = 12;
    return bounds.top >= margin && bounds.bottom <= globalThis.innerHeight - margin;
  }

  function revealScrollBehavior(): ScrollBehavior {
    const reducedMotion =
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return reducedMotion ? "auto" : "smooth";
  }

  async function saveReading(selfRating: number): Promise<void> {
    if (
      readingPhase !== "prompt" ||
      revealStage !== 4 ||
      !readingCard ||
      !browserState?.activeReadingSessionId ||
      !store
    )
      return;
    try {
      readingPhase = "submitting";
      const staged = await store.stageAttempt(browserState, {
        cardId: readingCard.cardId,
        studySessionId: browserState.activeReadingSessionId,
        mode: "reading",
        activityType: "sentence_reading",
        selfRating,
        responseMs: elapsedPromptTime(),
        metadata: {
          interaction: "staged-sentence-reading",
          sentenceId: readingCard.sentenceId,
          revealOrder: ["vocabulary", "pinyin", "meaning", "grammar"],
          grammarTopicIds: readingCard.grammarTopics.map(({ id }) => id),
        },
      });
      browserState = staged.state;
      if (!browserOffline) await syncNow();
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  function beginGrammarPractice(): void {
    if (grammarPhase !== "introduction") return;
    grammarPhase = "practice";
  }

  function chooseGrammar(choiceId: string): void {
    if (grammarPhase !== "practice" || !grammarCard) return;
    selectedGrammarChoice = choiceId;
    grammarCorrect = choiceId === grammarCard.topic.practice.answerChoiceId;
    grammarPhase = "feedback";
  }

  async function saveGrammar(selfRating: number): Promise<void> {
    if (
      grammarPhase !== "feedback" ||
      !grammarCard ||
      !selectedGrammarChoice ||
      !browserState?.activeGrammarSessionId ||
      !store
    )
      return;
    const practiceSentenceId = grammarCard.practiceSentenceId;
    const example = grammarCard.examples.find(
      ({ sentenceId }) => sentenceId === practiceSentenceId,
    );
    if (!example) return showError(new Error("This grammar topic has no linked example sentence."));
    try {
      grammarPhase = "submitting";
      const staged = await store.stageAttempt(browserState, {
        cardId: grammarCard.cardId,
        studySessionId: browserState.activeGrammarSessionId,
        mode: "grammar",
        activityType: "sentence_reading",
        correct: grammarCorrect,
        selfRating,
        responseMs: elapsedPromptTime(),
        metadata: {
          interaction: "grammar-choice",
          topicId: grammarCard.topicId,
          practiceVersionId: grammarCard.practiceVersionId,
          sentenceId: example.sentenceId,
          selectedChoiceId: selectedGrammarChoice,
        },
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
    syncMessage = result.error
      ? `${result.pending} queued · ${result.error}`
      : result.pending === 0
        ? "Offline set ready · synced"
        : `${result.pending} queued`;
  }

  async function handleOnline(): Promise<void> {
    browserOffline = false;
    isOffline = false;
    syncMessage = "Connection restored · synchronizing…";
    try {
      if (!store) return await initializeMode();
      await syncNow();
      const hasActivePrompt =
        mode === "reading"
          ? readingPhase === "prompt"
          : grammarPhase === "introduction" ||
            grammarPhase === "practice" ||
            grammarPhase === "feedback";
      if (!hasActivePrompt) await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  function handleOffline(): void {
    browserOffline = true;
    isOffline = true;
    syncMessage = `${browserState?.pendingCount ?? 0} queued · offline`;
  }

  function activeSessionId(): string | null {
    if (!browserState) return null;
    return mode === "reading"
      ? browserState.activeReadingSessionId
      : browserState.activeGrammarSessionId;
  }

  function setLoading(): void {
    if (mode === "reading") readingPhase = "loading";
    else grammarPhase = "loading";
  }

  function missingCacheError(kind: SurfaceMode): Error {
    return new Error(
      isOffline
        ? `This ${kind} set was not cached before the connection was lost.`
        : `The canonical ${kind} set has not been pulled yet.`,
    );
  }

  function elapsedPromptTime(): number {
    return Math.max(0, Math.round(performance.now() - promptStartedAt));
  }

  function showError(error: unknown): void {
    errorMessage = error instanceof Error ? error.message : "Something went wrong.";
    if (mode === "reading") readingPhase = "error";
    else grammarPhase = "error";
  }

  function preferredMeaning(meanings: ReadingCard["vocabulary"][number]["meanings"]): string {
    return (
      (
        meanings.find(({ language }) => language === "ja") ??
        meanings.find(({ language }) => language === "en") ??
        meanings[0]
      )?.text ?? "Meaning unavailable"
    );
  }

  function completedPracticeSentence(card: GrammarCard): string {
    const answer = card.topic.practice.choices.find(
      ({ id }) => id === card.topic.practice.answerChoiceId,
    );
    return card.topic.practice.prompt.replace("___", answer?.label ?? "");
  }
</script>

<svelte:window ononline={() => void handleOnline()} onoffline={handleOffline} />

<header class="app-header surface-header guided-header">
  <div class="surface-title">
    <span class="section-mark">04</span>
    <h2>{mode === "reading" ? "Read" : "Grammar"}</h2>
  </div>
  {#if session && (readingPhase === "prompt" || grammarPhase === "introduction" || grammarPhase === "practice" || grammarPhase === "feedback")}
    <p class="progress" aria-label={`Item ${session.completedItems + 1} of ${session.maxItems}`}>
      <strong>{session.completedItems + 1}</strong><span>/ {session.maxItems}</span>
    </p>
  {/if}
</header>

<nav class="guided-nav" aria-label="Reading and grammar mode">
  <button class:active={mode === "reading"} onclick={() => void selectMode("reading")}
    >Read sentences</button
  ><button class:active={mode === "grammar"} onclick={() => void selectMode("grammar")}
    >Grammar path</button
  >
</nav>

<p class:offline={isOffline} class="sync-status" aria-live="polite">
  {isOffline ? `${browserState?.pendingCount ?? 0} queued · offline` : syncMessage}
</p>

{#if (mode === "reading" && (readingPhase === "loading" || readingPhase === "submitting")) || (mode === "grammar" && (grammarPhase === "loading" || grammarPhase === "submitting"))}
  <section class="status-panel" aria-live="polite">
    <div class="pulse guided-pulse" aria-hidden="true"></div>
    <h2>
      {readingPhase === "submitting" || grammarPhase === "submitting"
        ? "Saving learning history…"
        : "Preparing real sentences…"}
    </h2>
    <p>
      {readingPhase === "submitting" || grammarPhase === "submitting"
        ? "Your place is safe."
        : "Opening the next lesson."}
    </p>
  </section>
{:else if (mode === "reading" && readingPhase === "error") || (mode === "grammar" && grammarPhase === "error")}
  <section class="status-panel error-panel" role="alert">
    <p class="status-kicker">Practice paused safely</p>
    <h2>Nothing was discarded</h2>
    <p>{errorMessage}</p>
    <button class="primary-button" onclick={() => void initializeMode()}>Try again</button>
  </section>
{:else if (mode === "reading" && readingPhase === "empty") || (mode === "grammar" && grammarPhase === "empty")}
  <section class="status-panel">
    <p class="completion-mark" aria-hidden="true">—</p>
    <h2>No foundation content is available</h2>
    <p>There is no lesson ready for this path yet.</p>
  </section>
{:else if (mode === "reading" && readingPhase === "completed") || (mode === "grammar" && grammarPhase === "completed")}
  <section class="status-panel">
    <p class="completion-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19 7" /></svg>
    </p>
    <h2>{mode === "reading" ? "Reading set complete" : "Grammar set complete"}</h2>
    <p>
      {session?.completedItems ?? 0} non-FSRS attempts are {browserState?.pendingCount
        ? "durably queued for reconnect"
        : "safely synchronized"}.
    </p>
    <button
      class="primary-button"
      onclick={() => void (browserState?.pendingCount ? initializeMode() : createSession())}
      >{browserState?.pendingCount ? "Retry synchronization" : `Start another ${mode} set`}</button
    >
  </section>
{:else if mode === "reading" && readingCard}
  <section class="study-card reading-card" aria-live="polite">
    <div class="card-meta">
      <span class="queue-badge reading-badge">Sentence</span><span>Chinese first</span>
    </div>
    <div class="reading-prompt">
      <p class="prompt-instruction">Read for meaning</p>
      <h2>{readingCard.sentence.chinese}</h2>
    </div>

    {#if revealStage >= 1}
      <section
        class="reveal-panel vocabulary-reveal"
        data-reveal-stage="1"
        aria-label="Vocabulary hints"
      >
        <p class="reveal-kicker">1 · Vocabulary / readings</p>
        <p class="reading-note">Dictionary readings; the sentence pinyin follows its context.</p>
        <div class="vocabulary-list">
          {#each readingCard.vocabulary as hint}
            <div>
              <strong>{hint.simplified}</strong><span>{hint.pinyin}</span><small
                >{preferredMeaning(hint.meanings)}</small
              >
            </div>
          {/each}
        </div>
      </section>
    {/if}
    {#if revealStage >= 2}
      <section class="reveal-panel" data-reveal-stage="2" aria-label="Sentence pinyin">
        <p class="reveal-kicker">2 · Pinyin</p>
        <p class="sentence-pinyin">{readingCard.sentence.pinyin}</p>
      </section>
    {/if}
    {#if revealStage >= 3}
      <section class="reveal-panel" data-reveal-stage="3" aria-label="Sentence meaning">
        <p class="reveal-kicker">3 · Meaning</p>
        <p class="sentence-meaning">{readingCard.sentence.meaningJa}</p>
        <p class="sentence-meaning secondary">{readingCard.sentence.meaningEn}</p>
      </section>
    {/if}
    {#if revealStage >= 4}
      <section
        class="reveal-panel grammar-reveal"
        data-reveal-stage="4"
        aria-label="Grammar explanation"
      >
        <p class="reveal-kicker">4 · Grammar</p>
        {#each readingCard.grammarTopics as topic}
          <div class="topic-explanation">
            <div>
              <h3>{topic.title}</h3>
              <code>{topic.pattern}</code>
            </div>
            <p>{topic.explanationJa}</p>
            <p class="contrast">{topic.contrastJa}</p>
          </div>
        {/each}
        <button
          class="text-button"
          onclick={() => void selectMode("grammar", readingCard?.grammarTopics[0]?.id ?? null)}
          >Open the connected grammar path</button
        >
      </section>
    {/if}

    {#if revealStage < 4}
      <button class="reveal-button staged-reveal" onclick={() => void revealNext()}>
        <span
          >{["Reveal vocabulary", "Reveal pinyin", "Reveal meaning", "Reveal grammar"][
            revealStage
          ]}</span
        ><small>{revealStage + 1} / 4</small>
      </button>
    {:else}
      <div class="rating-area">
        <p>How clear was it?</p>
        <div class="rating-grid guided-ratings">
          {#each confidenceRatings as rating}
            <button
              class={`rating rating-${rating.value}`}
              onclick={() => void saveReading(rating.value)}
            >
              <strong>{rating.label}</strong><span>{rating.hint}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </section>
{:else if mode === "grammar" && grammarCard}
  <section class="study-card grammar-card" aria-live="polite">
    <div class="card-meta">
      <span class="queue-badge grammar-badge">Topic {grammarCard.topic.sequence}</span>
      <span>{grammarCard.topic.state?.status ?? "New topic"}</span>
    </div>
    <div class="grammar-heading">
      <h2>{grammarCard.topic.title}</h2>
      <code>{grammarCard.topic.pattern}</code>
      <p>{grammarCard.topic.summaryJa}</p>
    </div>

    {#if grammarPhase === "introduction"}
      <div class="grammar-lesson">
        <p>{grammarCard.topic.explanationJa}</p>
        <p class="contrast">{grammarCard.topic.contrastJa}</p>
        {#each grammarCard.examples as example}
          <div class="grammar-example">
            <p class="example-label">Read this example</p>
            <p class="example-chinese">{example.chinese}</p>
            {#if exampleHelpRevealed}<p class="example-pinyin">{example.pinyin}</p>
              <p class="example-meaning">{example.meaningJa}</p>{/if}
          </div>
        {/each}
        {#if !exampleHelpRevealed}<button
            class="text-button"
            onclick={() => (exampleHelpRevealed = true)}>Reveal example pinyin & meaning</button
          >{/if}
        <button class="primary-button grammar-practice-button" onclick={beginGrammarPractice}
          >Practice this pattern</button
        >
      </div>
    {:else if grammarPhase === "practice"}
      <div class="grammar-question">
        <p class="prompt-instruction">Choose the word that completes the sentence</p>
        <h3>{grammarCard.topic.practice.prompt}</h3>
      </div>
      <div class="choice-grid grammar-choices">
        {#each grammarCard.topic.practice.choices as choice}<button
            onclick={() => chooseGrammar(choice.id)}>{choice.label}</button
          >{/each}
      </div>
    {:else if grammarPhase === "feedback"}
      <div class="grammar-feedback">
        <p class:correct={grammarCorrect} class="feedback">
          {grammarCorrect ? "Correct" : "Review the distinction"}
        </p>
        <p class="practice-answer">{completedPracticeSentence(grammarCard)}</p>
        <p>{grammarCard.topic.practice.explanationJa}</p>
      </div>
      <div class="rating-area">
        <p>How confident are you in this grammar point?</p>
        <div class="rating-grid guided-ratings">
          {#each confidenceRatings as rating}
            <button
              class={`rating rating-${rating.value}`}
              onclick={() => void saveGrammar(rating.value)}
            >
              <strong>{rating.label}</strong><span>{rating.hint}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </section>
{/if}
