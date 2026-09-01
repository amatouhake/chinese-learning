import type { StudyDirection } from "../domain/types";
import type { StorageLike } from "./study-storage";

const STUDY_PREFERENCES_KEY = "chinese-learning.study-preferences.v1";

export type StudySessionSize = 5 | 10 | 20;

export interface StudyPreferences {
  direction: StudyDirection;
  size: StudySessionSize;
}

export const DEFAULT_STUDY_PREFERENCES: StudyPreferences = {
  direction: "mixed",
  size: 10,
};

export function readStudyPreferences(storage: StorageLike = localStorage): StudyPreferences {
  try {
    const stored = storage.getItem(STUDY_PREFERENCES_KEY);
    if (stored === null) return DEFAULT_STUDY_PREFERENCES;
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value)) return DEFAULT_STUDY_PREFERENCES;
    return {
      direction: isStudyDirection(value.direction) ? value.direction : "mixed",
      size: isStudySessionSize(value.size) ? value.size : 10,
    };
  } catch {
    return DEFAULT_STUDY_PREFERENCES;
  }
}

export function writeStudyPreferences(
  preferences: StudyPreferences,
  storage: StorageLike = localStorage,
): void {
  try {
    storage.setItem(STUDY_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Preference persistence is helpful, but never blocks practice.
  }
}

function isStudyDirection(value: unknown): value is StudyDirection {
  return value === "mixed" || value === "hanzi_to_meaning" || value === "meaning_to_hanzi";
}

function isStudySessionSize(value: unknown): value is StudySessionSize {
  return value === 5 || value === 10 || value === 20;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
