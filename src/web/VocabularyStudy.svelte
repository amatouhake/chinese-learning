<script lang="ts">
  import { onMount } from "svelte";

  import type { FsrsRating, StudyCard, StudyDirection, StudySessionView } from "../domain/types";
  import { ApiError, postJson } from "./api";
  import {
    OfflineLearningStore,
    type BrowserOfflineState,
    type StudyReviewRecord,
  } from "./offline-store";
  import {
    DEFAULT_STUDY_PREFERENCES,
    readStudyPreferences,
    type StudyPreferences,
    type StudySessionSize,
    writeStudyPreferences,
  } from "./study-preferences";
  import { getSoundEnabled, playPronunciationAudio, prepareSound } from "./sound";
  import { activityTypeLabel, learnerError, studyDirectionLabel } from "./ui-copy";
  import { synchronizeLearning } from "./sync";

  type Phase =
    "loading" | "choose" | "prompt" | "revealed" | "advancing" | "empty" | "completed" | "error";

  interface RatingOption {
    rating: FsrsRating;
    label: string;
    hint: string;
  }

  const ratings: RatingOption[] = [
    { rating: 1, label: "忘れた", hint: "もう一度" },
    { rating: 2, label: "あやふや", hint: "手がかりが必要" },
    { rating: 3, label: "思い出せた", hint: "次へ" },
    { rating: 4, label: "すぐ出た", hint: "余裕あり" },
  ];
  const dominantRatings = ratings.filter(({ rating }) => rating === 1 || rating === 3);
  const fineRatings = ratings.filter(({ rating }) => rating === 2 || rating === 4);
  const directionOptions: Array<{ value: StudyDirection; label: string; hint: string }> = [
    { value: "mixed", label: "混合", hint: "漢字と日本語を行き来" },
    { value: "hanzi_to_meaning", label: "漢字 → 日本語", hint: "意味を思い出す" },
    { value: "meaning_to_hanzi", label: "日本語 → 漢字", hint: "漢字を思い出す" },
  ];
  const sizeOptions: StudySessionSize[] = [5, 10, 20];

  let phase: Phase = "loading";
  let store: OfflineLearningStore | null = null;
  let browserState: BrowserOfflineState | null = null;
  let session: StudySessionView | null = null;
  let card: StudyCard | null = null;
  let reviews: StudyReviewRecord[] = [];
  let preferences: StudyPreferences = DEFAULT_STUDY_PREFERENCES;
  let errorMessage = "";
  let promptStartedAt = 0;
  let syncMessage = "単語セットを準備しています…";
  let browserOffline = !navigator.onLine;
  let isOffline = browserOffline;
  let audioMessage = "";
  let autoplayedCardKey: string | null = null;

  onMount(() => {
    preferences = readStudyPreferences();
    void initializeStudy();
  });

  async function initializeStudy(): Promise<void> {
    phase = "loading";
    errorMessage = "";
    try {
      store ??= await OfflineLearningStore.open(localStorage);
      browserState = await store.snapshot();
      if (!browserState.activeSessionId) {
        if (browserState.lastCompletedStudySessionId) {
          const completed = await store.getStudySessionRecord(
            browserState.lastCompletedStudySessionId,
          );
          if (completed && completed.session.reviewedCards > 0) {
            session = completed.session;
            reviews = completed.reviews;
            card = null;
            phase = "completed";
            return;
          }
        }
        phase = "choose";
        return;
      }
      if (!browserOffline) {
        try {
          await ensureSession(browserState.activeSessionId, browserState.deviceId, preferences);
          await syncNow();
        } catch (error) {
          if (!(await store.getStudySession(browserState.activeSessionId))) throw error;
          isOffline = browserOffline || !(error instanceof ApiError);
          syncMessage = isOffline
            ? "通信できないため、保存済みの単語セットを使います"
            : "サーバーに接続できないため、保存済みの単語セットを使います";
        }
      }
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  async function createNewSession(
    direction: StudyDirection = preferences.direction,
    size: StudySessionSize = preferences.size,
  ): Promise<void> {
    phase = "loading";
    errorMessage = "";
    preferences = { direction, size };
    writeStudyPreferences(preferences);
    try {
      if (browserOffline) throw new Error("再接続すると、新しい単語セットを準備できます。");
      store ??= await OfflineLearningStore.open(localStorage);
      browserState ??= await store.snapshot();
      if (browserState.activeSessionId) {
        const active = await store.getStudySession(browserState.activeSessionId);
        if (!active || (active.reviewedCards < active.maxCards && active.endedAt === null)) {
          throw new Error("進行中の単語セットがあります。先に現在のセットを終えてください。");
        }
        browserState = await store.clearActiveStudySession(browserState.activeSessionId);
      }
      browserState = await store.setActiveStudySession(`study-session:${crypto.randomUUID()}`);
      if (!browserState.activeSessionId) throw new Error("単語セッションを開始できませんでした。");
      await ensureSession(browserState.activeSessionId, browserState.deviceId, preferences);
      await syncNow();
      await loadNextCard();
    } catch (error) {
      showError(error);
    }
  }

  async function ensureSession(
    sessionId: string,
    deviceId: string,
    selected: StudyPreferences,
  ): Promise<void> {
    const result = await postJson<{ session: StudySessionView }>("/api/study/sessions", {
      sessionId,
      deviceId,
      maxCards: selected.size,
      direction: selected.direction,
    });
    session = result.session;
    if (!store) throw new Error("オフライン保存を準備できませんでした。");
    await store.rememberStudySession(result.session);
  }

  async function loadNextCard(showLoading = true): Promise<void> {
    if (!store || !browserState?.activeSessionId) {
      throw new Error("単語セッションがありません。");
    }
    phase = showLoading ? "loading" : "advancing";
    const sessionId = browserState.activeSessionId;
    const [record, cachedCard] = await Promise.all([
      store.getStudySessionRecord(sessionId),
      store.getCachedStudyCard(sessionId),
    ]);
    if (!record) {
      throw new Error(
        isOffline
          ? "接続が切れる前に、この単語セットを保存できませんでした。"
          : "単語セットをまだ取得できていません。",
      );
    }
    session = record.session;
    reviews = record.reviews;
    card = cachedCard;
    audioMessage = "";
    if (cachedCard) {
      promptStartedAt = performance.now();
      phase = "prompt";
      if (cachedCard.activityType === "hanzi_to_meaning") void autoplayCardAudio();
      return;
    }
    if (record.session.endedAt !== null) {
      browserState = await store.clearActiveStudySession(sessionId);
    }
    phase = record.session.reviewedCards === 0 ? "empty" : "completed";
  }

  async function rateCard(rating: FsrsRating): Promise<void> {
    if (phase !== "revealed" || !card || !browserState?.activeSessionId) return;
    try {
      phase = "advancing";
      if (!store) throw new Error("オフライン保存を準備できませんでした。");
      const sessionId = browserState.activeSessionId;
      const meaning = preferredMeaning(card);
      const prompt = promptText(card);
      const answer = answerText(card);
      const staged = await store.stageAttemptFromCurrentState({
        cardId: card.cardId,
        studySessionId: sessionId,
        mode: "study",
        activityType: card.activityType,
        responseMs: Math.max(0, Math.round(performance.now() - promptStartedAt)),
        expectedCardStateVersion: card.state.version,
        metadata: {
          interaction: "reveal-and-rate",
          queueSource: card.source,
          studyReview: {
            activityType: card.activityType,
            source: card.source,
            simplified: card.lexeme.simplified,
            pinyin: card.lexeme.pinyin,
            meaning,
            prompt,
            answer,
          },
        },
        fsrsReview: { rating, schedulerConfigId: card.schedulerConfigId },
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
    if (result.error) {
      syncMessage = `${result.pending}件を同期待ちにしています`;
      return;
    }
    syncMessage =
      result.pending === 0 ? "この端末に保存済み · 同期済み" : `${result.pending}件を同期待ち`;
  }

  function syncInBackground(): void {
    if (browserOffline) return;
    const sessionId = browserState?.activeSessionId;
    void syncNow()
      .then(async () => {
        if (phase === "completed" && sessionId && browserState?.activeSessionId === sessionId) {
          await loadNextCard(false);
        }
      })
      .catch(() => {
        isOffline = true;
        syncMessage = `${browserState?.pendingCount ?? 0}件を同期待ちにしています`;
      });
  }

  async function handleOnline(): Promise<void> {
    browserOffline = false;
    isOffline = false;
    syncMessage = "接続を確認しています…";
    try {
      if (!store) return await initializeStudy();
      await syncNow();
      if (phase === "completed" && browserState?.activeSessionId) {
        await loadNextCard(false);
      } else if (phase !== "revealed" && phase !== "advancing" && phase !== "choose") {
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
    return preferredMeaning(value);
  }

  function answerText(value: StudyCard): string {
    if (value.activityType === "hanzi_to_meaning") return preferredMeaning(value);
    return value.lexeme.simplified;
  }

  function preferredMeaning(value: StudyCard): string {
    const japanese = value.lexeme.meanings.filter(({ language }) => language === "ja");
    const fallback = value.lexeme.meanings.filter(({ language }) => language !== "ja");
    return [...japanese, ...fallback]
      .slice(0, 2)
      .map(({ text }) => text)
      .join(" / ");
  }

  function revealCard(): void {
    if (phase !== "prompt") return;
    prepareSound();
    phase = "revealed";
    if (card?.activityType === "meaning_to_hanzi") void autoplayCardAudio();
  }

  async function playCardAudio(): Promise<void> {
    if (!card?.media || !getSoundEnabled()) return;
    const played = await playPronunciationAudio(card.media.url);
    if (!played) {
      audioMessage = isOffline
        ? "発音音声は端末に保存されていません。"
        : "音声を再生できませんでした。";
    }
  }

  async function autoplayCardAudio(): Promise<void> {
    if (!card?.media || !getSoundEnabled()) return;
    const cardKey = `${session?.id ?? browserState?.activeSessionId ?? "study"}:${card.cardId}`;
    if (autoplayedCardKey === cardKey || readAutoplayMarker() === cardKey) return;
    autoplayedCardKey = cardKey;
    writeAutoplayMarker(cardKey);
    await playCardAudio();
  }

  function readAutoplayMarker(): string | null {
    try {
      return sessionStorage.getItem("chinese-learning.study-autoplay.v1");
    } catch {
      return null;
    }
  }

  function writeAutoplayMarker(value: string): void {
    try {
      sessionStorage.setItem("chinese-learning.study-autoplay.v1", value);
    } catch {
      // Autoplay deduplication is best effort; the drill remains usable.
    }
  }

  function ratingLabel(rating: FsrsRating): string {
    return ratings.find((option) => option.rating === rating)?.label ?? "記録済み";
  }

  function meaningLanguageLabel(language: string): string {
    if (language === "ja") return "日本語";
    if (language === "en") return "英語";
    return language.toUpperCase();
  }

  function showError(error: unknown): void {
    errorMessage = learnerError(error, "問題が発生しました。");
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
    <h2>単語</h2>
  </div>
  {#if session && (phase === "prompt" || phase === "revealed" || phase === "advancing")}
    <p class="progress" aria-label={`単語 ${session.reviewedCards + 1} / ${session.maxCards}`}>
      <strong>{session.reviewedCards + 1}</strong><span>/ {session.maxCards}</span>
    </p>
  {/if}
</header>

<p class:offline={isOffline} class="sync-status" aria-live="polite">
  {isOffline ? `${browserState?.pendingCount ?? 0}件を端末に保存 · オフライン` : syncMessage}
</p>

{#if phase === "loading"}
  <section class="status-panel" aria-live="polite">
    <div class="pulse" aria-hidden="true"></div>
    <h2>単語セットを準備しています…</h2>
    <p>期限の来たカードから出題します。</p>
  </section>
{:else if phase === "choose"}
  <section class="mode-picker study-launcher">
    <div class="mode-picker-heading">
      <h2>今日の単語練習</h2>
      <p>方向と枚数を選んで、すぐ始められます。</p>
    </div>
    <fieldset class="study-choice-group">
      <legend>出題方向</legend>
      <div class="study-option-grid direction-options">
        {#each directionOptions as option}
          <button
            type="button"
            class:selected={preferences.direction === option.value}
            aria-pressed={preferences.direction === option.value}
            onclick={() => {
              preferences = { ...preferences, direction: option.value };
              writeStudyPreferences(preferences);
            }}
          >
            <strong>{option.label}</strong><span>{option.hint}</span>
          </button>
        {/each}
      </div>
    </fieldset>
    <fieldset class="study-choice-group">
      <legend>練習する枚数</legend>
      <div class="study-option-grid size-options">
        {#each sizeOptions as size}
          <button
            type="button"
            class:selected={preferences.size === size}
            aria-pressed={preferences.size === size}
            onclick={() => {
              preferences = { ...preferences, size };
              writeStudyPreferences(preferences);
            }}
          >
            <strong>{size}</strong><span>枚</span>
          </button>
        {/each}
      </div>
    </fieldset>
    {#if browserOffline}<p class="boundary-note">
        再接続すると、選んだ設定でセットを準備できます。
      </p>{/if}
    <button
      class="primary-button study-start-button"
      disabled={browserOffline}
      onclick={() => void createNewSession()}
      >練習を始める <span>{studyDirectionLabel(preferences.direction)} · {preferences.size}枚</span
      ></button
    >
  </section>
{:else if phase === "error"}
  <section class="status-panel error-panel" role="alert">
    <p class="status-kicker">練習を一時停止しました</p>
    <h2>記録は失われていません</h2>
    <p>{errorMessage}</p>
    <button class="primary-button" onclick={() => void initializeStudy()}>もう一度試す</button>
  </section>
{:else if phase === "empty"}
  <section class="status-panel">
    <p class="completion-mark" aria-hidden="true">—</p>
    <h2>今すぐ練習できる単語がありません</h2>
    <p>新しい内容が準備できるまで、少し待ってください。</p>
    <button class="primary-button" onclick={() => void initializeStudy()}>もう一度確認</button>
  </section>
{:else if phase === "completed"}
  <section class="status-panel study-completion">
    <p class="completion-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19 7" /></svg>
    </p>
    <h2>単語練習を完了</h2>
    <p class="completion-count">{session?.reviewedCards ?? reviews.length}枚を確認しました</p>
    <div class="completion-summary">
      <span
        ><strong>{reviews.filter(({ rating }) => rating === 1 || rating === 2).length}</strong> 要復習</span
      >
      <span
        ><strong>{reviews.filter(({ rating }) => rating === 3 || rating === 4).length}</strong> 定着</span
      >
      <span>{session ? studyDirectionLabel(session.direction) : "混合"}</span>
    </div>
    {#if reviews.some(({ rating }) => rating === 1 || rating === 2)}
      <div class="review-focus">
        <strong>もう一度見たいカード</strong>
        <span>忘れた・あやふやのカードを次の復習で優先します。</span>
      </div>
    {/if}
    {#if reviews.length > 0}
      <ol class="study-review-list" aria-label="今回の復習カード">
        {#each reviews as review}
          <li class:needs-review={review.rating === 1 || review.rating === 2}>
            <div class="review-pair">
              <strong>{review.prompt}</strong><span aria-hidden="true">→</span><strong
                >{review.answer}</strong
              >
            </div>
            <p>
              {review.simplified}{review.pinyin ? ` · ${review.pinyin}` : ""} · {review.meaning}
            </p>
            <footer>
              <span>{activityTypeLabel(review.activityType)}</span>
              <span>{ratingLabel(review.rating)}</span>
            </footer>
          </li>
        {/each}
      </ol>
    {/if}
    {#if browserOffline}<p class="boundary-note">
        接続が戻るまで、記録はこの端末から同期します。
      </p>{/if}
    <div class="completion-actions">
      <button
        class="primary-button"
        disabled={browserOffline}
        onclick={() =>
          void createNewSession(
            session?.direction ?? preferences.direction,
            (session?.maxCards ?? preferences.size) as StudySessionSize,
          )}>同じ設定でもう一度</button
      >
      <button class="secondary-button" onclick={() => (phase = "choose")}>設定を変える</button>
    </div>
  </section>
{:else if card && (phase === "prompt" || phase === "revealed" || phase === "advancing")}
  <section
    class:advancing={phase === "advancing"}
    class="study-card"
    data-card-id={card.cardId}
    data-phase={phase}
    aria-live="polite"
    aria-busy={phase === "advancing"}
  >
    <div class="card-meta">
      <span class:due={card.source === "due"} class="queue-badge"
        >{card.source === "due" ? "復習" : "新規"}</span
      >
      <span>{activityTypeLabel(card.activityType)}</span>
      {#if card.lexeme.hskLevel}<span>HSK {card.lexeme.hskLevel}</span>{/if}
    </div>
    <div class="prompt-block">
      <p class="prompt-instruction">
        {card.activityType === "hanzi_to_meaning" ? "日本語の意味を思い出す" : "漢字を思い出す"}
      </p>
      <div class="prompt-with-audio">
        <h2 class:hanzi-prompt={card.activityType === "hanzi_to_meaning"}>{promptText(card)}</h2>
        {#if card.media && card.activityType === "hanzi_to_meaning"}
          <button
            class="word-audio prompt-audio"
            aria-label="発音を聞く"
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
    </div>
    {#if phase === "prompt"}
      <button class="reveal-button" onclick={revealCard}
        ><span>答えを見る</span><kbd>Space</kbd></button
      >
    {:else}
      <div class="answer" aria-label="答え">
        <div class="answer-heading">
          <p class="answer-hanzi">{card.lexeme.simplified}</p>
          <div class="answer-reading">
            {#if card.lexeme.traditional && card.lexeme.traditional !== card.lexeme.simplified}<p
                class="traditional"
              >
                繁体字: {card.lexeme.traditional}
              </p>{/if}
            {#if card.lexeme.pinyin}<p class="pinyin">{card.lexeme.pinyin}</p>{/if}
          </div>
          {#if card.media}
            <button
              class="word-audio"
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
        <div class="meanings">
          {#each card.lexeme.meanings.slice(0, 3) as meaning}<p>
              <span>{meaningLanguageLabel(meaning.language)}</span>{meaning.text}
            </p>{/each}
        </div>
        {#if card.example}
          <details class="example">
            <summary>例文を見る</summary>
            <p class="example-chinese">{card.example.chinese}</p>
            {#if card.example.pinyin}<p class="example-pinyin">{card.example.pinyin}</p>{/if}
            {#if card.example.meaningJa || card.example.meaningEn}<p class="example-meaning">
                {card.example.meaningJa ?? card.example.meaningEn}
              </p>{/if}
          </details>
        {/if}
      </div>
      <div class="rating-area">
        <p>どう感じましたか？</p>
        <div class="rating-grid rating-grid-primary">
          {#each dominantRatings as option}
            <button
              class={`rating rating-${option.rating}`}
              disabled={phase === "advancing"}
              onclick={() => void rateCard(option.rating)}
              aria-label={`${option.rating}: ${option.label} — ${option.hint}`}
            >
              <kbd>{option.rating}</kbd><strong>{option.label}</strong><span>{option.hint}</span>
            </button>
          {/each}
        </div>
        <details class="rating-more">
          <summary>細かく記録する <span>2・4</span></summary>
          <div class="rating-grid rating-grid-fine">
            {#each fineRatings as option}
              <button
                class={`rating rating-${option.rating}`}
                disabled={phase === "advancing"}
                onclick={() => void rateCard(option.rating)}
                aria-label={`${option.rating}: ${option.label} — ${option.hint}`}
              >
                <kbd>{option.rating}</kbd><strong>{option.label}</strong><span>{option.hint}</span>
              </button>
            {/each}
          </div>
        </details>
      </div>
      <p class="audio-note" class:visible={Boolean(audioMessage)} role="status">{audioMessage}</p>
    {/if}
  </section>
{/if}
