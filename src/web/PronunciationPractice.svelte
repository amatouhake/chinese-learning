<script lang="ts">
  import { onMount } from "svelte";

  import type { PronunciationFocus } from "../domain/pronunciation";
  import type { PronunciationCard, PronunciationSessionView } from "../domain/types";
  import { isPronunciationAudioCached } from "./audio-cache";
  import { postJson } from "./api";
  import { OfflineLearningStore, type BrowserOfflineState } from "./offline-store";
  import { synchronizeLearning } from "./sync";

  type Phase =
    "loading" | "choose" | "prompt" | "revealed" | "submitting" | "empty" | "completed" | "error";
  const focuses: Array<{ id: PronunciationFocus; label: string; hint: string }> = [
    { id: "mixed", label: "Mixed practice", hint: "Pinyin, tones, listening, and speaking" },
    { id: "pinyin", label: "Pinyin", hint: "Recognize and recall exact readings" },
    { id: "tones", label: "Tones", hint: "Single tones and two-syllable pairs" },
    { id: "listening", label: "Listening", hint: "Audio to Hanzi or meaning" },
    { id: "speaking", label: "Speaking", hint: "Say the word, compare, self-rate" },
  ];
  const selfRatings = [
    { value: 1, label: "Try again", hint: "Tone or syllable missed" },
    { value: 2, label: "Approximate", hint: "Recognizable, but shaky" },
    { value: 3, label: "Good", hint: "Broadly matched" },
    { value: 4, label: "Clear", hint: "Confident and controlled" },
  ] as const;

  let phase: Phase = "loading";
  let store: OfflineLearningStore | null = null;
  let browserState: BrowserOfflineState | null = null;
  let session: PronunciationSessionView | null = null;
  let card: PronunciationCard | null = null;
  let errorMessage = "";
  let audioError = "";
  let promptStartedAt = 0;
  let answerSaved = false;
  let wasCorrect: boolean | null = null;
  let isOffline = !navigator.onLine;
  let audioAvailableOffline = true;
  let syncMessage = "Choose a focus to prepare its offline set.";

  onMount(() => void initializePronunciation());

  async function initializePronunciation(): Promise<void> {
    phase = "loading";
    errorMessage = "";
    try {
      store ??= await OfflineLearningStore.open(localStorage);
      browserState = await store.snapshot();
      if (!browserState.activePronunciationSessionId) {
        phase = "choose";
        return;
      }
      if (!browserState.activePronunciationFocus) {
        throw new Error("The active pronunciation session has no practice focus.");
      }
      if (!isOffline) {
        try {
          await ensureSession(
            browserState.activePronunciationSessionId,
            browserState.deviceId,
            browserState.activePronunciationFocus,
          );
          await syncNow();
        } catch (error) {
          if (!(await store.getPronunciationSession(browserState.activePronunciationSessionId))) {
            throw error;
          }
          isOffline = true;
          syncMessage = "Network unavailable · using the cached pronunciation set";
        }
      }
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  async function createNewSession(focus: PronunciationFocus): Promise<void> {
    phase = "loading";
    errorMessage = "";
    try {
      if (isOffline) throw new Error("Reconnect to prepare a new pronunciation offline set.");
      store ??= await OfflineLearningStore.open(localStorage);
      browserState ??= await store.snapshot();
      browserState = await store.setActivePronunciationSession(
        `pronunciation-session:${crypto.randomUUID()}`,
        focus,
      );
      if (!browserState.activePronunciationSessionId || !browserState.activePronunciationFocus) {
        throw new Error("No active pronunciation session is available.");
      }
      await ensureSession(
        browserState.activePronunciationSessionId,
        browserState.deviceId,
        browserState.activePronunciationFocus,
      );
      await syncNow();
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  async function ensureSession(
    sessionId: string,
    deviceId: string,
    focus: PronunciationFocus,
  ): Promise<void> {
    const result = await postJson<{ session: PronunciationSessionView }>(
      "/api/pronunciation/sessions",
      { sessionId, deviceId, focus, maxItems: 10 },
    );
    session = result.session;
  }

  async function loadNextCard(): Promise<void> {
    if (!store || !browserState?.activePronunciationSessionId) {
      throw new Error("No pronunciation session is active.");
    }
    phase = "loading";
    const sessionId = browserState.activePronunciationSessionId;
    const [cachedSession, cachedCard, pending] = await Promise.all([
      store.getPronunciationSession(sessionId),
      store.getCachedPronunciationCard(sessionId),
      store.countPendingAttempts(sessionId),
    ]);
    if (!cachedSession) {
      throw new Error(
        isOffline
          ? "This pronunciation set was not cached before the connection was lost."
          : "The canonical pronunciation set has not been pulled yet.",
      );
    }
    session = {
      ...cachedSession,
      completedItems: Math.min(cachedSession.maxItems, cachedSession.completedItems + pending),
    };
    card = cachedCard;
    answerSaved = false;
    wasCorrect = null;
    audioError = "";
    if (cachedCard) {
      audioAvailableOffline = await isPronunciationAudioCached(cachedCard);
      promptStartedAt = performance.now();
      phase = "prompt";
      return;
    }
    if (pending === 0) browserState = await store.clearActivePronunciationSession(sessionId);
    phase = session.completedItems === 0 ? "empty" : "completed";
  }

  function revealRecall(): void {
    if (phase !== "prompt" || !card) return;
    phase = "revealed";
    if (card.activityType === "pronunciation_production" && card.media) void playAudio();
  }

  async function selectChoice(choiceId: string): Promise<void> {
    if (phase !== "prompt" || !card?.answerChoiceId) return;
    const correct = choiceId === card.answerChoiceId;
    await saveAttempt({
      correct,
      metadata: { interaction: "choice", selectedChoiceId: choiceId, readingId: card.readingId },
    });
    wasCorrect = correct;
  }

  async function saveRecall(correct: boolean): Promise<void> {
    if (phase !== "revealed" || answerSaved || card?.activityType !== "hanzi_to_pinyin") return;
    await saveAttempt({
      correct,
      metadata: { interaction: "reveal-and-self-check", readingId: card.readingId },
    });
    wasCorrect = correct;
  }

  async function saveProduction(selfRating: number): Promise<void> {
    if (phase !== "revealed" || answerSaved || card?.activityType !== "pronunciation_production")
      return;
    await saveAttempt({
      selfRating,
      metadata: { interaction: "speak-compare-self-rate", readingId: card.readingId },
    });
  }

  async function saveAttempt(result: {
    correct?: boolean;
    selfRating?: number;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    if (!card || !browserState?.activePronunciationSessionId) return;
    try {
      phase = "submitting";
      if (!store) throw new Error("Offline storage is not ready.");
      const staged = await store.stageAttempt(browserState, {
        cardId: card.cardId,
        studySessionId: browserState.activePronunciationSessionId,
        mode: "pronunciation",
        activityType: card.activityType,
        correct: result.correct,
        selfRating: result.selfRating,
        responseMs: Math.max(0, Math.round(performance.now() - promptStartedAt)),
        metadata: result.metadata,
      });
      browserState = staged.state;
      if (!isOffline) await syncNow();
      answerSaved = true;
      if (session && isOffline) {
        session = { ...session, completedItems: session.completedItems + 1 };
      }
      phase = "revealed";
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
      result.audioCacheFailures.length === 0
        ? "Offline set ready · synced"
        : `${result.audioCacheFailures.length} audio item(s) unavailable offline`;
  }

  async function skipUncachedAudio(): Promise<void> {
    if (!store || !card || !browserState?.activePronunciationSessionId) return;
    browserState = await store.discardCachedPronunciationCard(
      browserState.activePronunciationSessionId,
      card.cardId,
    );
    await loadNextCard();
  }

  async function handleOnline(): Promise<void> {
    isOffline = false;
    syncMessage = "Connection restored · synchronizing…";
    try {
      if (!store) return await initializePronunciation();
      await syncNow();
      if (card) audioAvailableOffline = await isPronunciationAudioCached(card);
      if (phase !== "revealed" && phase !== "prompt") await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  function handleOffline(): void {
    isOffline = true;
    syncMessage = `${browserState?.pendingCount ?? 0} queued · offline`;
  }

  async function playAudio(): Promise<void> {
    audioError = "";
    if (!card?.media) {
      audioError = "No reliable source recording is mapped to this exact reading.";
      return;
    }
    if (isOffline && !audioAvailableOffline) {
      audioError =
        "This recording was not cached before the connection was lost. Skip it to continue.";
      return;
    }
    try {
      await new Audio(card.media.url).play();
    } catch {
      audioError = "Audio could not play. Tap replay or check that local media was staged.";
    }
  }

  function activityLabel(value: PronunciationCard): string {
    switch (value.activityType) {
      case "hanzi_to_pinyin":
        return "Hanzi → pinyin recall";
      case "pinyin_to_hanzi":
        return "Pinyin → Hanzi";
      case "audio_to_hanzi":
        return "Audio → Hanzi";
      case "audio_to_meaning":
        return "Audio → meaning";
      case "tone_identification":
        return "Tone identification";
      case "tone_pair_identification":
        return "Tone pair";
      case "pronunciation_production":
        return "Pronunciation production";
    }
  }

  function promptInstruction(value: PronunciationCard): string {
    switch (value.activityType) {
      case "hanzi_to_pinyin":
        return "Recall the exact pinyin, including tones";
      case "pinyin_to_hanzi":
        return "Choose the Hanzi for this reading and sense";
      case "audio_to_hanzi":
        return "Replay as needed, then choose the Hanzi";
      case "audio_to_meaning":
        return "Replay as needed, then choose the exact sense";
      case "tone_identification":
        return "Choose the dictionary tone";
      case "tone_pair_identification":
        return "Choose the dictionary tone pair";
      case "pronunciation_production":
        return "Say this word aloud before comparing";
    }
  }

  function showError(error: unknown): void {
    errorMessage = error instanceof Error ? error.message : "Something went wrong.";
    phase = "error";
  }
</script>

<svelte:window ononline={() => void handleOnline()} onoffline={handleOffline} />

<header class="app-header surface-header">
  <div><p class="eyebrow">Pronunciation foundation</p></div>
  {#if session && (phase === "prompt" || phase === "revealed" || phase === "submitting")}
    <p
      class="progress"
      aria-label={`Item ${Math.min(session.completedItems + (answerSaved ? 0 : 1), session.maxItems)} of ${session.maxItems}`}
    >
      <strong>{Math.min(session.completedItems + (answerSaved ? 0 : 1), session.maxItems)}</strong
      ><span>/ {session.maxItems}</span>
    </p>
  {/if}
</header>

<p class:offline={isOffline} class="sync-status" aria-live="polite">
  {isOffline ? `${browserState?.pendingCount ?? 0} queued · offline` : syncMessage}
</p>

{#if phase === "loading" || phase === "submitting"}
  <section class="status-panel" aria-live="polite">
    <div class="pulse pronunciation-pulse" aria-hidden="true"></div>
    <h2>{phase === "submitting" ? "Saving practice…" : "Preparing sounds…"}</h2>
    <p>
      {phase === "submitting"
        ? "This ordinary-practice event is durable and idempotent."
        : "Every prompt stays attached to one exact reading."}
    </p>
  </section>
{:else if phase === "choose"}
  <section class="mode-picker">
    <div class="mode-picker-heading">
      <p class="status-kicker">Ten focused items</p>
      <h2>What do you want to hear?</h2>
      <p>
        Mixed practice is the best default. All pronunciation work here is unscheduled practice.
      </p>
    </div>
    <div class="focus-grid">
      {#each focuses as focus}
        <button
          class:recommended={focus.id === "mixed"}
          disabled={isOffline}
          onclick={() => void createNewSession(focus.id)}
        >
          <strong>{focus.label}</strong><span>{focus.hint}</span>
        </button>
      {/each}
    </div>
  </section>
{:else if phase === "error"}
  <section class="status-panel error-panel" role="alert">
    <p class="status-kicker">Practice paused safely</p>
    <h2>Nothing was discarded</h2>
    <p>{errorMessage}</p>
    <button class="primary-button" onclick={() => void initializePronunciation()}>Try again</button>
  </section>
{:else if phase === "empty"}
  <section class="status-panel">
    <p class="completion-mark" aria-hidden="true">声</p>
    <h2>No matching practice is available</h2>
    <p>Import the pronunciation corpus, or choose a focus with available exact-reading content.</p>
    <button class="primary-button" onclick={() => (phase = "choose")}>Choose another focus</button>
  </section>
{:else if phase === "completed"}
  <section class="status-panel">
    <p class="completion-mark" aria-hidden="true">听</p>
    <h2>Pronunciation set complete</h2>
    <p>
      {session?.completedItems ?? 0} non-FSRS attempts are {browserState?.pendingCount
        ? "durably queued for reconnect"
        : "safely synchronized"}.
    </p>
    <button
      class="primary-button"
      onclick={() =>
        void (browserState?.pendingCount ? initializePronunciation() : (phase = "choose"))}
    >
      {browserState?.pendingCount ? "Retry synchronization" : "Practice another focus"}
    </button>
  </section>
{:else if card}
  <section class="study-card pronunciation-card" aria-live="polite">
    <div class="card-meta">
      <span class="queue-badge sound-badge">Sound</span><span>{activityLabel(card)}</span>
      {#if card.lexeme.hskLevel}<span>HSK {card.lexeme.hskLevel}</span>{/if}
    </div>
    <div class="prompt-block pronunciation-prompt">
      <p class="prompt-instruction">{promptInstruction(card)}</p>
      {#if card.activityType.startsWith("audio_to_")}
        <button
          class="audio-button"
          disabled={isOffline && !audioAvailableOffline}
          onclick={() => void playAudio()}
          aria-label="Play or replay word audio"
          ><span aria-hidden="true">▶</span><strong>Play / replay</strong></button
        >
        {#if isOffline && !audioAvailableOffline}
          <p class="audio-error" role="status">
            This recording was not cached before network loss. Other pronunciation cards still work.
          </p>
          <button class="audio-replay-small" onclick={() => void skipUncachedAudio()}
            >Skip uncached audio</button
          >
        {/if}
      {:else}
        <h2 class:hanzi-prompt={card.activityType !== "pinyin_to_hanzi"}>
          {card.activityType === "pinyin_to_hanzi" ? card.reading.pinyin : card.lexeme.simplified}
        </h2>
      {/if}
      {#if card.activityType === "tone_identification" || card.activityType === "tone_pair_identification"}<p
          class="untoned"
        >
          {card.reading.untonedPinyin}
        </p>{/if}
      {#if card.activityType === "pronunciation_production"}<p class="production-pinyin">
          {card.reading.pinyin}
        </p>{/if}
      {#if !card.activityType.startsWith("audio_to_") && card.lexeme.meanings[0]}<p
          class="sense-hint"
        >
          {card.lexeme.meanings[0]}
        </p>{/if}
      {#if audioError}<p class="audio-error" role="status">{audioError}</p>{/if}
    </div>

    {#if phase === "prompt" && card.choices.length > 0}
      <div class:pair-grid={card.activityType === "tone_pair_identification"} class="choice-grid">
        {#each card.choices as choice}<button onclick={() => void selectChoice(choice.id)}
            >{choice.label}</button
          >{/each}
      </div>
    {:else if phase === "prompt"}
      <button class="reveal-button" onclick={revealRecall}
        ><span
          >{card.activityType === "pronunciation_production"
            ? "I said it — compare"
            : "Reveal pinyin"}</span
        ></button
      >
    {:else}
      <div class="pronunciation-answer">
        {#if wasCorrect !== null}<p class:correct={wasCorrect} class="feedback">
            {wasCorrect ? "Correct" : "Not this time"}
          </p>{/if}
        <div class="answer-heading">
          <p class="answer-hanzi">{card.lexeme.simplified}</p>
          <div>
            <p class="pinyin">{card.reading.pinyin}</p>
            <p class="numeric-pinyin">{card.reading.numericPinyin}</p>
          </div>
        </div>
        {#if card.lexeme.meanings.length > 0}<div class="reading-senses">
            {#each card.lexeme.meanings.slice(0, 3) as meaning}<p>{meaning}</p>{/each}
          </div>{/if}
        {#if card.media}
          <button class="audio-replay-small" onclick={() => void playAudio()}
            >▶ Replay exact-reading audio</button
          >
          <p class="media-credit">{card.media.attribution} · {card.media.license}</p>
        {:else if card.activityType === "pronunciation_production"}<p class="safe-degrade">
            No reliable recording is mapped to this exact reading; compare against pinyin and tones
            only.
          </p>{/if}
      </div>
      {#if !answerSaved && card.activityType === "hanzi_to_pinyin"}
        <div class="binary-grid">
          <button class="missed" onclick={() => void saveRecall(false)}>Missed it</button><button
            class="got-it"
            onclick={() => void saveRecall(true)}>Got it</button
          >
        </div>
      {:else if !answerSaved && card.activityType === "pronunciation_production"}
        <div class="production-ratings">
          {#each selfRatings as rating}<button onclick={() => void saveProduction(rating.value)}
              ><strong>{rating.label}</strong><span>{rating.hint}</span></button
            >{/each}
        </div>
      {:else if answerSaved}
        <button class="primary-button continue-button" onclick={() => void loadNextCard()}
          >Continue</button
        >
      {/if}
    {/if}
  </section>
{/if}

<details class="sound-reference">
  <summary>Quick pinyin & tone reference</summary>
  <div class="reference-content">
    <div>
      <h3>Tones</h3>
      <p>
        <b>1</b> high level · <b>2</b> rising · <b>3</b> low/dipping · <b>4</b> falling · <b>5</b> neutral/light
      </p>
      <p>
        Pair cards show dictionary tones. Natural speech may change their surface shape, especially
        3–3 and 一/不.
      </p>
    </div>
    <div>
      <h3>Initials</h3>
      <p>
        <b>j q x</b> use a high, front tongue position; <b>zh ch sh r</b> curl back; <b>z c s</b> stay
        forward. Unaspirated/aspirated pairs include b/p, d/t, g/k, j/q, zh/ch, z/c.
      </p>
    </div>
    <div>
      <h3>Finals & spelling</h3>
      <p>
        <b>ü</b> is written <b>u</b> after j/q/x/y. Keep ian vs iang, en vs eng, and in vs ing distinct.
        Tone marks belong to the vowel nucleus; numeric pinyin uses 1–4 and 5 for neutral.
      </p>
    </div>
  </div>
</details>

<footer>
  <span>Correctness, production self-rating, and FSRS rating are separate fields.</span><span
    >Pronunciation sessions never mutate card_state.</span
  >
</footer>
