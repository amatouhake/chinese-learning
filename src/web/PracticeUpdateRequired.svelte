<script lang="ts">
  export let offline = false;
  export let pendingCount = 0;
  export let onRetry: () => void;
</script>

<section class="status-panel contract-update-panel" role="status" aria-live="polite">
  <p class="status-kicker">練習内容が更新されました</p>
  <h2>新しい形式を準備します</h2>
  <p>
    回答済みの内容は保存されています。{offline
      ? "オンラインに戻ると、新しい形式を準備します。"
      : "接続を確認して、新しい形式を準備します。"}
  </p>
  {#if pendingCount > 0}
    <p class="boundary-note">未同期の回答 {pendingCount} 件も保存されています。</p>
  {/if}
  <button class="primary-button" onclick={onRetry} disabled={offline}>
    {offline ? "オンラインで再準備" : "新しい形式を再準備"}
  </button>
</section>

<style>
  .contract-update-panel {
    max-width: 38rem;
    margin-inline: auto;
  }

  .contract-update-panel h2 {
    margin: 0;
    font-size: 1.35rem;
  }

  .contract-update-panel p {
    max-width: 32rem;
    margin-inline: auto;
    line-height: 1.7;
  }
</style>
