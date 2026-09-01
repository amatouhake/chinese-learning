<script lang="ts">
  import { onMount } from "svelte";

  import {
    REFLEX_INTERACTION,
    REFLEX_SLOW_RESPONSE_MS,
    presentReflexQuestion,
    selectNextReflexCard,
    type PresentedReflexQuestion,
  } from "../domain/reflex";
  import { PRACTICE_CATALOG } from "../domain/practice-catalog";
  import type {
    QuizActivity,
    QuizChoiceCount,
    ReflexAnswerRecord,
    ReflexCard,
    ReflexSessionView,
    VocabularyQuizSessionSummary,
  } from "../domain/types";
  import { ApiError, postJson } from "./api";
  import { OfflineLearningStore, type BrowserOfflineState } from "./offline-store";
  import {
    getSoundEnabled,
    playAnswerFeedback,
    playPronunciationAudio,
    prepareSound,
  } from "./sound";
  import { synchronizeLearning } from "./sync";
  import { learnerError } from "./ui-copy";
  import { localQuizSummary } from "./local-session-summary";
  import { cachePracticeSummary } from "./practice-history-cache";
  import PracticeResult from "./PracticeResult.svelte";
  import {
    readQuizPreferences,
    writeQuizPreferences,
    type QuizPreferences,
    type QuizSessionSize,
  } from "./quiz-preferences";

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
  let selectedResponseMs: number | null = null;
  let timingInterrupted = false;
  let answerStored = false;
  let errorMessage = "";
  let syncMessage = "オンラインで一度準備すると、短い単語クイズを保存できます。";
  let browserOffline = !navigator.onLine;
  let isOffline = browserOffline;
  let advanceTimer: ReturnType<typeof setTimeout> | null = null;
  let audioMessage = "";
  let autoplayedQuestionKey: string | null = null;
  let preferences: QuizPreferences = readQuizPreferences();
  let completionSummary: VocabularyQuizSessionSummary | null = null;

  const activityOptions: Array<{ value: QuizActivity; label: string; hint: string }> = [
    { value: "mixed", label: "混合", hint: "4方向を組み合わせる" },
    { value: "hanzi_to_meaning", label: "漢字 → 意味", hint: "意味を見分ける" },
    { value: "meaning_to_hanzi", label: "意味 → 漢字", hint: "漢字を選ぶ" },
    { value: "hanzi_to_pinyin", label: "漢字 → ピンイン", hint: "読みを見分ける" },
    { value: "pinyin_to_hanzi", label: "ピンイン → 漢字", hint: "漢字を選ぶ" },
  ];
  const choiceOptions: Array<{ value: QuizChoiceCount; label: string; hint: string }> = [
    { value: 4, label: "4択", hint: "テンポよく繰り返す" },
    { value: 9, label: "9択", hint: "多い候補から見分ける" },
  ];
  const sizeOptions: QuizSessionSize[] = [8, 12, 20];

  onMount(() => {
    void initializeReflex();
    const online = () => {
      browserOffline = false;
      if (store) {
        const hadActiveQuestion =
          question !== null &&
          (phase === "prompt" || phase === "feedback" || String(phase) === "advancing");
        void syncNow()
          .then(() => {
            // A timer or manual Next action may have advanced while sync was
            // in flight. Reconnect must not load a second question.
            if (hadActiveQuestion || shouldHoldOnlineAdvance()) return;
            return loadNextQuestion();
          })
          .catch(showError);
      }
    };
    const offline = () => {
      browserOffline = true;
      isOffline = true;
      syncMessage = "オフライン · 回答はこの端末に保存されます";
    };
    addEventListener("online", online);
    addEventListener("offline", offline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      removeEventListener("online", online);
      removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
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
        if (await restoreCompletedResult()) return;
        phase = "choose";
        return;
      }
      if (!browserOffline) {
        try {
          const cached = await store.getReflexSession(browserState.activeReflexSessionId);
          await ensureSession(
            browserState.activeReflexSessionId,
            browserState.deviceId,
            cached?.session ?? preferences,
          );
          await syncNow();
        } catch (error) {
          if (!(await store.getReflexSession(browserState.activeReflexSessionId))) throw error;
          isOffline = browserOffline || !(error instanceof ApiError);
          syncMessage = "通信できないため、準備済みの単語クイズを使います";
        }
      }
      await loadNextQuestion();
    } catch (error) {
      showError(error);
    }
  }

  async function createNewSession(selected: QuizPreferences = preferences): Promise<void> {
    phase = "loading";
    errorMessage = "";
    try {
      if (browserOffline) throw new Error("再接続すると、新しい単語クイズを準備できます。");
      store ??= await OfflineLearningStore.open(localStorage);
      browserState ??= await store.snapshot();
      preferences = selected;
      writeQuizPreferences(preferences);
      browserState = await store.setActiveReflexSession(`reflex-session:${crypto.randomUUID()}`);
      if (!browserState.activeReflexSessionId)
        throw new Error("単語クイズを開始できませんでした。");
      await ensureSession(browserState.activeReflexSessionId, browserState.deviceId, selected);
      await syncNow();
      await loadNextQuestion();
    } catch (error) {
      showError(error);
    }
  }

  async function ensureSession(
    sessionId: string,
    deviceId: string,
    selected:
      Pick<ReflexSessionView, "activityType" | "choiceCount" | "maxItems"> | QuizPreferences,
  ): Promise<void> {
    const maxItems = "maxItems" in selected ? selected.maxItems : selected.size;
    const result = await postJson<{ session: ReflexSessionView }>("/api/reflex/sessions", {
      sessionId,
      deviceId,
      maxItems,
      activityType: selected.activityType,
      choiceCount: selected.choiceCount,
    });
    if (!store) throw new Error("オフライン保存を準備できませんでした。");
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
          ? "接続が切れる前に、この単語クイズを保存できませんでした。"
          : "単語クイズをまだ取得できていません。",
      );
    }
    session = cached.session;
    answers = cached.answers;
    cards = cachedCards;
    selectedChoiceId = null;
    selectedResponseMs = null;
    timingInterrupted = document.hidden;
    answerStored = false;
    audioMessage = "";
    if (session.completedItems >= session.maxItems || session.endedAt !== null) {
      question = null;
      if (session.endedAt !== null) {
        browserState = await store.clearActiveReflexSession(sessionId);
      }
      phase = session.completedItems === 0 ? "empty" : "completed";
      if (phase === "completed") {
        completionSummary = localQuizSummary(session, answers, cards);
        cachePracticeSummary(completionSummary);
        browserState = await store.presentPracticeResult("reflex", sessionId);
      }
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
    if (shouldAutoplayOnPrompt(question.card.activityType)) {
      void autoplayQuestionAudio();
    }
  }

  async function choose(choiceId: string): Promise<void> {
    if (phase !== "prompt" || !question || !store || !browserState?.activeReflexSessionId) return;
    const currentSession = session;
    if (!currentSession) return;
    if (advanceTimer) clearTimeout(advanceTimer);
    selectedChoiceId = choiceId;
    selectedResponseMs = timingInterrupted
      ? null
      : Math.max(0, Math.round(performance.now() - promptStartedAt));
    const correct = choiceId === question.card.answerChoiceId;
    answerStored = false;
    prepareSound();
    playAnswerFeedback(correct ? "correct" : "incorrect");
    phase = "feedback";
    if (!shouldAutoplayOnPrompt(question.card.activityType)) {
      void autoplayQuestionAudio();
    }
    try {
      const sessionId = browserState.activeReflexSessionId;
      const staged = await store.stageAttemptFromCurrentState({
        cardId: question.card.cardId,
        studySessionId: sessionId,
        mode: "reflex",
        activityType: question.card.activityType,
        correct,
        ...(selectedResponseMs === null ? {} : { responseMs: selectedResponseMs }),
        metadata: {
          interaction: REFLEX_INTERACTION,
          presentationId: question.presentationId,
          round: question.round,
          prompt: question.card.prompt,
          promptHint: question.card.promptHint,
          answerChoiceId: question.card.answerChoiceId,
          selectedChoiceId: choiceId,
          choiceCount: currentSession.choiceCount,
          timingInterrupted,
          options: question.choices.map((choice, index) => ({ ...choice, position: index + 1 })),
        },
      });
      browserState = staged.state;
      answerStored = true;
      syncInBackground();
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
    isOffline = browserOffline || result.networkUnavailable;
    if (result.error) {
      syncMessage = `${result.pending}件を同期待ちにしています`;
    } else {
      syncMessage =
        result.pending === 0 ? "この端末に保存済み · 同期済み" : `${result.pending}件を同期待ち`;
    }
  }

  function syncInBackground(): void {
    if (browserOffline) return;
    void syncNow().catch(() => {
      isOffline = true;
      syncMessage = `${browserState?.pendingCount ?? 0}件を同期待ちにしています`;
    });
  }

  function showError(error: unknown): void {
    if (advanceTimer) clearTimeout(advanceTimer);
    errorMessage = learnerError(error, "単語クイズを続けられませんでした。");
    phase = "error";
  }

  function handleVisibilityChange(): void {
    if (document.hidden && phase === "prompt") timingInterrupted = true;
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
      hanzi_to_meaning: "漢字 → 意味",
      meaning_to_hanzi: "意味 → 漢字",
      hanzi_to_pinyin: "漢字 → ピンイン",
      pinyin_to_hanzi: "ピンイン → 漢字",
    }[activity];
  }

  function answerLabel(): string {
    return question?.choices.find(({ id }) => id === question?.card.answerChoiceId)?.label ?? "";
  }

  async function playCardAudio(): Promise<void> {
    if (!question?.card.media || !getSoundEnabled()) return;
    const played = await playPronunciationAudio(question.card.media.url);
    if (!played) {
      audioMessage = isOffline
        ? "発音音声は端末に保存されていません。"
        : "音声を再生できませんでした。";
    }
  }

  async function autoplayQuestionAudio(): Promise<void> {
    if (!question?.card.media || !getSoundEnabled()) return;
    const questionKey = `${session?.id ?? browserState?.activeReflexSessionId ?? "reflex"}:${question.presentationId}`;
    if (autoplayedQuestionKey === questionKey || readAutoplayMarker() === questionKey) return;
    autoplayedQuestionKey = questionKey;
    writeAutoplayMarker(questionKey);
    await playCardAudio();
  }

  function readAutoplayMarker(): string | null {
    try {
      return sessionStorage.getItem("chinese-learning.reflex-autoplay.v1");
    } catch {
      return null;
    }
  }

  function writeAutoplayMarker(value: string): void {
    try {
      sessionStorage.setItem("chinese-learning.reflex-autoplay.v1", value);
    } catch {
      // Autoplay deduplication is best effort; the drill remains usable.
    }
  }

  function shouldAutoplayOnPrompt(activity: ReflexCard["activityType"]): boolean {
    return activity === "hanzi_to_meaning" || activity === "pinyin_to_hanzi";
  }

  function shouldHoldOnlineAdvance(): boolean {
    return phase === "prompt" || phase === "feedback" || String(phase) === "advancing";
  }

  function updatePreferences(next: Partial<QuizPreferences>): void {
    preferences = { ...preferences, ...next };
    writeQuizPreferences(preferences);
  }

  async function returnToSettings(): Promise<void> {
    if (store && session) {
      browserState = await store.dismissPracticeResult("reflex", session.id);
    }
    phase = "choose";
  }

  async function restoreCompletedResult(): Promise<boolean> {
    if (!store || browserState?.presentedResult?.mode !== "reflex") return false;
    const sessionId = browserState.presentedResult.sessionId;
    if (browserState.dismissedResultSessionIds.includes(sessionId)) return false;
    const [cached, cachedCards] = await Promise.all([
      store.getReflexSession(sessionId),
      store.getCachedReflexCards(sessionId),
    ]);
    if (!cached || cached.answers.length === 0) return false;
    session = cached.session;
    answers = cached.answers;
    cards = cachedCards;
    question = null;
    completionSummary = localQuizSummary(session, answers, cards);
    cachePracticeSummary(completionSummary);
    phase = "completed";
    return true;
  }

  function restartCompletedSession(): void {
    if (!session) return;
    const completed = session;
    void createNewSession({
      activityType: completed.activityType,
      choiceCount: completed.choiceCount,
      size: completed.maxItems === 8 || completed.maxItems === 20 ? completed.maxItems : 12,
    });
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<section class="learning-surface reflex-surface">
  <nav class="vocabulary-practice-nav" aria-label="単語練習">
    <a href="#study">復習</a><a class="active" href="#reflex" aria-current="page">クイズ</a>
  </nav>
  <div class="surface-heading">
    <div class="surface-title">
      <span class="section-mark">単語</span>
      <h2>クイズ</h2>
    </div>
    <p class="sync-status" class:offline={isOffline}>{syncMessage}</p>
  </div>

  {#if phase === "loading"}
    <div class="empty-state"><p>単語クイズを準備しています…</p></div>
  {:else if phase === "choose"}
    <div class="mode-picker quiz-launcher">
      <div class="mode-picker-heading">
        <h2>単語を素早く見分ける</h2>
        <p>{PRACTICE_CATALOG.vocabulary_quiz.setupDescription}</p>
      </div>
      <fieldset class="study-choice-group">
        <legend>出題方向</legend>
        <div class="study-option-grid quiz-activity-options">
          {#each activityOptions as option}
            <button
              type="button"
              class:selected={preferences.activityType === option.value}
              aria-pressed={preferences.activityType === option.value}
              onclick={() => updatePreferences({ activityType: option.value })}
              ><strong>{option.label}</strong><span>{option.hint}</span></button
            >
          {/each}
        </div>
      </fieldset>
      <fieldset class="study-choice-group">
        <legend>選択肢</legend>
        <div class="study-option-grid choice-count-options">
          {#each choiceOptions as option}
            <button
              type="button"
              class:selected={preferences.choiceCount === option.value}
              aria-pressed={preferences.choiceCount === option.value}
              onclick={() => updatePreferences({ choiceCount: option.value })}
              ><strong>{option.label}</strong><span>{option.hint}</span></button
            >
          {/each}
        </div>
        <p class="setting-note">
          9択も選択問題です。答えを自由に思い出す練習は「復習」で行います。
        </p>
      </fieldset>
      <fieldset class="study-choice-group">
        <legend>問題数</legend>
        <div class="study-option-grid size-options">
          {#each sizeOptions as size}
            <button
              type="button"
              class:selected={preferences.size === size}
              aria-pressed={preferences.size === size}
              onclick={() => updatePreferences({ size })}
              ><strong>{size}問</strong><span
                >{size === 8 ? "短く" : size === 12 ? "標準" : "しっかり"}</span
              ></button
            >
          {/each}
        </div>
      </fieldset>
      <button class="primary-button" onclick={() => void createNewSession()}
        >この設定で始める</button
      >
      <p class="boundary-note">回答中はキーボードの1〜9、または選択肢をタップできます。</p>
    </div>
  {:else if (phase === "prompt" || phase === "feedback") && question && session}
    <article
      class="study-card reflex-card"
      data-card-id={question.card.cardId}
      data-activity={question.card.activityType}
      data-choice-count={session.choiceCount}
    >
      <div class="card-meta">
        <span>{session.completedItems + 1} / {session.maxItems}</span>
        <span>{activityLabel(question.card.activityType)}</span>
      </div>
      <div class="reflex-prompt">
        <div class="prompt-line">
          <h3>{question.card.prompt}</h3>
          {#if question.card.media}
            <button
              class="word-audio reflex-audio"
              aria-label="発音を聞き直す"
              onclick={() => void playCardAudio()}
            >
              <svg aria-hidden="true" viewBox="0 0 20 20"
                ><path d="M3.5 8.1h3l3.3-2.8v9.4l-3.3-2.8h-3z" /><path
                  d="M13 7a4.2 4.2 0 0 1 0 6M15.2 4.8a7.3 7.3 0 0 1 0 10.4"
                /></svg
              >
              <span>聞き直す</span>
            </button>
          {/if}
        </div>
        {#if question.card.promptHint}<p>{question.card.promptHint}</p>{/if}
      </div>
      <div class:nine-choices={session.choiceCount === 9} class="choice-grid reflex-choice-grid">
        {#each question.choices as choice, index}
          <button
            class:correct={phase === "feedback" && choice.id === question.card.answerChoiceId}
            class:incorrect={phase === "feedback" &&
              choice.id === selectedChoiceId &&
              choice.id !== question.card.answerChoiceId}
            class:selected={phase === "feedback" && choice.id === selectedChoiceId}
            class:dimmed={phase === "feedback" &&
              choice.id !== selectedChoiceId &&
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
      <div
        class:visible={phase === "feedback"}
        class="reflex-feedback"
        aria-live="polite"
        aria-hidden={phase !== "feedback"}
      >
        <strong
          class:wrong={phase === "feedback" && selectedChoiceId !== question.card.answerChoiceId}
          >{phase === "feedback"
            ? selectedChoiceId === question.card.answerChoiceId
              ? "正解"
              : `正解: ${answerLabel()}`
            : "結果"}</strong
        >
        <span
          class:slow={phase === "feedback" &&
            selectedResponseMs !== null &&
            selectedResponseMs >= REFLEX_SLOW_RESPONSE_MS}
          >{phase === "feedback"
            ? selectedResponseMs === null
              ? "計測対象外"
              : `${selectedResponseMs} ms`
            : "—"}</span
        >
        <button
          class="secondary-button"
          disabled={phase !== "feedback" || !answerStored}
          onclick={continueNow}>次へ</button
        >
      </div>
      <p class="audio-note" class:visible={Boolean(audioMessage)} aria-live="polite">
        {audioMessage}
      </p>
    </article>
  {:else if phase === "empty"}
    <div class="empty-state">
      <h3>まだクイズに使える単語がありません</h3>
      <p>単語をいくつか練習してから、オンラインで新しい練習を準備してください。</p>
      <button class="primary-button" onclick={() => void createNewSession()}>もう一度確認</button>
    </div>
  {:else if phase === "completed" && session && completionSummary}
    <div class="empty-state session-summary shared-result-panel">
      <PracticeResult summary={completionSummary} />
      {#if !browserState?.activeReflexSessionId}
        <div class="result-actions">
          <button class="primary-button" onclick={restartCompletedSession}
            >同じ設定でもう一度</button
          >
          <button class="secondary-button" onclick={() => void returnToSettings()}
            >設定を変える</button
          >
          <a class="text-link" href="#progress">記録で詳しく見る</a>
        </div>
      {:else}
        <p class="boundary-note">現在の記録を同期してから、次の練習を始められます。</p>
      {/if}
    </div>
  {:else if phase === "error"}
    <div class="empty-state" role="alert">
      <h3>単語クイズを一時停止しました</h3>
      <p>{errorMessage}</p>
      <button class="primary-button" onclick={initializeReflex}>もう一度試す</button>
    </div>
  {/if}
</section>
