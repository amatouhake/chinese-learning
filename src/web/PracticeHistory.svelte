<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteDate } from "svelte/reactivity";

  import { PRACTICE_CATALOG } from "../domain/practice-catalog";
  import type { PracticeSessionHistory, PracticeSessionSummary } from "../domain/types";
  import { postJson } from "./api";
  import { cachePracticeHistory, readPracticeHistoryCache } from "./practice-history-cache";
  import PracticeResult from "./PracticeResult.svelte";
  import {
    activityTypeLabel,
    learnerError,
    pronunciationFocusLabel,
    studyDirectionLabel,
  } from "./ui-copy";

  let history: PracticeSessionHistory = readPracticeHistoryCache();
  let selected: PracticeSessionSummary | null = null;
  let loading = history.sessions.length === 0;
  let error = "";
  let offlineCache = false;

  onMount(() => void loadHistory());

  async function loadHistory(): Promise<void> {
    loading = history.sessions.length === 0;
    error = "";
    try {
      const canonical = await postJson<PracticeSessionHistory>("/api/practice-sessions/recent", {
        limit: 20,
      });
      cachePracticeHistory(canonical);
      history = readPracticeHistoryCache();
      offlineCache = false;
    } catch (cause) {
      history = readPracticeHistoryCache();
      offlineCache = history.sessions.length > 0;
      if (!offlineCache) error = learnerError(cause, "最近の記録を読み込めませんでした。");
    } finally {
      loading = false;
    }
  }

  function sessionLine(summary: PracticeSessionSummary): string {
    if (summary.practice === "vocabulary_review") {
      return `${studyDirectionLabel(summary.configuration.direction)} · ${summary.completedItems}枚`;
    }
    if (summary.practice === "vocabulary_quiz") {
      const activity =
        summary.configuration.activityType === "mixed"
          ? "混合"
          : activityTypeLabel(summary.configuration.activityType);
      return `${activity} · ${summary.evidence.correctness.correct}/${summary.evidence.correctness.responses} · ${summary.configuration.choiceCount}択`;
    }
    if (summary.practice === "pronunciation") {
      return `${pronunciationFocusLabel(summary.configuration.focus)} · ${summary.completedItems}問`;
    }
    if (summary.practice === "reading") return `${summary.completedItems}文`;
    return `${summary.completedItems}問`;
  }

  function dateLabel(timestamp: number): string {
    const date = new SvelteDate(timestamp);
    const today = new SvelteDate();
    const yesterday = new SvelteDate(today);
    yesterday.setDate(today.getDate() - 1);
    const sameDay = (left: Date, right: Date) =>
      left.getFullYear() === right.getFullYear() &&
      left.getMonth() === right.getMonth() &&
      left.getDate() === right.getDate();
    const prefix = sameDay(date, today)
      ? "今日"
      : sameDay(date, yesterday)
        ? "昨日"
        : new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" }).format(date);
    return `${prefix} ${new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(date)}`;
  }
</script>

{#if selected}
  <section class="history-detail">
    <button class="back-link" onclick={() => (selected = null)}>最近の記録へ戻る</button>
    <PracticeResult summary={selected} />
  </section>
{:else}
  <section class="practice-history">
    <header class="record-section-heading">
      <div>
        <h2>最近の練習</h2>
        <p>どの設定で何を行い、各セットがどうだったかを確認できます。</p>
      </div>
      {#if offlineCache}<span>端末の記録</span>{/if}
    </header>
    {#if loading}
      <div class="history-status" aria-live="polite">記録を読み込んでいます…</div>
    {:else if error}
      <div class="history-status" role="alert">
        <p>{error}</p>
        <button onclick={() => void loadHistory()}>再読み込み</button>
      </div>
    {:else if history.sessions.length === 0}
      <div class="history-status">
        <h3>完了した練習はまだありません</h3>
        <p>最初のセットを終えると、ここから結果を開き直せます。</p>
      </div>
    {:else}
      <ol class="session-history-list">
        {#each history.sessions as summary}
          <li>
            <button onclick={() => (selected = summary)}>
              <time datetime={new SvelteDate(summary.endedAt).toISOString()}
                >{dateLabel(summary.endedAt)}</time
              >
              <strong>{PRACTICE_CATALOG[summary.practice].learnerName}</strong>
              <span>{sessionLine(summary)}</span>
              <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m7 4 6 6-6 6" /></svg>
            </button>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
{/if}
