<script lang="ts">
  import { onMount } from "svelte";

  import PronunciationPractice from "./PronunciationPractice.svelte";
  import ProgressDashboard from "./ProgressDashboard.svelte";
  import ReflexPractice from "./ReflexPractice.svelte";
  import ReadingGrammar from "./ReadingGrammar.svelte";
  import { getSoundEnabled, subscribeToSound, toggleSound } from "./sound";
  import VocabularyStudy from "./VocabularyStudy.svelte";

  type Surface = "progress" | "study" | "reflex" | "pronunciation" | "reading";
  let surface: Surface = surfaceFromHash();
  let soundEnabled = getSoundEnabled();

  onMount(() => subscribeToSound((value) => (soundEnabled = value)));

  function surfaceFromHash(): Surface {
    if (globalThis.location?.hash === "#progress") return "progress";
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
    <a class="brand-lockup" href="#study" onclick={() => selectSurface("study")}>
      <span class="brand-seal" aria-hidden="true">字</span>
      <span>
        <h1>中文学习</h1>
        <small>daily proof</small>
      </span>
    </a>
    <nav class="surface-nav" aria-label="Learning mode">
      <button class:active={surface === "study"} onclick={() => selectSurface("study")}>
        <svg aria-hidden="true" viewBox="0 0 20 20"
          ><path d="M4 3.5h8.8L16 6.7v9.8H4z" /><path d="M12.5 3.5v3.4H16M7 10h6M7 13h4" /></svg
        >
        <span>Study</span>
      </button>
      <button class:active={surface === "reflex"} onclick={() => selectSurface("reflex")}>
        <svg aria-hidden="true" viewBox="0 0 20 20"
          ><path d="M10 3.3a6.7 6.7 0 1 0 6.2 9.2" /><path
            d="M13.3 3.1h3.4v3.4M16.6 3.2 13 6.8"
          /></svg
        >
        <span>Reflex</span>
      </button>
      <button
        class:active={surface === "pronunciation"}
        onclick={() => selectSurface("pronunciation")}
        aria-label="Pronunciation"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20"
          ><path d="M3.5 8.1h3l3.3-2.8v9.4l-3.3-2.8h-3z" /><path
            d="M13 7a4.2 4.2 0 0 1 0 6M15.2 4.8a7.3 7.3 0 0 1 0 10.4"
          /></svg
        >
        <span>Speak</span>
      </button>
      <button class:active={surface === "reading"} onclick={() => selectSurface("reading")}>
        <svg aria-hidden="true" viewBox="0 0 20 20"
          ><path
            d="M3.5 4.2c2.4-.8 4.5-.4 6.5 1.2v10.3c-2-1.6-4.1-2-6.5-1.2zM16.5 4.2c-2.4-.8-4.5-.4-6.5 1.2v10.3c2-1.6 4.1-2 6.5-1.2z"
          /></svg
        >
        <span>Reading</span>
      </button>
      <button class:active={surface === "progress"} onclick={() => selectSurface("progress")}>
        <svg aria-hidden="true" viewBox="0 0 20 20"
          ><path d="M4 15.8V10M8 15.8V6.5M12 15.8V8.7M16 15.8V3.8" /></svg
        >
        <span>Progress</span>
      </button>
    </nav>
    <button
      class="sound-toggle"
      class:enabled={soundEnabled}
      onclick={toggleSound}
      aria-label={soundEnabled ? "Sound on" : "Sound off"}
      aria-pressed={soundEnabled}
      title={soundEnabled ? "Sound on" : "Sound off"}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20">
        <path d="M3.5 8.1h3l3.3-2.8v9.4l-3.3-2.8h-3z" />
        {#if soundEnabled}<path
            d="M13 7a4.2 4.2 0 0 1 0 6M15.2 4.8a7.3 7.3 0 0 1 0 10.4"
          />{:else}<path d="m13.2 8.2 3.2 3.2M16.4 8.2l-3.2 3.2" />{/if}
      </svg>
      <span>{soundEnabled ? "Sound" : "Muted"}</span>
    </button>
  </header>

  {#if surface === "progress"}
    <ProgressDashboard />
  {:else}
    <div class="learning-shell">
      {#if surface === "study"}
        <VocabularyStudy />
      {:else if surface === "reflex"}
        <ReflexPractice />
      {:else if surface === "pronunciation"}
        <PronunciationPractice />
      {:else}
        <ReadingGrammar />
      {/if}
    </div>
  {/if}
</main>
