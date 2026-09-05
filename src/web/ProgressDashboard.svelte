<script lang="ts">
  import { onMount } from "svelte";

  import type {
    ActivityType,
    PracticeMode,
    ProgressCorrectness,
    ProgressSnapshot,
    ProgressTroubleItem,
  } from "../domain/types";
  import { postJson } from "./api";
  import {
    activityTypeLabel as localizedActivityLabel,
    learnerError,
    PRACTICE_MODE_LABELS,
  } from "./ui-copy";

  let snapshot: ProgressSnapshot | null = null;
  let loading = true;
  let error = "";

  onMount(() => {
    void loadSnapshot();
  });

  async function loadSnapshot(): Promise<void> {
    loading = true;
    error = "";
    try {
      snapshot = await postJson<ProgressSnapshot>("/api/progress", {});
    } catch (cause) {
      error = learnerError(cause, "進捗を読み込めませんでした。");
    } finally {
      loading = false;
    }
  }

  function formatDate(timestamp: number | null, timezone: string): string {
    if (timestamp === null) return "学習記録はまだありません";
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp);
  }

  function formatPercent(correctness: ProgressCorrectness): string {
    return correctness.rate === null ? "—" : `${Math.round(correctness.rate * 100)}%`;
  }

  function formatRating(value: number | null): string {
    return value === null ? "—" : `${value.toFixed(1)} / 4`;
  }

  function formatLatency(value: number | null): string {
    return value === null ? "—" : `${(value / 1_000).toFixed(2)}秒`;
  }

  function modeLabel(mode: PracticeMode): string {
    return PRACTICE_MODE_LABELS[mode];
  }

  function activityLabel(activity: ActivityType): string {
    const labels: Record<ActivityType, string> = {
      hanzi_to_meaning: "漢字 → 意味",
      meaning_to_hanzi: "意味 → 漢字",
      hanzi_to_pinyin: "漢字 → ピンイン",
      pinyin_to_hanzi: "ピンイン → 漢字",
      audio_to_hanzi: "音声 → 漢字",
      audio_to_meaning: "音声 → 意味",
      tone_identification: "声調を聞き分ける",
      tone_pair_identification: "声調の組み合わせ",
      pronunciation_production: "発音して確認",
      read_aloud: "音読",
      sentence_reading: "例文を読む",
    };
    return labels[activity] ?? localizedActivityLabel(activity);
  }

  function evidence(item: ProgressTroubleItem): string {
    const bits = [`最近${item.recentAttempts}回`];
    if (item.evidence.averageResponseMs !== undefined) {
      bits.push(`平均 ${formatLatency(item.evidence.averageResponseMs)}`);
    }
    if (item.evidence.selfReportedRecallMisses !== undefined) {
      bits.push(`自己申告の想起ミス ${item.evidence.selfReportedRecallMisses}件`);
    }
    return bits.join(" · ");
  }
</script>

