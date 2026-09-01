<script lang="ts">
  import { onMount } from "svelte";

  import {
    PRONUNCIATION_AUDIO_SKIP_INTERACTION,
    PRONUNCIATION_AUDIO_SKIP_REASON,
    type PronunciationFocus,
  } from "../domain/pronunciation";
  import { PRACTICE_CATALOG } from "../domain/practice-catalog";
  import type {
    PronunciationCard,
    PronunciationSessionSummary,
    PronunciationSessionView,
  } from "../domain/types";
  import { isPronunciationAudioCached } from "./audio-cache";
  import { ApiError, postJson } from "./api";
  import { OfflineLearningStore, type BrowserOfflineState } from "./offline-store";
  import {
    getSoundEnabled,
    playAnswerFeedback,
    playPronunciationAudio,
    prepareSound,
  } from "./sound";
  import { synchronizeLearning } from "./sync";
  import { learnerError, pronunciationFocusLabel } from "./ui-copy";
  import { hasCompletedLocalResult, localPronunciationSummary } from "./local-session-summary";
  import { cachePracticeSummary } from "./practice-history-cache";
  import PracticeResult from "./PracticeResult.svelte";

  type Phase =
    "loading" | "choose" | "prompt" | "revealed" | "advancing" | "empty" | "completed" | "error";
  const focuses: Array<{ id: PronunciationFocus; label: string; hint: string }> = [
    {
      id: "mixed",
      label: pronunciationFocusLabel("mixed"),
      hint: "ピンイン・声調・聞き取り・発話",
    },
    { id: "pinyin", label: pronunciationFocusLabel("pinyin"), hint: "正確な読みを見分ける" },
    { id: "tones", label: pronunciationFocusLabel("tones"), hint: "単音節と二音節の声調" },
    {
      id: "listening",
      label: pronunciationFocusLabel("listening"),
      hint: "音声から漢字や意味を選ぶ",
    },
    {
      id: "speaking",
      label: pronunciationFocusLabel("speaking"),
      hint: "声に出して比べ、自己評価する",
    },
  ];
  const selfRatings = [
    { value: 1, label: "もう一度", hint: "声調・音節を外した" },
    { value: 2, label: "だいたい", hint: "通じるが不安定" },
    { value: 3, label: "できた", hint: "おおむね一致" },
    { value: 4, label: "明瞭", hint: "自信を持って発音" },
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
  let browserOffline = !navigator.onLine;
  let isOffline = browserOffline;
  let audioAvailableOffline = true;
  let syncMessage = "練習内容を選ぶと、端末用のセットを準備できます。";
  let answerInFlight = false;
  let autoplayedCardKey: string | null = null;
  let completionSummary: PronunciationSessionSummary | null = null;

  onMount(() => void initializePronunciation());

  async function initializePronunciation(): Promise<void> {
    phase = "loading";
    errorMessage = "";
    try {
      store ??= await OfflineLearningStore.open(localStorage);
      browserState = await store.snapshot();
      if (!browserState.activePronunciationSessionId) {
        if (await restoreCompletedResult()) return;
        phase = "choose";
        return;
      }
      if (!browserState.activePronunciationFocus) {
        throw new Error("発音セッションの練習内容がありません。");
      }
      if (!browserOffline) {
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
          isOffline = browserOffline || !(error instanceof ApiError);
          syncMessage = isOffline
            ? "通信できないため、保存済みの発音セットを使います"
            : "サーバーに接続できないため、保存済みの発音セットを使います";
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
      if (browserOffline) throw new Error("再接続すると、新しい発音セットを準備できます。");
      store ??= await OfflineLearningStore.open(localStorage);
      browserState ??= await store.snapshot();
      browserState = await store.setActivePronunciationSession(
        `pronunciation-session:${crypto.randomUUID()}`,
        focus,
      );
      if (!browserState.activePronunciationSessionId || !browserState.activePronunciationFocus) {
        throw new Error("発音セッションを開始できませんでした。");
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
    if (!store) throw new Error("オフライン保存を準備できませんでした。");
    await store.rememberPronunciationSession(result.session);
  }

  async function loadNextCard(showLoading = true): Promise<void> {
    if (!store || !browserState?.activePronunciationSessionId) {
      throw new Error("発音セッションがありません。");
    }
    phase = showLoading ? "loading" : "advancing";
    const sessionId = browserState.activePronunciationSessionId;
    const [record, cachedCard] = await Promise.all([
      store.getPronunciationSessionRecord(sessionId),
      store.getCachedPronunciationCard(sessionId),
    ]);
    if (!record) {
      throw new Error(
        isOffline
          ? "接続が切れる前に、この発音セットを保存できませんでした。"
          : "発音セットをまだ取得できていません。",
      );
    }
    const cachedSession = record.session;
    session = cachedSession;
    card = cachedCard;
    answerSaved = false;
    wasCorrect = null;
    audioError = "";
    if (cachedCard) {
      audioAvailableOffline = await isPronunciationAudioCached(cachedCard);
      promptStartedAt = performance.now();
      phase = "prompt";
      if (shouldAutoplayOnPrompt(cachedCard.activityType)) void autoplayCardAudio();
      return;
    }
    if (cachedSession.endedAt !== null) {
      browserState = await store.clearActivePronunciationSession(sessionId);
    }
    phase = session.completedItems === 0 ? "empty" : "completed";
    if (phase === "completed") {
      completionSummary = localPronunciationSummary(cachedSession, record.attempts);
      cachePracticeSummary(completionSummary);
      browserState = await store.presentPracticeResult("pronunciation", sessionId);
    }
  }

  async function restoreCompletedResult(): Promise<boolean> {
    if (!store || browserState?.presentedResult?.mode !== "pronunciation") return false;
    const sessionId = browserState.presentedResult.sessionId;
    if (browserState.dismissedResultSessionIds.includes(sessionId)) return false;
    const record = await store.getPronunciationSessionRecord(sessionId);
    if (!record || !hasCompletedLocalResult(record.session)) return false;
    session = record.session;
    card = null;
    completionSummary = localPronunciationSummary(record.session, record.attempts);
    cachePracticeSummary(completionSummary);
    phase = "completed";
    return true;
  }

  async function leaveCompletedResult(): Promise<void> {
    if (browserState?.activePronunciationSessionId) {
      await initializePronunciation();
      return;
    }
    if (store && session) {
      browserState = await store.dismissPracticeResult("pronunciation", session.id);
    }
    phase = "choose";
  }

  function revealRecall(): void {
    if (phase !== "prompt" || !card) return;
    prepareSound();
    phase = "revealed";
    if (card.media && !shouldAutoplayOnPrompt(card.activityType)) void autoplayCardAudio();
  }

  async function selectChoice(choiceId: string): Promise<void> {
    if (phase !== "prompt" || !card?.answerChoiceId || answerInFlight) return;
    const correct = choiceId === card.answerChoiceId;
    prepareSound();
    playAnswerFeedback(correct ? "correct" : "incorrect");
    await saveAttempt({
      correct,
      metadata: { interaction: "choice", selectedChoiceId: choiceId, readingId: card.readingId },
    });
    wasCorrect = correct;
    if (card.media && !shouldAutoplayOnPrompt(card.activityType)) void autoplayCardAudio();
  }

  async function saveRecall(correct: boolean): Promise<void> {
    if (
      phase !== "revealed" ||
      answerSaved ||
      answerInFlight ||
      card?.activityType !== "hanzi_to_pinyin"
    )
      return;
    await saveAttempt({
      correct,
      metadata: { interaction: "reveal-and-self-check", readingId: card.readingId },
    });
    wasCorrect = correct;
  }

  async function saveProduction(selfRating: number): Promise<void> {
    if (
      phase !== "revealed" ||
      answerSaved ||
      answerInFlight ||
      card?.activityType !== "pronunciation_production"
    )
      return;
    await saveAttempt({
      selfRating,
      metadata: { interaction: "speak-compare-self-rate", readingId: card.readingId },
    });
  }

  async function saveAttempt(
    result: {
      correct?: boolean;
      selfRating?: number;
      metadata: Record<string, unknown>;
    },
    continueImmediately = false,
  ): Promise<void> {
    if (!card || !browserState?.activePronunciationSessionId || answerInFlight) return;
    answerInFlight = true;
    try {
      if (!store) throw new Error("オフライン保存を準備できませんでした。");
      const sessionId = browserState.activePronunciationSessionId;
      const staged = await store.stageAttemptFromCurrentState({
        cardId: card.cardId,
        studySessionId: sessionId,
        mode: "pronunciation",
        activityType: card.activityType,
        correct: result.correct,
        selfRating: result.selfRating,
        responseMs: Math.max(0, Math.round(performance.now() - promptStartedAt)),
        metadata: {
          ...result.metadata,
          itemLabel: card.lexeme.simplified,
          itemDetail: card.reading.pinyin,
        },
      });
      browserState = staged.state;
      answerSaved = true;
      syncInBackground();
      if (continueImmediately) {
        await loadNextCard(false);
        return;
      }
      phase = "revealed";
    } catch (error) {
      showError(error);
    } finally {
      answerInFlight = false;
    }
  }

  async function syncNow(): Promise<void> {
    if (!store || browserOffline) return;
    const result = await synchronizeLearning(store);
    browserState = result.state;
    isOffline = browserOffline || result.networkUnavailable;
    if (result.error) {
      syncMessage = `${result.pending}件を同期待ちにしています`;
      return;
    }
    syncMessage =
      result.audioCacheFailures.length === 0
        ? "この端末に保存済み · 同期済み"
        : `音声${result.audioCacheFailures.length}件を保存できませんでした`;
  }

  function syncInBackground(): void {
    if (browserOffline) return;
    void syncNow().catch(() => {
      isOffline = true;
      syncMessage = `${browserState?.pendingCount ?? 0}件を同期待ちにしています`;
    });
  }

  async function skipUncachedAudio(): Promise<void> {
    if (
      phase !== "prompt" ||
      !card?.activityType.startsWith("audio_to_") ||
      !browserState?.activePronunciationSessionId
    )
      return;
    await saveAttempt(
      {
        metadata: {
          interaction: PRONUNCIATION_AUDIO_SKIP_INTERACTION,
          reason: PRONUNCIATION_AUDIO_SKIP_REASON,
          readingId: card.readingId,
        },
      },
      true,
    );
  }

  async function handleOnline(): Promise<void> {
    browserOffline = false;
    isOffline = false;
    syncMessage = "接続を確認しています…";
    try {
      if (!store) return await initializePronunciation();
      await syncNow();
      if (card) audioAvailableOffline = await isPronunciationAudioCached(card);
      if (phase !== "revealed" && phase !== "prompt" && phase !== "advancing") {
        await loadNextCard();
      }
    } catch (error) {
      showError(error);
    }
  }

  function handleOffline(): void {
    browserOffline = true;
    isOffline = true;
    syncMessage = `${browserState?.pendingCount ?? 0}件を端末に保存 · オフライン`;
  }

  async function playAudio(): Promise<void> {
    audioError = "";
    if (!getSoundEnabled()) return;
    if (!card?.media) {
      audioError = "この正確な読みには、信頼できる音声がありません。";
      return;
    }
    if (isOffline && !audioAvailableOffline) {
      audioError = "接続が切れる前に音声を保存できませんでした。スキップして続けられます。";
      return;
    }
    if (!(await playPronunciationAudio(card.media.url))) {
      audioError = "音声を再生できませんでした。聞き直すか、保存状態を確認してください。";
    }
  }

  async function autoplayCardAudio(): Promise<void> {
    if (!card?.media || !getSoundEnabled()) return;
    const cardKey = `${session?.id ?? browserState?.activePronunciationSessionId ?? "pronunciation"}:${card.cardId}`;
    if (autoplayedCardKey === cardKey || readAutoplayMarker() === cardKey) return;
    autoplayedCardKey = cardKey;
    writeAutoplayMarker(cardKey);
    await playAudio();
  }

  function readAutoplayMarker(): string | null {
    try {
      return sessionStorage.getItem("chinese-learning.pronunciation-autoplay.v1");
    } catch {
      return null;
    }
  }

  function writeAutoplayMarker(value: string): void {
    try {
      sessionStorage.setItem("chinese-learning.pronunciation-autoplay.v1", value);
    } catch {
      // Autoplay deduplication is best effort; the drill remains usable.
    }
  }

  function shouldAutoplayOnPrompt(activity: PronunciationCard["activityType"]): boolean {
    return activity !== "hanzi_to_pinyin" && activity !== "pronunciation_production";
  }

  function activityLabel(value: PronunciationCard): string {
    switch (value.activityType) {
      case "hanzi_to_pinyin":
        return "漢字 → ピンイン";
      case "pinyin_to_hanzi":
        return "ピンイン → 漢字";
      case "audio_to_hanzi":
        return "音声 → 漢字";
      case "audio_to_meaning":
        return "音声 → 意味";
      case "tone_identification":
        return "声調を聞き分ける";
      case "tone_pair_identification":
        return "声調の組み合わせ";
      case "pronunciation_production":
        return "発音して確認";
    }
  }

  function promptInstruction(value: PronunciationCard): string {
    switch (value.activityType) {
      case "hanzi_to_pinyin":
        return "声調を含む正確なピンインを思い出す";
      case "pinyin_to_hanzi":
        return "この読みと意味に合う漢字を選ぶ";
      case "audio_to_hanzi":
        return "必要なら聞き直して、漢字を選ぶ";
      case "audio_to_meaning":
        return "必要なら聞き直して、正しい意味を選ぶ";
      case "tone_identification":
        return "辞書の声調を選ぶ";
      case "tone_pair_identification":
        return "辞書の声調の組み合わせを選ぶ";
      case "pronunciation_production":
        return "声に出してから、答えと比べる";
    }
  }

  function showError(error: unknown): void {
    errorMessage = learnerError(error, "問題が発生しました。");
    phase = "error";
  }
</script>

<svelte:window ononline={() => void handleOnline()} onoffline={handleOffline} />

<header class="app-header surface-header">
  <div class="surface-title">
    <span class="section-mark">03</span>
    <h2>発音</h2>
  </div>
  {#if session && (phase === "prompt" || phase === "revealed" || phase === "advancing")}
    <p
      class="progress"
      aria-label={`発音 ${Math.min(session.completedItems + (answerSaved ? 0 : 1), session.maxItems)} / ${session.maxItems}`}
    >
      <strong>{Math.min(session.completedItems + (answerSaved ? 0 : 1), session.maxItems)}</strong
      ><span>/ {session.maxItems}</span>
    </p>
  {/if}
</header>

<p class:offline={isOffline} class="sync-status" aria-live="polite">
  {isOffline ? `${browserState?.pendingCount ?? 0}件を端末に保存 · オフライン` : syncMessage}
</p>

{#if phase === "loading"}
  <section class="status-panel" aria-live="polite">
    <div class="pulse pronunciation-pulse" aria-hidden="true"></div>
    <h2>発音練習を準備しています…</h2>
    <p>一つの正確な読みを使って出題します。</p>
  </section>
{:else if phase === "choose"}
  <section class="mode-picker">
    <div class="mode-picker-heading">
      <h2>発音の練習内容を選ぶ</h2>
      <p>{PRACTICE_CATALOG.pronunciation.setupDescription}</p>
    </div>
    <div class="focus-grid">
      {#each focuses as focus}
        <button
          class:recommended={focus.id === "mixed"}
          disabled={browserOffline}
          onclick={() => void createNewSession(focus.id)}
        >
          <strong>{focus.label}</strong><span>{focus.hint}</span>
        </button>
      {/each}
    </div>
  </section>
{:else if phase === "error"}
  <section class="status-panel error-panel" role="alert">
    <p class="status-kicker">練習を一時停止しました</p>
    <h2>記録は失われていません</h2>
    <p>{errorMessage}</p>
    <button class="primary-button" onclick={() => void initializePronunciation()}
      >もう一度試す</button
    >
  </section>
{:else if phase === "empty"}
  <section class="status-panel">
    <p class="completion-mark" aria-hidden="true">—</p>
    <h2>該当する練習がありません</h2>
    <p>別の内容を選ぶか、単語が準備されるまで待ってください。</p>
    <button class="primary-button" onclick={() => (phase = "choose")}>別の内容を選ぶ</button>
  </section>
{:else if phase === "completed" && completionSummary}
  <section class="status-panel shared-result-panel">
    <PracticeResult summary={completionSummary} />
    <button class="primary-button" onclick={() => void leaveCompletedResult()}>
      {browserState?.activePronunciationSessionId ? "同期を再試行" : "別の内容を練習する"}
    </button>
    <a class="text-link" href="#progress">記録で詳しく見る</a>
  </section>
{:else if card}
  <section
    class:advancing={phase === "advancing"}
    class="study-card pronunciation-card"
    data-phase={phase}
    aria-live="polite"
    aria-busy={phase === "advancing"}
  >
    <div class="card-meta">
      <span class="queue-badge sound-badge">発音</span><span>{activityLabel(card)}</span>
      {#if card.lexeme.hskLevel}<span>HSK {card.lexeme.hskLevel}</span>{/if}
    </div>
    <div class="prompt-block pronunciation-prompt">
      <p class="prompt-instruction">{promptInstruction(card)}</p>
      {#if card.activityType.startsWith("audio_to_")}
        <button
          class="audio-button"
          disabled={isOffline && !audioAvailableOffline}
          onclick={() => void playAudio()}
          aria-label="単語の音声を再生・聞き直す"
          ><svg aria-hidden="true" viewBox="0 0 20 20"
            ><path d="M3.5 8.1h3l3.3-2.8v9.4l-3.3-2.8h-3z" /><path
              d="M13 7a4.2 4.2 0 0 1 0 6M15.2 4.8a7.3 7.3 0 0 1 0 10.4"
            /></svg
          ><strong>再生 / 聞き直す</strong></button
        >
        {#if isOffline && !audioAvailableOffline}
          <p class="audio-error" role="status">
            接続が切れる前に音声を保存できませんでした。他の発音カードは続けて使えます。
          </p>
          <button class="audio-replay-small" onclick={() => void skipUncachedAudio()}
            >音声をスキップ</button
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
            ? "発音した — 答えと比べる"
            : "ピンインを見る"}</span
        ></button
      >
    {:else if phase === "advancing"}
      <div class="advancing-note" role="status">次のカードを準備しています…</div>
    {:else}
      <div class="pronunciation-answer">
        {#if wasCorrect !== null}<p class:correct={wasCorrect} class="feedback">
            {wasCorrect ? "正解" : "今回は不正解"}
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
            ><svg aria-hidden="true" viewBox="0 0 20 20"
              ><path d="M3.5 8.1h3l3.3-2.8v9.4l-3.3-2.8h-3z" /><path
                d="M13 7a4.2 4.2 0 0 1 0 6M15.2 4.8a7.3 7.3 0 0 1 0 10.4"
              /></svg
            > 正確な読みを聞き直す</button
          >
          <p class="media-credit">{card.media.attribution} · {card.media.license}</p>
        {:else if card.activityType === "pronunciation_production"}<p class="safe-degrade">
            この正確な読みに信頼できる録音がないため、ピンインと声調だけで確認します。
          </p>{/if}
      </div>
      {#if !answerSaved && card.activityType === "hanzi_to_pinyin"}
        <div class="binary-grid">
          <button class="missed" onclick={() => void saveRecall(false)}>思い出せなかった</button
          ><button class="got-it" onclick={() => void saveRecall(true)}>思い出せた</button>
        </div>
      {:else if !answerSaved && card.activityType === "pronunciation_production"}
        <div class="production-ratings">
          {#each selfRatings as rating}<button onclick={() => void saveProduction(rating.value)}
              ><strong>{rating.label}</strong><span>{rating.hint}</span></button
            >{/each}
        </div>
      {:else if answerSaved}
        <button class="primary-button continue-button" onclick={() => void loadNextCard(false)}
          >次へ</button
        >
      {/if}
    {/if}
  </section>
{/if}

<details class="sound-reference">
  <summary>ピンインと声調の早見表</summary>
  <div class="reference-content">
    <div>
      <h3>声調</h3>
      <p>
        <b>1</b> 高く平ら · <b>2</b> 上がる · <b>3</b> 低く曲がる · <b>4</b> 下がる · <b>5</b> 軽声
      </p>
      <p>
        組み合わせカードは辞書上の声調を示します。自然な発話では、特に3声+3声や一・不の
        声調が変化することがあります。
      </p>
    </div>
    <div>
      <h3>声母</h3>
      <p>
        <b>j q x</b> は舌を前上方へ、<b>zh ch sh r</b> は舌を反らせ、<b>z c s</b> は前方で発音します。
        無気音・有気音の組み合わせは b/p、d/t、g/k、j/q、zh/ch、z/c です。
      </p>
    </div>
    <div>
      <h3>韻母とつづり</h3>
      <p>
        j/q/x/y の後の <b>ü</b> は <b>u</b> と書きます。ian と iang、en と eng、in と ing を区別します。
        声調記号は母音の中心に置き、数字表記では軽声を5とします。
      </p>
    </div>
  </div>
</details>
