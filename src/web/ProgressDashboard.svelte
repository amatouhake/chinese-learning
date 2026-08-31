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
      error = cause instanceof Error ? cause.message : "Progress could not be loaded.";
    } finally {
      loading = false;
    }
  }

  function formatDate(timestamp: number | null, timezone: string): string {
    if (timestamp === null) return "No learning events yet";
    return new Intl.DateTimeFormat("en", {
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
    return value === null ? "—" : `${(value / 1_000).toFixed(2)}s`;
  }

  function modeLabel(mode: PracticeMode): string {
    return mode === "study" ? "Vocabulary / FSRS" : mode[0]!.toUpperCase() + mode.slice(1);
  }

  function activityLabel(activity: ActivityType): string {
    const labels: Record<ActivityType, string> = {
      hanzi_to_meaning: "Hanzi → meaning",
      meaning_to_hanzi: "Meaning → Hanzi",
      hanzi_to_pinyin: "Hanzi → pinyin",
      pinyin_to_hanzi: "Pinyin → Hanzi",
      audio_to_hanzi: "Audio → Hanzi",
      audio_to_meaning: "Audio → meaning",
      tone_identification: "Single tone",
      tone_pair_identification: "Tone pair",
      pronunciation_production: "Pronunciation production",
      read_aloud: "Read aloud",
      sentence_reading: "Sentence reading",
    };
    return labels[activity];
  }

  function evidence(item: ProgressTroubleItem): string {
    const bits = [`${item.recentAttempts} recent attempt${item.recentAttempts === 1 ? "" : "s"}`];
    if (item.evidence.averageResponseMs !== undefined) {
      bits.push(`${formatLatency(item.evidence.averageResponseMs)} average`);
    }
    if (item.evidence.averageSelfRating !== undefined) {
      bits.push(`${formatRating(item.evidence.averageSelfRating)} average rating`);
    }
    return bits.join(" · ");
  }
</script>

<section class="progress-dashboard" aria-labelledby="progress-heading">
  <header class="dashboard-heading">
    <div>
      <p class="eyebrow">Local observability</p>
      <h2 id="progress-heading">Progress snapshot</h2>
      <p>Canonical learning history, summarized without changing it.</p>
    </div>
    <button class="refresh-button" onclick={loadSnapshot} disabled={loading}>Refresh</button>
  </header>

  {#if loading && !snapshot}
    <section class="status-panel dashboard-status" aria-live="polite">
      <div class="pulse"></div>
      <h2>Reading learning history…</h2>
      <p>Building a fresh local snapshot from D1.</p>
    </section>
  {:else if error && !snapshot}
    <section class="status-panel error-panel dashboard-status" role="alert">
      <p class="status-kicker">Snapshot unavailable</p>
      <h2>Progress could not be loaded</h2>
      <p>{error}</p>
      <button class="primary-button" onclick={loadSnapshot}>Try again</button>
    </section>
  {:else if snapshot}
    <div class="freshness-strip" aria-label="Snapshot freshness">
      <span><strong>Generated</strong> {formatDate(snapshot.generatedAt, snapshot.timezone)}</span>
      <span
        ><strong>Data through</strong>
        {formatDate(snapshot.dataThrough.changedAt, snapshot.timezone)}</span
      >
      <span><strong>Boundary</strong> seq {snapshot.dataThrough.serverSeq ?? "—"}</span>
      <span><strong>Projection</strong> v{snapshot.snapshotVersion}</span>
    </div>

    {#if error}
      <p class="inline-error" role="alert">
        Refresh failed; the previous snapshot remains visible. {error}
      </p>
    {/if}

    <div class="dashboard-grid dashboard-overview">
      <article class="dashboard-card attention-card">
        <p class="dashboard-kicker">Attention now</p>
        <h3>{snapshot.vocabulary.dueNow} due · {snapshot.vocabulary.new} new</h3>
        <p>
          {snapshot.troublesomeItems.length === 0
            ? "No recent trouble signals yet. Practice will make this view more useful."
            : `${snapshot.troublesomeItems.length} explainable weak or slow item${snapshot.troublesomeItems.length === 1 ? "" : "s"} surfaced below.`}
        </p>
      </article>

      <article class="dashboard-card">
        <p class="dashboard-kicker">Last 7 days</p>
        <div class="metric-row">
          <div>
            <strong>{snapshot.overall.last7Days.answeredAttempts}</strong><span>answers</span>
          </div>
          <div>
            <strong>{snapshot.overall.last7Days.activeDays}</strong><span>active days</span>
          </div>
          <div><strong>{snapshot.overall.last7Days.sessions}</strong><span>sessions</span></div>
        </div>
        <p class="metric-note">
          {snapshot.overall.last7Days.scheduledReviews} scheduled FSRS reviews · calendar days in
          {snapshot.timezone}
        </p>
      </article>
    </div>

    <section aria-labelledby="mode-progress-heading">
      <div class="section-heading">
        <div>
          <p class="dashboard-kicker">Last 30 days</p>
          <h3 id="mode-progress-heading">Learning modes</h3>
        </div>
        <span>{snapshot.overall.last30Days.answeredAttempts} answers</span>
      </div>

      <div class="dashboard-grid mode-progress-grid">
        <article class="dashboard-card mode-card-progress vocabulary-progress">
          <div class="mode-card-heading">
            <div>
              <p>Vocabulary</p>
              <h4>FSRS state</h4>
            </div>
            <strong>{snapshot.vocabulary.dueNow} due</strong>
          </div>
          <div class="compact-metrics">
            <span><strong>{snapshot.vocabulary.new}</strong> new</span>
            <span><strong>{snapshot.vocabulary.learning}</strong> learning</span>
            <span><strong>{snapshot.vocabulary.review}</strong> review</span>
          </div>
          <p class="mode-detail">
            {snapshot.vocabulary.recentScheduledReviews} scheduled reviews · ratings A {snapshot
              .vocabulary.recentRatings[1]} / H {snapshot.vocabulary.recentRatings[2]} / G
            {snapshot.vocabulary.recentRatings[3]} / E {snapshot.vocabulary.recentRatings[4]}
          </p>
        </article>

        <article class="dashboard-card mode-card-progress pronunciation-progress">
          <div class="mode-card-heading">
            <div>
              <p>Pronunciation</p>
              <h4>{snapshot.pronunciation.recentResponses} responses</h4>
            </div>
            {#if snapshot.pronunciation.recentSkips > 0}
              <strong>{snapshot.pronunciation.recentSkips} audio skips</strong>
            {/if}
          </div>
          <ul class="activity-summary-list">
            {#each snapshot.pronunciation.byActivity.filter((item) => item.responses > 0 || item.skips > 0) as activity (activity.activityType)}
              <li>
                <span>{activityLabel(activity.activityType)}</span>
                <strong>
                  {#if activity.correctness}
                    {formatPercent(activity.correctness)} recorded correctness
                  {:else if activity.selfRatings}
                    {formatRating(activity.selfRatings.average)} self-rating
                  {:else}
                    {activity.skips} skipped
                  {/if}
                </strong>
              </li>
            {:else}
              <li class="empty-list-item">No pronunciation responses in this window.</li>
            {/each}
          </ul>
        </article>

        <article class="dashboard-card mode-card-progress">
          <div class="mode-card-heading">
            <div>
              <p>Reading</p>
              <h4>{snapshot.reading.recentSentences} sentences</h4>
            </div>
            <strong>{formatRating(snapshot.reading.comprehension.average)}</strong>
          </div>
          <p class="mode-detail">
            {snapshot.reading.recentResponses} comprehension ratings · no objective correctness is inferred
          </p>
        </article>

        <article class="dashboard-card mode-card-progress">
          <div class="mode-card-heading">
            <div>
              <p>Grammar</p>
              <h4>{snapshot.grammar.topicCounts.comfortable} comfortable</h4>
            </div>
            <strong>{snapshot.grammar.topicCounts.learning} learning</strong>
          </div>
          <div class="dual-metric">
            <span
              ><strong>{formatPercent(snapshot.grammar.correctness)}</strong> recorded correctness</span
            >
            <span
              ><strong>{formatRating(snapshot.grammar.confidence.average)}</strong> confidence</span
            >
          </div>
          <p class="mode-detail">
            {snapshot.grammar.topicCounts.introduced} introduced ·
            {snapshot.grammar.topicCounts.notIntroduced} not introduced
          </p>
        </article>

        <article class="dashboard-card mode-card-progress reflex-progress">
          <div class="mode-card-heading">
            <div>
              <p>Reflex</p>
              <h4>{snapshot.reflex.recentResponses} responses</h4>
            </div>
            <strong>{formatLatency(snapshot.reflex.latency.averageResponseMs)} avg</strong>
          </div>
          <div class="dual-metric">
            <span
              ><strong>{formatPercent(snapshot.reflex.correctness)}</strong> recorded correctness</span
            >
            <span
              ><strong>{snapshot.reflex.latency.slowResponses}</strong> at or above
              {snapshot.reflex.latency.slowThresholdMs / 1_000}s</span
            >
          </div>
          <p class="mode-detail">
            Automaticity evidence only; this does not affect FSRS scheduling.
          </p>
        </article>
      </div>
    </section>

    <section aria-labelledby="trouble-heading">
      <div class="section-heading">
        <div>
          <p class="dashboard-kicker">Explainable signals</p>
          <h3 id="trouble-heading">Weak or slow material</h3>
        </div>
        <span>Up to 8 items</span>
      </div>

      {#if snapshot.troublesomeItems.length === 0}
        <article class="dashboard-card empty-dashboard-card">
          <h4>No trouble signals yet</h4>
          <p>
            Again/Hard reviews, errors, slow Reflex responses, and low confidence or self-ratings
            will appear here with their source preserved.
          </p>
        </article>
      {:else}
        <div class="trouble-list">
          {#each snapshot.troublesomeItems as item (item.id)}
            <article class="trouble-item">
              <div class="trouble-heading">
                <span class="mode-chip mode-{item.mode}">{modeLabel(item.mode)}</span>
                <span class="activity-chip">{activityLabel(item.activityType)}</span>
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
                <span>Last practiced {formatDate(item.lastPracticedAt, snapshot.timezone)}</span>
              </footer>
            </article>
          {/each}
        </div>
      {/if}
    </section>

    <p class="snapshot-boundary-note">
      Activity windows use semantic occurrence time. Freshness uses canonical server ingestion
      boundaries. Audio skips remain non-answer events, Reading has no inferred correctness, Grammar
      keeps correctness separate from confidence, and Reflex stays outside FSRS.
    </p>
  {/if}
</section>
