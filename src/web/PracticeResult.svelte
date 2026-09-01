<script lang="ts">
  import { PRACTICE_CATALOG } from "../domain/practice-catalog";
  import type { PracticeSessionSummary } from "../domain/types";
  import { activityTypeLabel, studyDirectionLabel } from "./ui-copy";

  let { summary }: { summary: PracticeSessionSummary } = $props();

  function percent(rate: number | null): string {
    return rate === null ? "—" : `${Math.round(rate * 100)}%`;
  }

  function seconds(milliseconds: number | null): string {
    return milliseconds === null ? "—" : `${(milliseconds / 1_000).toFixed(1)}秒`;
  }

  function quizActivity(): string {
    if (summary.practice !== "vocabulary_quiz") return "";
    return summary.configuration.activityType === "mixed"
      ? "混合"
      : activityTypeLabel(summary.configuration.activityType);
  }
</script>

<article class="practice-result" data-practice={summary.practice}>
  <header class="result-heading">
    <div>
      <h2>{summary.completedItems}{summary.practice === "vocabulary_review" ? "枚" : "問"}完了</h2>
      <p>{PRACTICE_CATALOG[summary.practice].learnerName}</p>
    </div>
    <time datetime={new Date(summary.endedAt).toISOString()}>
      {new Intl.DateTimeFormat("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(summary.endedAt)}
    </time>
  </header>

  {#if summary.practice === "vocabulary_review"}
    <dl class="result-metrics rating-metrics">
      <div>
        <dt>忘れた</dt>
        <dd>{summary.evidence.ratings.distribution[1]}</dd>
      </div>
      <div>
        <dt>あやふや</dt>
        <dd>{summary.evidence.ratings.distribution[2]}</dd>
      </div>
      <div>
        <dt>思い出せた</dt>
        <dd>{summary.evidence.ratings.distribution[3]}</dd>
      </div>
      <div>
        <dt>すぐ出た</dt>
        <dd>{summary.evidence.ratings.distribution[4]}</dd>
      </div>
    </dl>
    <p class="result-configuration">
      {studyDirectionLabel(summary.configuration.direction)} · 希望 {summary.requestedItems}枚 ·
      実施 {summary.configuration.actualItems}枚
    </p>
    <p class="result-note">評価は復習間隔の記録です。点数ではありません。</p>
  {:else if summary.practice === "vocabulary_quiz"}
    <dl class="result-metrics">
      <div>
        <dt>正解</dt>
        <dd>{summary.evidence.correctness.correct} / {summary.evidence.correctness.responses}</dd>
      </div>
      <div>
        <dt>正答率</dt>
        <dd>{percent(summary.evidence.correctness.rate)}</dd>
      </div>
      <div>
        <dt>平均</dt>
        <dd>{seconds(summary.evidence.averageResponseMs)}</dd>
      </div>
    </dl>
    <p class="result-configuration">{quizActivity()} · {summary.configuration.choiceCount}択</p>
    {#if summary.evidence.timingInterrupted > 0}
      <p class="result-note">
        画面を離れた {summary.evidence.timingInterrupted}問は時間集計から除外しました。
      </p>
    {/if}
  {:else if summary.practice === "pronunciation"}
    <dl class="result-metrics">
      <div>
        <dt>完了</dt>
        <dd>{summary.completedItems}問</dd>
      </div>
      {#if summary.evidence.correctness}
        <div>
          <dt>客観問題</dt>
          <dd>{summary.evidence.correctness.correct} / {summary.evidence.correctness.responses}</dd>
        </div>
      {/if}
      {#if summary.evidence.selfRatings}
        <div>
          <dt>自己評価</dt>
          <dd>{summary.evidence.selfRatings.responses}問</dd>
        </div>
      {/if}
    </dl>
    <p class="result-configuration">フォーカス: {summary.configuration.focus}</p>
  {:else if summary.practice === "reading"}
    <dl class="result-metrics">
      <div>
        <dt>例文</dt>
        <dd>{summary.completedItems}文</dd>
      </div>
      <div>
        <dt>理解度記録</dt>
        <dd>{summary.evidence.comprehension.responses}件</dd>
      </div>
      <div>
        <dt>文法</dt>
        <dd>{summary.evidence.grammarTopics.length}項目</dd>
      </div>
    </dl>
    <p class="result-note">段階読みには客観正答がないため、正答率は表示しません。</p>
  {:else}
    <dl class="result-metrics">
      <div>
        <dt>完了</dt>
        <dd>{summary.completedItems}項目</dd>
      </div>
      <div>
        <dt>正解</dt>
        <dd>{summary.evidence.correctness.correct} / {summary.evidence.correctness.responses}</dd>
      </div>
      <div>
        <dt>理解度記録</dt>
        <dd>{summary.evidence.confidence.responses}件</dd>
      </div>
    </dl>
    {#if summary.evidence.grammarTopics.length > 0}
      <p class="result-configuration">
        {summary.evidence.grammarTopics.map(({ title }) => title).join(" · ")}
      </p>
    {/if}
  {/if}

  {#if summary.attentionItems.length > 0}
    <section class="result-attention">
      <h3>要確認</h3>
      <ul>
        {#each summary.attentionItems as item}
          <li>
            <span
              ><strong>{item.label}</strong>{#if item.detail}<small>{item.detail}</small>{/if}</span
            >
            <em>{item.reasons.join(" · ")}</em>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if summary.trend}
    <section class="result-trend" aria-label={summary.trend.label}>
      <h3>{summary.trend.label}</h3>
      <ol aria-label={summary.trend.values.map((value) => `${value}%`).join("、")}>
        {#each summary.trend.values as value}
          <li><span style={`--trend-value: ${value}%`}></span><small>{value}%</small></li>
        {/each}
      </ol>
    </section>
  {/if}
</article>
