<script lang="ts">
  import PronunciationPractice from "./PronunciationPractice.svelte";
  import ReflexPractice from "./ReflexPractice.svelte";
  import ReadingGrammar from "./ReadingGrammar.svelte";
  import VocabularyStudy from "./VocabularyStudy.svelte";

  type Surface = "study" | "reflex" | "pronunciation" | "reading";
  let surface: Surface = surfaceFromHash();

  function surfaceFromHash(): Surface {
    if (globalThis.location?.hash === "#pronunciation") return "pronunciation";
    if (globalThis.location?.hash === "#reflex") return "reflex";
    if (globalThis.location?.hash === "#reading") return "reading";
    return "study";
  }

  function syncSurfaceFromHash(): void {
    surface = surfaceFromHash();
  }

  function selectSurface(value: Surface): void {
    surface = value;
    history.replaceState(null, "", `#${value}`);
  }
</script>

<svelte:window onhashchange={syncSurfaceFromHash} />

<svelte:head>
  <meta
    name="description"
    content="Durable Chinese vocabulary, pronunciation, sentence reading, and beginner grammar practice."
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
      <button class:active={surface === "reflex"} onclick={() => selectSurface("reflex")}
        >Reflex</button
      >
      <button
        class:active={surface === "pronunciation"}
        onclick={() => selectSurface("pronunciation")}>Pronunciation</button
      >
      <button class:active={surface === "reading"} onclick={() => selectSurface("reading")}
        >Reading</button
      >
    </nav>
  </header>

  {#if surface === "study"}
    <VocabularyStudy />
  {:else if surface === "reflex"}
    <ReflexPractice />
  {:else if surface === "pronunciation"}
    <PronunciationPractice />
  {:else}
    <ReadingGrammar />
  {/if}
</main>
