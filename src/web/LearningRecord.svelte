<script lang="ts">
  import PracticeHistory from "./PracticeHistory.svelte";
  import ProgressDashboard from "./ProgressDashboard.svelte";

  let tab: "history" | "progress" = "history";
</script>

<div class="record-shell">
  <header class="record-header">
    <div>
      <h2>記録</h2>
      <p>最近のセットと、積み上がった学習状態を分けて確認します。</p>
    </div>
    <nav aria-label="記録の表示">
      <button
        class:active={tab === "history"}
        aria-pressed={tab === "history"}
        onclick={() => (tab = "history")}>最近の練習</button
      >
      <button
        class:active={tab === "progress"}
        aria-pressed={tab === "progress"}
        onclick={() => (tab = "progress")}>長期の進捗</button
      >
    </nav>
  </header>
  {#if tab === "history"}<PracticeHistory />{:else}<ProgressDashboard />{/if}
</div>