<section class="progress-dashboard" aria-labelledby="progress-heading">
  <header class="dashboard-heading">
    <div class="dashboard-title">
      <div>
        <h2 id="progress-heading">長期の進捗</h2>
        <p>復習状態や最近30日の積み上がりを、セッション記録とは分けてまとめます。</p>
      </div>
    </div>
    <button class="refresh-button" onclick={loadSnapshot} disabled={loading}>更新</button>
  </header>

  {#if loading && !snapshot}
    <section class="status-panel dashboard-status" aria-live="polite">
      <div class="pulse"></div>
      <h2>学習記録を読み込んでいます…</h2>
      <p>最新の進捗を準備しています。</p>
    </section>
  {:else if error && !snapshot}
    <section class="status-panel error-panel dashboard-status" role="alert">
      <p class="status-kicker">進捗を読み込めません</p>
      <h2>進捗を表示できませんでした</h2>
      <p>{error}</p>
      <button class="primary-button" onclick={loadSnapshot}>もう一度試す</button>
    </section>
  {:else if snapshot}
    <div class="freshness-strip" aria-label="進捗の更新情報">
      <span><strong>更新</strong> {formatDate(snapshot.generatedAt, snapshot.timezone)}</span>
      <span
        ><strong>記録の範囲</strong>
        {formatDate(snapshot.dataThrough.changedAt, snapshot.timezone)}</span
      >
      <span><strong>同期位置</strong> {snapshot.dataThrough.serverSeq ?? "—"}</span>
      <span><strong>表示版</strong> v{snapshot.snapshotVersion}</span>
    </div>

    {#if error}
      <p class="inline-error" role="alert">
        更新できませんでした。前回の進捗を表示しています。{error}
      </p>
    {/if}

    <div class="dashboard-grid dashboard-overview">
      <article class="dashboard-card attention-card">
        <p class="dashboard-kicker">いま確認したいこと</p>
        <h3>復習 {snapshot.vocabulary.dueNow} · 新規 {snapshot.vocabulary.new}</h3>
        <p>
          {snapshot.troublesomeItems.length === 0
            ? "最近のつまずきはまだありません。練習を続けると、ここに手がかりが集まります。"
            : `要確認の項目が${snapshot.troublesomeItems.length}件あります。下で理由を確認できます。`}
        </p>
      </article>

      <article class="dashboard-card">
        <p class="dashboard-kicker">過去7日間</p>
        <div class="metric-row">
          <div>
            <strong>{snapshot.overall.last7Days.answeredAttempts}</strong><span>回答</span>
          </div>
          <div>
            <strong>{snapshot.overall.last7Days.activeDays}</strong><span>学習日</span>
          </div>
          <div><strong>{snapshot.overall.last7Days.sessions}</strong><span>セッション</span></div>
        </div>
        <p class="metric-note">
          予定された復習 {snapshot.overall.last7Days.scheduledReviews}件 · {snapshot.timezone}基準
        </p>
      </article>
    </div>

    <section aria-labelledby="mode-progress-heading">
      <div class="section-heading">
        <div>
          <h3 id="mode-progress-heading">学習モード別</h3>
          <p class="section-context">過去30日間</p>
        </div>
        <span>回答 {snapshot.overall.last30Days.answeredAttempts}件</span>
      </div>

      <div class="dashboard-grid mode-progress-grid">
        <article class="dashboard-card mode-card-progress vocabulary-progress">
          <div class="mode-card-heading">
            <div>
              <p>単語</p>
              <h4>カードの状態</h4>
            </div>
            <strong>復習 {snapshot.vocabulary.dueNow}</strong>
          </div>
          <div class="compact-metrics">
            <span><strong>{snapshot.vocabulary.new}</strong> 新規</span>
            <span><strong>{snapshot.vocabulary.learning}</strong> 学習中</span>
            <span><strong>{snapshot.vocabulary.review}</strong> 定着</span>
          </div>
          <p class="mode-detail">
            予定復習 {snapshot.vocabulary.recentScheduledReviews}件 · 評価 もう一度 {snapshot
              .vocabulary.recentRatings[1]} / あやふや {snapshot.vocabulary.recentRatings[2]} / 次へ {snapshot
              .vocabulary.recentRatings[3]} / すぐ出た {snapshot.vocabulary.recentRatings[4]}
          </p>
        </article>

        <article class="dashboard-card mode-card-progress pronunciation-progress">
          <div class="mode-card-heading">
            <div>
              <p>発音</p>
              <h4>{snapshot.pronunciation.recentResponses}回答</h4>
            </div>
            {#if snapshot.pronunciation.recentSkips > 0}
              <strong>音声スキップ {snapshot.pronunciation.recentSkips}</strong>
            {/if}
          </div>
          <ul class="activity-summary-list">
            {#each snapshot.pronunciation.byActivity.filter((item) => item.responses > 0 || item.skips > 0) as activity (activity.activityType)}
              <li>
                <span>{activityLabel(activity.activityType)}</span>
                <strong>
                  {#if activity.correctness}
                    正答率 {formatPercent(activity.correctness)}
                  {:else if activity.selfReportedRecall}
                    自己申告 {activity.selfReportedRecall.remembered} / {activity.selfReportedRecall
                      .responses}
                  {:else if activity.selfRatings}
                    過去の自己評価 {formatRating(activity.selfRatings.average)}
                  {:else if activity.responses > 0}
                    練習完了 {activity.responses}
                  {:else}
                    スキップ {activity.skips}
                  {/if}
                </strong>
              </li>
            {:else}
              <li class="empty-list-item">この期間の発音記録はありません。</li>
            {/each}
          </ul>
        </article>

        <article class="dashboard-card mode-card-progress">
          <div class="mode-card-heading">
            <div>
              <p>読解</p>
              <h4>{snapshot.reading.recentSentences}例文</h4>
            </div>
            <strong>{snapshot.reading.comprehension ? "過去評価あり" : "完了のみ"}</strong>
          </div>
          <p class="mode-detail">
            段階読みの完了 {snapshot.reading.recentResponses}件 · 正答率は記録しません
            {#if snapshot.reading.comprehension}
              · 旧式評価 {formatRating(snapshot.reading.comprehension.average)}{/if}
          </p>
        </article>

        <article class="dashboard-card mode-card-progress">
          <div class="mode-card-heading">
            <div>
              <p>文法</p>
              <h4>{formatPercent(snapshot.grammar.correctness)} 正答率</h4>
            </div>
            <strong>{snapshot.grammar.recentResponses}回答</strong>
          </div>
          <div class="compact-metrics">
            <span><strong>{snapshot.grammar.topicCounts.practiced}</strong> 実施済み</span>
            <span><strong>{snapshot.grammar.topicCounts.introduced}</strong> 導入済み</span>
            <span><strong>{snapshot.grammar.topicCounts.notIntroduced}</strong> 未導入</span>
          </div>
          <p class="mode-detail">
            客観的な選択問題の記録
            {#if snapshot.grammar.topicCounts.historicalConfidence > 0}
              · 旧式評価のある項目 {snapshot.grammar.topicCounts.historicalConfidence}{/if}
            {#if snapshot.grammar.confidence}
              · 旧式自信度 {formatRating(snapshot.grammar.confidence.average)}{/if}
          </p>
        </article>

        <article class="dashboard-card mode-card-progress reflex-progress">
          <div class="mode-card-heading">
            <div>
              <p>単語・クイズ</p>
              <h4>{snapshot.reflex.recentResponses}回答</h4>
            </div>
          </div>
          <ul class="activity-summary-list">
            {#each snapshot.reflex.byChoiceCount as quiz (quiz.choiceCount)}
              <li>
                <span>{quiz.choiceCount}択 · {quiz.recentResponses}回答</span>
                <strong>
                  {formatPercent(quiz.correctness)} · 平均 {formatLatency(
                    quiz.latency.averageResponseMs,
                  )}
                  {#if quiz.latency.slowThresholdMs !== null && quiz.latency.slowResponses !== null}
                    · {quiz.latency.slowThresholdMs / 1_000}秒以上 {quiz.latency.slowResponses}
                  {/if}
                </strong>
              </li>
            {/each}
          </ul>
          <p class="mode-detail">選択問題の記録です。復習の予定には影響しません。</p>
        </article>
      </div>
    </section>

    <section aria-labelledby="trouble-heading">
      <div class="section-heading">
        <div>
          <h3 id="trouble-heading">要確認の項目</h3>
          <p class="section-context">最近のつまずきから</p>
        </div>
        <span>最大8件</span>
      </div>

      {#if snapshot.troublesomeItems.length === 0}
        <article class="dashboard-card empty-dashboard-card">
          <h4>要確認の項目はまだありません</h4>
          <p>
            「もう一度」「あやふや」、誤答、自己申告で思い出せなかった項目、遅いクイズ回答が、出題元とともに表示されます。
          </p>
        </article>
      {:else}
        <div class="trouble-list">
          {#each snapshot.troublesomeItems as item (item.id)}
            <article class="trouble-item">
              <div class="trouble-heading">
                <span class="mode-chip mode-{item.mode}">{modeLabel(item.mode)}</span>
                <span class="activity-chip">{activityLabel(item.activityType)}</span>
                {#if item.choiceCount}<span class="activity-chip">{item.choiceCount}択</span>{/if}
              </div>
              <div class="trouble-copy">
                <div>
                  <h4>{item.label}</h4>
                  {#if item.detail}<p class="trouble-detail">{item.detail}</p>{/if}
                </div>
                <p>{item.reasons.join(" · ")}</p>
              </div>
              <footer>
                <span>{evidence(item)}</span>
                <span>最終練習 {formatDate(item.lastPracticedAt, snapshot.timezone)}</span>
              </footer>
            </article>
          {/each}
        </div>
      {/if}
    </section>

    <p class="snapshot-boundary-note">
      集計は実際に練習した時刻を基準にしています。音声スキップは回答に数えず、読解は完了のみ、文法は客観的な正答率を中心に記録し、過去の評価は別に扱います。単語クイズは復習予定の外で記録します。
    </p>
  {/if}
</section>
