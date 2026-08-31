const SOUND_STORAGE_KEY = "chinese-learning.sound.v1";

type SoundListener = (enabled: boolean) => void;

const listeners = new Set<SoundListener>();
let enabled = readPreference();
let audioContext: AudioContext | null = null;

export function getSoundEnabled(): boolean {
  return enabled;
}

export function subscribeToSound(listener: SoundListener): () => void {
  listeners.add(listener);
  listener(enabled);
  return () => {
    listeners.delete(listener);
  };
}

export function toggleSound(): boolean {
  enabled = !enabled;
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Private browsing and blocked storage should not prevent practice.
  }
  for (const listener of listeners) listener(enabled);
  return enabled;
}

export function prepareSound(): void {
  if (!enabled) return;
  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === "suspended") void audioContext.resume();
  } catch {
    // Browser audio is an enhancement; the visual result remains complete.
  }
}

export function playAnswerFeedback(result: "correct" | "incorrect"): void {
  if (!enabled) return;
  prepareSound();
  if (!audioContext) return;

  const context = audioContext;
  const start = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.type = result === "correct" ? "sine" : "triangle";

  if (result === "correct") {
    oscillator.frequency.setValueAtTime(520, start);
    oscillator.frequency.linearRampToValueAtTime(780, start + 0.14);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    oscillator.start(start);
    oscillator.stop(start + 0.19);
    return;
  }

  oscillator.frequency.setValueAtTime(230, start);
  oscillator.frequency.linearRampToValueAtTime(165, start + 0.16);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
  oscillator.start(start);
  oscillator.stop(start + 0.21);
}

export async function playPronunciationAudio(url: string): Promise<boolean> {
  if (!enabled) return false;
  try {
    const audio = new Audio(url);
    audio.preload = "auto";
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

function readPreference(): boolean {
  try {
    return localStorage.getItem(SOUND_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}
