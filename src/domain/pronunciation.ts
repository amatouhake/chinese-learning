import type { ActivityType } from "./types";

export const TONES = [1, 2, 3, 4, 5] as const;
export type Tone = (typeof TONES)[number];

export interface NormalizedSyllable {
  syllable: string;
  tone: Tone | null;
}

export const PRONUNCIATION_ACTIVITY_TYPES = [
  "hanzi_to_pinyin",
  "pinyin_to_hanzi",
  "audio_to_hanzi",
  "audio_to_meaning",
  "tone_identification",
  "tone_pair_identification",
  "pronunciation_production",
] as const satisfies readonly ActivityType[];

export type PronunciationActivityType = (typeof PRONUNCIATION_ACTIVITY_TYPES)[number];

export const PRONUNCIATION_FOCUSES = ["mixed", "pinyin", "tones", "listening", "speaking"] as const;

export type PronunciationFocus = (typeof PRONUNCIATION_FOCUSES)[number];

export type WordAudioMappingStatus = "reliable" | "ambiguous" | "missing";

export function normalizeNumericPinyin(numericPinyin: string): NormalizedSyllable[] {
  return numericPinyin
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .split(/[\s'’·-]+/u)
    .filter(Boolean)
    .map((token) => normalizeNumericSyllable(token));
}

export function deriveTonePair(syllables: readonly NormalizedSyllable[]): [Tone, Tone] | null {
  if (syllables.length !== 2) return null;
  const [first, second] = syllables;
  if (first?.tone === null || first?.tone === undefined) return null;
  if (second?.tone === null || second?.tone === undefined) return null;
  return [first.tone, second.tone];
}

export function singleTone(syllables: readonly NormalizedSyllable[]): Tone | null {
  if (syllables.length !== 1) return null;
  return syllables[0]?.tone ?? null;
}

export function untonedPinyin(syllables: readonly NormalizedSyllable[]): string {
  return syllables.map(({ syllable }) => displaySyllable(syllable)).join(" ");
}

export function classifyWordAudioMapping(
  fileExists: boolean,
  activeReadingCount: number,
): WordAudioMappingStatus {
  if (!fileExists) return "missing";
  return activeReadingCount === 1 ? "reliable" : "ambiguous";
}

export function isPronunciationActivity(
  activityType: ActivityType,
): activityType is PronunciationActivityType {
  return (PRONUNCIATION_ACTIVITY_TYPES as readonly string[]).includes(activityType);
}

export function activitiesForFocus(focus: PronunciationFocus): PronunciationActivityType[] {
  switch (focus) {
    case "pinyin":
      return ["hanzi_to_pinyin", "pinyin_to_hanzi"];
    case "tones":
      return ["tone_identification", "tone_pair_identification"];
    case "listening":
      return ["audio_to_hanzi", "audio_to_meaning"];
    case "speaking":
      return ["pronunciation_production"];
    case "mixed":
      return [...PRONUNCIATION_ACTIVITY_TYPES];
  }
}

function normalizeNumericSyllable(token: string): NormalizedSyllable {
  const match = /^(.*?)([0-5])$/u.exec(token);
  if (!match) return { syllable: normalizeSyllableSpelling(token), tone: null };

  const rawTone = Number(match[2]);
  const tone = (rawTone === 0 ? 5 : rawTone) as Tone;
  return {
    syllable: normalizeSyllableSpelling(match[1] ?? token),
    tone,
  };
}

function normalizeSyllableSpelling(value: string): string {
  return value.replaceAll("u:", "v").replaceAll("ü", "v");
}

function displaySyllable(value: string): string {
  return value.replaceAll("v", "ü");
}
