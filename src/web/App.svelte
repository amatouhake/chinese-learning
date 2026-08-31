<script lang="ts">
  import { tick, onMount } from "svelte";

  import PronunciationPractice from "./PronunciationPractice.svelte";
  import ProgressDashboard from "./ProgressDashboard.svelte";
  import ReflexPractice from "./ReflexPractice.svelte";
  import ReadingGrammar from "./ReadingGrammar.svelte";
  import { getSoundEnabled, subscribeToSound, toggleSound } from "./sound";
  import { SURFACE_OPTIONS, surfaceLabel, type Surface } from "./ui-copy";
  import VocabularyStudy from "./VocabularyStudy.svelte";

  let surface: Surface = surfaceFromHash();
  let soundEnabled = getSoundEnabled();
  let modeMenuOpen = false;

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
    modeMenuOpen = false;
  }

  function selectSurface(value: Surface): void {
    surface = value;
    modeMenuOpen = false;
    history.replaceState(null, "", `#${value}`);
  }

  async function toggleModeMenu(): Promise<void> {
    modeMenuOpen = !modeMenuOpen;
    if (modeMenuOpen) {
      await tick();
      focusCurrentMode();
    }
  }

  function focusCurrentMode(): void {
    document.querySelector<HTMLElement>("#mobile-mode-menu [aria-checked='true']")?.focus();
  }

  function selectSurfaceFromMenu(value: Surface): void {
    selectSurface(value);
    void tick().then(() =>
      document.querySelector<HTMLButtonElement>("#mobile-mode-trigger")?.focus(),
    );
  }

  function handleWindowPointerdown(event: PointerEvent): void {
    if (!modeMenuOpen) return;
    const target = event.target;
    if (target instanceof Element && !target.closest(".mobile-mode-switcher")) {
      modeMenuOpen = false;
    }
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && modeMenuOpen) {
      event.preventDefault();
      modeMenuOpen = false;
      document.querySelector<HTMLButtonElement>("#mobile-mode-trigger")?.focus();
      return;
    }
    if (!modeMenuOpen) return;
    const items = Array.from(
      document.querySelectorAll<HTMLElement>("#mobile-mode-menu [role='menuitemradio']"),
    );
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      event.key === "ArrowDown"
        ? (currentIndex + 1 + items.length) % items.length
        : event.key === "ArrowUp"
          ? (currentIndex - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : -1;
    if (nextIndex >= 0) {
      event.preventDefault();
      items[nextIndex]?.focus();
    }
  }
</script>

<svelte:window
  onhashchange={syncSurfaceFromHash}
  onpointerdown={handleWindowPointerdown}
  onkeydown={handleWindowKeydown}
/>

<svelte:head>
  <meta
    name="description"
    content="中国語の単語、発音、例文読解、初級文法を毎日練習するためのPWA。"
  />
</svelte:head>

<main>
  <header class="global-header">
    <a class="brand-lockup" href="#study" onclick={() => selectSurface("study")}>
      <span class="brand-seal" aria-hidden="true">字</span>
      <span>
        <h1>中文学习</h1>
        <small>毎日の練習</small>
      </span>
    </a>
    <div class="mobile-mode-switcher">
      <button
        id="mobile-mode-trigger"
        class="mobile-mode-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={modeMenuOpen}
        aria-controls="mobile-mode-menu"
        aria-label={`学習モード: ${surfaceLabel(surface)}`}
        title="学習モードを切り替える"
        onclick={() => void toggleModeMenu()}
      >
        <span>{surfaceLabel(surface)}</span>
        <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5.5 7.5 4.5 4.5 4.5-4.5" /></svg>
      </button>
      {#if modeMenuOpen}
        <div id="mobile-mode-menu" class="mobile-mode-menu" role="menu" aria-label="学習モード">
          {#each SURFACE_OPTIONS as option}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={surface === option.value}
              tabindex={surface === option.value ? 0 : -1}
              class:active={surface === option.value}
              onclick={() => selectSurfaceFromMenu(option.value)}
            >
              <span>{option.label}</span>
              {#if surface === option.value}<svg aria-hidden="true" viewBox="0 0 20 20"
                  ><path d="m4.5 10.5 3.3 3.3 7.7-7.6" /></svg
                >{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <nav class="surface-nav" aria-label="学習モード">
      <button class:active={surface === "study"} onclick={() => selectSurface("study")}>
        <svg aria-hidden="true" viewBox="0 0 20 20"
          ><path d="M4 3.5h8.8L16 6.7v9.8H4z" /><path d="M12.5 3.5v3.4H16M7 10h6M7 13h4" /></svg
        >
        <span>単語</span>
      </button>
      <button class:active={surface === "reflex"} onclick={() => selectSurface("reflex")}>
        <svg aria-hidden="true" viewBox="0 0 20 20"
          ><path d="M10 3.3a6.7 6.7 0 1 0 6.2 9.2" /><path
            d="M13.3 3.1h3.4v3.4M16.6 3.2 13 6.8"
          /></svg
        >
        <span>瞬発</span>
      </button>
      <button
        class:active={surface === "pronunciation"}
        onclick={() => selectSurface("pronunciation")}
        aria-label="発音"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20"
          ><path d="M3.5 8.1h3l3.3-2.8v9.4l-3.3-2.8h-3z" /><path
            d="M13 7a4.2 4.2 0 0 1 0 6M15.2 4.8a7.3 7.3 0 0 1 0 10.4"
          /></svg
        >
        <span>発音</span>
      </button>
      <button class:active={surface === "reading"} onclick={() => selectSurface("reading")}>
        <svg aria-hidden="true" viewBox="0 0 20 20"
          ><path
            d="M3.5 4.2c2.4-.8 4.5-.4 6.5 1.2v10.3c-2-1.6-4.1-2-6.5-1.2zM16.5 4.2c-2.4-.8-4.5-.4-6.5 1.2v10.3c2-1.6 4.1-2 6.5-1.2z"
          /></svg
        >
        <span>読解</span>
      </button>
      <button class:active={surface === "progress"} onclick={() => selectSurface("progress")}>
        <svg aria-hidden="true" viewBox="0 0 20 20"
          ><path d="M4 15.8V10M8 15.8V6.5M12 15.8V8.7M16 15.8V3.8" /></svg
        >
        <span>進捗</span>
      </button>
    </nav>
    <button
      class="sound-toggle"
      class:enabled={soundEnabled}
      onclick={toggleSound}
      aria-label={soundEnabled ? "音声オン" : "音声オフ"}
      aria-pressed={soundEnabled}
      title={soundEnabled ? "音声オン" : "音声オフ"}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20">
        <path d="M3.5 8.1h3l3.3-2.8v9.4l-3.3-2.8h-3z" />
        {#if soundEnabled}<path
            d="M13 7a4.2 4.2 0 0 1 0 6M15.2 4.8a7.3 7.3 0 0 1 0 10.4"
          />{:else}<path d="m13.2 8.2 3.2 3.2M16.4 8.2l-3.2 3.2" />{/if}
      </svg>
      <span>{soundEnabled ? "音声" : "消音"}</span>
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
