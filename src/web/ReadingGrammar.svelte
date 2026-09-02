<script lang="ts">
  import { onMount, tick } from "svelte";

  import { PRACTICE_CATALOG } from "../domain/practice-catalog";
  import type {
    GrammarCard,
    GrammarSessionSummary,
    GuidedSessionView,
    ReadingCard,
    ReadingSessionSummary,
  } from "../domain/types";
  import { ApiError, postJson } from "./api";
  import { OfflineLearningStore, type BrowserOfflineState } from "./offline-store";
  import { synchronizeLearning } from "./sync";
  import { learnerError } from "./ui-copy";
  import { hasCompletedLocalResult, localGuidedSummary } from "./local-session-summary";
  import { cachePracticeSummary } from "./practice-history-cache";
  import PracticeResult from "./PracticeResult.svelte";

  type SurfaceMode = "reading" | "grammar";
  type ReadingPhase = "loading" | "prompt" | "advancing" | "empty" | "completed" | "error";
  type GrammarPhase =
    | "loading"
    | "introduction"
    | "practice"
    | "feedback"
    | "advancing"
    | "empty"
    | "completed"
    | "error";

  const confidenceRatings = [
    { value: 1, label: "忘れた", hint: "もう一度説明を見る" },
    { value: 2, label: "手がかりあり", hint: "ヒントで進めた" },
    { value: 3, label: "だいたい", hint: "構造が見えてきた" },
    { value: 4, label: "理解した", hint: "パターンを説明できる" },
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
  let syncMessage = "5問の例文セットを準備しています…";
  let completionSummary: ReadingSessionSummary | GrammarSessionSummary | null = null;

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
    await initializeMode(requestedGrammarTopicId, false);
  }

  async function initializeMode(
    requestedGrammarTopicId: string | null = null,
    restorePresentedMode = true,
  ): Promise<void> {
    setLoading();
    try {
      store ??= await OfflineLearningStore.open(localStorage);
      browserState = await store.snapshot();
      const presentedMode = browserState.presentedResult?.mode;
      if (restorePresentedMode && (presentedMode === "reading" || presentedMode === "grammar")) {
        mode = presentedMode;
      }
      if (
        mode === "grammar" &&
        requestedGrammarTopicId &&
        browserState.activeGrammarSessionId &&
        browserState.activeGrammarTopicId !== requestedGrammarTopicId
      ) {
        if (browserOffline) {
          throw new Error("再接続すると、この文法トピックを開けます。");
        }
        browserState = await store.clearActiveGrammarSession(browserState.activeGrammarSessionId);
      }
      const activeId = activeSessionId();
      if (!activeId) {
        if (await restoreCompletedResult()) return;
        if (browserOffline) {
          throw new Error(
            `再接続すると、新しい${mode === "reading" ? "読解" : "文法"}セットを準備できます。`,
          );
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
            ? `通信できないため、保存済みの${mode === "reading" ? "読解" : "文法"}内容を使います`
            : `サーバーに接続できないため、保存済みの${mode === "reading" ? "読解" : "文法"}内容を使います`;
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
      if (browserOffline) {
        throw new Error(
          `再接続すると、別の${mode === "reading" ? "読解" : "文法"}セットを準備できます。`,
        );
      }
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
      if (!activeId) {
        throw new Error(
          `${mode === "reading" ? "読解" : "文法"}セッションを開始できませんでした。`,
        );
      }
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
    if (!store) throw new Error("オフライン保存を準備できませんでした。");
    await store.rememberGuidedSession(result.session);
  }

  async function loadNextCard(showLoading = true): Promise<void> {
    if (!store) throw new Error("オフライン保存を準備できませんでした。");
    const activeId = activeSessionId();
    if (!activeId) {
      throw new Error(`${mode === "reading" ? "読解" : "文法"}セッションがありません。`);
    }
    setLoading(showLoading);
    if (mode === "reading") {
      const [record, cachedCard] = await Promise.all([
        store.getGuidedSessionRecord("reading", activeId),
        store.getCachedReadingCard(activeId),
      ]);
      if (!record) throw missingCacheError("reading");
      const cachedSession = record.session;
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
      if (readingPhase === "completed") {
        rememberGuidedCompletion(record.session, record.attempts);
        browserState = await store.presentPracticeResult("reading", activeId);
      }
      return;
    }

    const [record, cachedCard] = await Promise.all([
      store.getGuidedSessionRecord("grammar", activeId),
      store.getCachedGrammarCard(activeId),
    ]);
    if (!record) throw missingCacheError("grammar");
    const cachedSession = record.session;
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
    if (grammarPhase === "completed") {
      rememberGuidedCompletion(record.session, record.attempts);
      browserState = await store.presentPracticeResult("grammar", activeId);
    }
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
      readingPhase = "advancing";
      const sessionId = browserState.activeReadingSessionId;
      const staged = await store.stageAttemptFromCurrentState({
        cardId: readingCard.cardId,
        studySessionId: sessionId,
        mode: "reading",
        activityType: "sentence_reading",
        selfRating,
        responseMs: elapsedPromptTime(),
        metadata: {
          interaction: "staged-sentence-reading",
          sentenceId: readingCard.sentenceId,
          revealOrder: ["vocabulary", "pinyin", "meaning", "grammar"],
          grammarTopicIds: readingCard.grammarTopics.map(({ id }) => id),
          grammarTopics: readingCard.grammarTopics.map(({ id, title }) => ({ id, title })),
          itemLabel: readingCard.sentence.chinese,
          itemDetail: readingCard.sentence.pinyin,
        },
      });
      browserState = staged.state;
      syncInBackground();
      await loadNextCard(false);
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
    if (!example) return showError(new Error("この文法トピックに例文がありません。"));
    try {
      grammarPhase = "advancing";
      const sessionId = browserState.activeGrammarSessionId;
      const staged = await store.stageAttemptFromCurrentState({
        cardId: grammarCard.cardId,
        studySessionId: sessionId,
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
          topicTitle: grammarCard.topic.title,
          itemLabel: grammarCard.topic.title,
          itemDetail: completedPracticeSentence(grammarCard),
        },
      });
      browserState = staged.state;
      syncInBackground();
      await loadNextCard(false);
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
      ? `${result.pending}件を同期待ちにしています`
      : result.pending === 0
        ? "この端末に保存済み · 同期済み"
        : `${result.pending}件を同期待ち`;
  }

  function syncInBackground(): void {
    if (browserOffline) return;
    void syncNow().catch(() => {
      isOffline = true;
      syncMessage = `${browserState?.pendingCount ?? 0}件を同期待ちにしています`;
    });
  }

  async function handleOnline(): Promise<void> {
    browserOffline = false;
    isOffline = false;
    syncMessage = "接続を確認しています…";
    try {
      if (!store) return await initializeMode();
      await syncNow();
      const hasActivePrompt =
        mode === "reading"
          ? readingPhase === "prompt" || readingPhase === "advancing"
          : grammarPhase === "introduction" ||
            grammarPhase === "practice" ||
            grammarPhase === "feedback" ||
            grammarPhase === "advancing";
      if (!hasActivePrompt) await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  function handleOffline(): void {
    browserOffline = true;
    isOffline = true;
    syncMessage = `${browserState?.pendingCount ?? 0}件を端末に保存 · オフライン`;
  }

  function activeSessionId(): string | null {
    if (!browserState) return null;
    return mode === "reading"
      ? browserState.activeReadingSessionId
      : browserState.activeGrammarSessionId;
  }

  function setLoading(showLoading = true): void {
    if (mode === "reading") readingPhase = showLoading ? "loading" : "advancing";
    else grammarPhase = showLoading ? "loading" : "advancing";
  }

  function missingCacheError(kind: SurfaceMode): Error {
    return new Error(
      isOffline
        ? `接続が切れる前に、この${kind === "reading" ? "読解" : "文法"}セットを保存できませんでした。`
        : `${kind === "reading" ? "読解" : "文法"}セットをまだ取得できていません。`,
    );
  }

  function elapsedPromptTime(): number {
    return Math.max(0, Math.round(performance.now() - promptStartedAt));
  }

  function showError(error: unknown): void {
    errorMessage = learnerError(error, "問題が発生しました。");
    if (mode === "reading") readingPhase = "error";
    else grammarPhase = "error";
  }

  function preferredMeaning(meanings: ReadingCard["vocabulary"][number]["meanings"]): string {
    return (
      (
        meanings.find(({ language }) => language === "ja") ??
        meanings.find(({ language }) => language === "en") ??
        meanings[0]
      )?.text ?? "意味がありません"
    );
  }

  function completedPracticeSentence(card: GrammarCard): string {
    const answer = card.topic.practice.choices.find(
      ({ id }) => id === card.topic.practice.answerChoiceId,
    );
    return card.topic.practice.prompt.replace("___", answer?.label ?? "");
  }

  function rememberGuidedCompletion(
    completedSession: GuidedSessionView,
    attempts: Parameters<typeof localGuidedSummary>[1],
  ): void {
    completionSummary = localGuidedSummary(completedSession, attempts);
    cachePracticeSummary(completionSummary);
  }

  async function restoreCompletedResult(): Promise<boolean> {
    if (!store || browserState?.presentedResult?.mode !== mode) return false;
    const sessionId = browserState.presentedResult.sessionId;
    if (browserState.dismissedResultSessionIds.includes(sessionId)) return false;
    const record = await store.getGuidedSessionRecord(mode, sessionId);
    if (!record || !hasCompletedLocalResult(record.session)) return false;
    session = record.session;
    readingCard = null;
    grammarCard = null;
    rememberGuidedCompletion(record.session, record.attempts);
    if (mode === "reading") readingPhase = "completed";
    else grammarPhase = "completed";
    return true;
  }

  async function startAfterCompletion(): Promise<void> {
    if (activeSessionId()) {
      await initializeMode();
      return;
    }
    if (store && session) {
      browserState = await store.dismissPracticeResult(mode, session.id);
    }
    await createSession();
  }
</script>

<svelte:window ononline={() => void handleOnline()} onoffline={handleOffline} />

<header class="app-header surface-header guided-header">
  <div class="surface-title">
    <span class="section-mark">04</span>
    <h2>{mode === "reading" ? "読解" : "文法"}</h2>
  </div>
  {#if session && (readingPhase === "prompt" || readingPhase === "advancing" || grammarPhase === "introduction" || grammarPhase === "practice" || grammarPhase === "feedback" || grammarPhase === "advancing")}
    <p class="progress" aria-label={`項目 ${session.completedItems + 1} / ${session.maxItems}`}>
      <strong>{session.completedItems + 1}</strong><span>/ {session.maxItems}</span>
    </p>
  {/if}
</header>

<nav class="guided-nav" aria-label="読解と文法">
  <button class:active={mode === "reading"} onclick={() => void selectMode("reading")}
    >例文を読む</button
  ><button class:active={mode === "grammar"} onclick={() => void selectMode("grammar")}
    >文法コース</button
  >
</nav>

<p class:offline={isOffline} class="sync-status" aria-live="polite">
  {isOffline ? `${browserState?.pendingCount ?? 0}件を端末に保存 · オフライン` : syncMessage}
</p>

{#if (mode === "reading" && readingPhase === "loading") || (mode === "grammar" && grammarPhase === "loading")}
  <section class="status-panel" aria-live="polite">
    <div class="pulse guided-pulse" aria-hidden="true"></div>
    <h2>例文セットを準備しています…</h2>
    <p>
      {mode === "reading"
        ? PRACTICE_CATALOG.reading.setupDescription
        : PRACTICE_CATALOG.grammar.setupDescription}
    </p>
  </section>
{:else if (mode === "reading" && readingPhase === "error") || (mode === "grammar" && grammarPhase === "error")}
  <section class="status-panel error-panel" role="alert">
    <p class="status-kicker">練習を一時停止しました</p>
    <h2>記録は失われていません</h2>
    <p>{errorMessage}</p>
    <button class="primary-button" onclick={() => void initializeMode()}>もう一度試す</button>
  </section>
{:else if (mode === "reading" && readingPhase === "empty") || (mode === "grammar" && grammarPhase === "empty")}
  <section class="status-panel">
    <p class="completion-mark" aria-hidden="true">—</p>
    <h2>まだ教材がありません</h2>
    <p>このコースで使えるレッスンが準備されていません。</p>
  </section>
{:else if ((mode === "reading" && readingPhase === "completed") || (mode === "grammar" && grammarPhase === "completed")) && completionSummary}
  <section class="status-panel shared-result-panel">
    <PracticeResult summary={completionSummary} />
    <button class="primary-button" onclick={() => void startAfterCompletion()}
      >{activeSessionId()
        ? "同期を再試行"
        : `別の${mode === "reading" ? "読解" : "文法"}を始める`}</button
    >
    <a class="text-link" href="#progress">記録で詳しく見る</a>
  </section>
{:else if mode === "reading" && readingCard}
  <section class="study-card reading-card" aria-live="polite">
    <div class="card-meta">
      <span class="queue-badge reading-badge">例文</span><span>中国語から読む</span>
    </div>
    <div class="reading-prompt">
      <p class="prompt-instruction">意味を考えながら読む</p>
      <h2>{readingCard.sentence.chinese}</h2>
    </div>

    {#if revealStage >= 1}
      <section
        class="reveal-panel vocabulary-reveal"
        data-reveal-stage="1"
        aria-label="単語と読みのヒント"
      >
        <p class="reveal-kicker">1 · 単語と読み</p>
        <p class="reading-note">辞書上の読みです。例文のピンインは文脈に合わせています。</p>
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
      <section class="reveal-panel" data-reveal-stage="2" aria-label="例文のピンイン">
        <p class="reveal-kicker">2 · ピンイン</p>
        <p class="sentence-pinyin">{readingCard.sentence.pinyin}</p>
      </section>
    {/if}
    {#if revealStage >= 3}
      <section class="reveal-panel" data-reveal-stage="3" aria-label="例文の意味">
        <p class="reveal-kicker">3 · 意味</p>
        <p class="sentence-meaning">{readingCard.sentence.meaningJa}</p>
        <p class="sentence-meaning secondary">{readingCard.sentence.meaningEn}</p>
      </section>
    {/if}
    {#if revealStage >= 4}
      <section class="reveal-panel grammar-reveal" data-reveal-stage="4" aria-label="文法の説明">
        <p class="reveal-kicker">4 · 文法</p>
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
          >関連する文法コースを開く</button
        >
      </section>
    {/if}

    {#if revealStage < 4}
      <button
        class="reveal-button staged-reveal"
        disabled={readingPhase === "advancing"}
        onclick={() => void revealNext()}
      >
        <span>{["単語を表示", "ピンインを表示", "意味を表示", "文法を表示"][revealStage]}</span
        ><small>{revealStage + 1} / 4</small>
      </button>
    {:else}
      <div class="rating-area">
        <p>どのくらい理解できましたか？</p>
        <div class="rating-grid guided-ratings">
          {#each confidenceRatings as rating}
            <button
              class={`rating rating-${rating.value}`}
              disabled={readingPhase === "advancing"}
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
      <span class="queue-badge grammar-badge">文法 {grammarCard.topic.sequence}</span>
      <span>{grammarCard.topic.state?.status ?? "新しい項目"}</span>
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
            <p class="example-label">この例文を読む</p>
            <p class="example-chinese">{example.chinese}</p>
            {#if exampleHelpRevealed}<p class="example-pinyin">{example.pinyin}</p>
              <p class="example-meaning">{example.meaningJa}</p>{/if}
          </div>
        {/each}
        {#if !exampleHelpRevealed}<button
            class="text-button"
            onclick={() => (exampleHelpRevealed = true)}>例文のピンインと意味を表示</button
          >{/if}
        <button class="primary-button grammar-practice-button" onclick={beginGrammarPractice}
          >このパターンを練習する</button
        >
      </div>
    {:else if grammarPhase === "practice"}
      <div class="grammar-question">
        <p class="prompt-instruction">文を完成させる語を選ぶ</p>
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
          {grammarCorrect ? "正解" : "違いを確認しましょう"}
        </p>
        <p class="practice-answer">{completedPracticeSentence(grammarCard)}</p>
        <p>{grammarCard.topic.practice.explanationJa}</p>
      </div>
      <div class="rating-area">
        <p>この文法をどのくらい理解できましたか？</p>
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
    {:else if grammarPhase === "advancing"}
      <div class="advancing-note" role="status">次の項目を準備しています…</div>
    {/if}
  </section>
{/if}
