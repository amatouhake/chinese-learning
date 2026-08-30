<script lang="ts">
  import PronunciationPractice from "./PronunciationPractice.svelte";
  import VocabularyStudy from "./VocabularyStudy.svelte";

  type Surface = "study" | "pronunciation";
  let surface: Surface = surfaceFromHash();

  function surfaceFromHash(): Surface {
    return globalThis.location?.hash === "#pronunciation" ? "pronunciation" : "study";
  }

  function syncSurfaceFromHash(): void {
    surface = surfaceFromHash();
  }

  function selectSurface(value: Surface): void {
    surface = value;
    history.replaceState(null, "", value === "pronunciation" ? "#pronunciation" : "#study");
  }
</script>

<svelte:window onhashchange={syncSurfaceFromHash} />

<svelte:head>
  <meta
    name="description"
    content="Durable Chinese vocabulary and beginner pronunciation practice."
  />
</svelte:head>

<main>
  <header class="global-header">
    <div>
      <p class="eyebrow">Chinese learning</p>
      <h1>中文学习</h1>
    </div>
    <nav class="surface-nav" aria-label="Learning mode">
      <button class:active={surface === "study"} onclick={() => selectSurface("study")}
        >Study</button
      >
      <button
        class:active={surface === "pronunciation"}
        onclick={() => selectSurface("pronunciation")}>Pronunciation</button
      >
    </nav>
  </header>

  {#if surface === "study"}
    <VocabularyStudy />
  {:else}
    <PronunciationPractice />
  {/if}
</main>
