<script lang="ts">
  const topology = [
    ["/", "Svelte SPA via Worker Static Assets"],
    ["/api/*", "Hono Worker API"],
    ["/mcp", "Reserved Worker boundary"],
  ] as const;
</script>

<svelte:head>
  <meta name="description" content="A durable, offline-ready personal Chinese-learning system." />
</svelte:head>

<main>
  <p class="eyebrow">Foundation slice</p>
  <h1>中文学习</h1>
  <p class="lede">
    Vocabulary, immutable attempt history, and deterministic FSRS scheduling are the first working
    layer.
  </p>

  <section aria-labelledby="topology-title">
    <h2 id="topology-title">Deployment topology</h2>
    <dl>
      {#each topology as [path, purpose]}
        <div>
          <dt><code>{path}</code></dt>
          <dd>{purpose}</dd>
        </div>
      {/each}
    </dl>
  </section>
</main>
