<script lang="ts">
  import { PRACTICE_CATALOG } from "../domain/practice-catalog";
  import type { PracticeSessionSummary } from "../domain/types";
  import { activityTypeLabel, pronunciationFocusLabel, studyDirectionLabel } from "./ui-copy";

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

  function completionUnit(): string {
    if (summary.practice === "vocabulary_review") return "枚";
    if (summary.practice === "reading") return "文";
    return "問";
  }
</script>

<article class="practice-result" data-practice={summary.practice}>
  <header class="result-heading">
    <div>
      <h2>{summary.completedItems}{completionUnit()}完了</h2>
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

  {#if summary.evidenceCoverage?.status === "partial"}
    <p class="result-note" role="status">
      完了数は保存されています。内訳はこの端末に残る {summary.evidenceCoverage.recordedItems} / {summary.completedItems}件分で、同期後に全体へ更新されます。
    </p>
  {/if}

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
          <dt>正解</dt>
          <dd>{summary.evidence.correctness.correct} / {summary.evidence.correctness.responses}</dd>
        </div>
      {/if}
    </dl>
    {#if summary.evidence.selfReportedRecall}
      <section class="result-evidence" aria-label="自己申告の想起">
        <h3>自己申告の想起</h3>
        <dl class="result-metrics">
          <div>
            <dt>思い出せた</dt>
            <dd>
              {summary.evidence.selfReportedRecall.remembered} / {summary.evidence
                .selfReportedRecall.responses}
            </dd>
          </div>
        </dl>
        <p class="result-note">漢字→ピンインの自己確認です。客観的な発音正答率ではありません。</p>
      </section>
    {/if}
    {#if summary.evidence.selfRatings}
      <section class="result-evidence" aria-label="過去の発話自己評価">
        <h3>過去の発話自己評価</h3>
        <dl class="result-metrics rating-metrics">
          <div>
            <dt>もう一度</dt>
            <dd>{summary.evidence.selfRatings.distribution[1]}</dd>
          </div>
          <div>
            <dt>だいたい</dt>
            <dd>{summary.evidence.selfRatings.distribution[2]}</dd>
          </div>
          <div>
            <dt>できた</dt>
            <dd>{summary.evidence.selfRatings.distribution[3]}</dd>
          </div>
          <div>
            <dt>明瞭</dt>
            <dd>{summary.evidence.selfRatings.distribution[4]}</dd>
          </div>
        </dl>
        <p class="result-note">
          これは旧式の発話自己評価の履歴です。新しい発話練習は評価を求めません。
        </p>
      </section>
    {/if}
    <p class="result-configuration">
      フォーカス: {pronunciationFocusLabel(summary.configuration.focus)}
    </p>
  {:else if summary.practice === "reading"}
    {#if summary.evidence.comprehension}
      <section class="result-evidence" aria-label="過去の理解度評価の内訳">
        <h3>過去の理解度評価</h3>
        <dl class="result-metrics rating-metrics">
          <div>
            <dt>読み直す</dt>
            <dd>{summary.evidence.comprehension.distribution[1]}</dd>
          </div>
          <div>
            <dt>手がかり</dt>
            <dd>{summary.evidence.comprehension.distribution[2]}</dd>
          </div>
          <div>
            <dt>だいたい</dt>
            <dd>{summary.evidence.comprehension.distribution[3]}</dd>
          </div>
          <div>
            <dt>理解した</dt>
            <dd>{summary.evidence.comprehension.distribution[4]}</dd>
          </div>
        </dl>
        <p class="result-note">これは旧式の読解評価の履歴です。</p>
      </section>
    {/if}
    {#if summary.evidence.grammarTopics.length > 0}
      <p class="result-configuration">
        文法: {summary.evidence.grammarTopics.map(({ title }) => title).join(" · ")}
      </p>
    {/if}
    <p class="result-note">段階読みは完了のみを記録します。正答率や新しい評価はありません。</p>
  {:else}
    <dl class="result-metrics">
      <div>
        <dt>正解</dt>
        <dd>{summary.evidence.correctness.correct} / {summary.evidence.correctness.responses}</dd>
      </div>
    </dl>
    {#if summary.evidence.confidence}
      <section class="result-evidence" aria-label="過去の文法自信度の内訳">
        <h3>過去の文法自信度</h3>
        <dl class="result-metrics rating-metrics">
          <div>
            <dt>忘れた</dt>
            <dd>{summary.evidence.confidence.distribution[1]}</dd>
          </div>
          <div>
            <dt>手がかり</dt>
            <dd>{summary.evidence.confidence.distribution[2]}</dd>
          </div>
          <div>
            <dt>だいたい</dt>
            <dd>{summary.evidence.confidence.distribution[3]}</dd>
          </div>
          <div>
            <dt>理解した</dt>
            <dd>{summary.evidence.confidence.distribution[4]}</dd>
          </div>
        </dl>
        <p class="result-note">これは旧式の文法自信度の履歴です。</p>
      </section>
    {/if}
    {#if summary.evidence.grammarTopics.length > 0}
      <p class="result-configuration">
        {summary.evidence.grammarTopics.map(({ title }) => title).join(" · ")}
      </p>
    {/if}
    <p class="result-note">新しい文法練習は、選択問題の客観的な正誤だけを記録します。</p>
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
