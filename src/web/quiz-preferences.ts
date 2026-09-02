import type { QuizActivity, QuizChoiceCount } from "../domain/types";
import type { StorageLike } from "./study-storage";

const QUIZ_PREFERENCES_KEY = "chinese-learning.quiz-preferences.v1";

export type QuizSessionSize = 8 | 12 | 20;

export interface QuizPreferences {
  activityType: QuizActivity;
  choiceCount: QuizChoiceCount;
  size: QuizSessionSize;
}

export const DEFAULT_QUIZ_PREFERENCES: QuizPreferences = {
  activityType: "mixed",
  choiceCount: 4,
  size: 12,
};

export function readQuizPreferences(storage: StorageLike = localStorage): QuizPreferences {
  try {
    const value: unknown = JSON.parse(storage.getItem(QUIZ_PREFERENCES_KEY) ?? "null");
    if (!isRecord(value)) return DEFAULT_QUIZ_PREFERENCES;
    return {
      activityType: isActivity(value.activityType) ? value.activityType : "mixed",
      choiceCount: value.choiceCount === 9 ? 9 : 4,
      size: value.size === 8 || value.size === 20 ? value.size : 12,
    };
  } catch {
    return DEFAULT_QUIZ_PREFERENCES;
  }
}

export function writeQuizPreferences(
  preferences: QuizPreferences,
  storage: StorageLike = localStorage,
): void {
  try {
    storage.setItem(QUIZ_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // A preference is convenient; failure must not block an already prepared session.
  }
}

function isActivity(value: unknown): value is QuizActivity {
  return (
    value === "mixed" ||
    value === "hanzi_to_meaning" ||
    value === "meaning_to_hanzi" ||
    value === "hanzi_to_pinyin" ||
    value === "pinyin_to_hanzi"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
