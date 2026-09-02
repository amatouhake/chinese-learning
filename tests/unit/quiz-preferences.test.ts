import { describe, expect, test } from "bun:test";

import {
  DEFAULT_QUIZ_PREFERENCES,
  readQuizPreferences,
  writeQuizPreferences,
} from "../../src/web/quiz-preferences";
import type { StorageLike } from "../../src/web/study-storage";

describe("Vocabulary Quiz preferences", () => {
  test("persists activity, choice count, and size only for future sessions", () => {
    const storage = new MemoryStorage();
    const selected = {
      activityType: "pinyin_to_hanzi" as const,
      choiceCount: 9 as const,
      size: 20 as const,
    };

    writeQuizPreferences(selected, storage);
    expect(readQuizPreferences(storage)).toEqual(selected);
  });

  test("fails soft to the documented defaults for malformed browser data", () => {
    const storage = new MemoryStorage();
    storage.setItem("chinese-learning.quiz-preferences.v1", "{broken");
    expect(readQuizPreferences(storage)).toEqual(DEFAULT_QUIZ_PREFERENCES);
    storage.setItem(
      "chinese-learning.quiz-preferences.v1",
      JSON.stringify({ activityType: "audio_to_meaning", choiceCount: 6, size: 99 }),
    );
    expect(readQuizPreferences(storage)).toEqual(DEFAULT_QUIZ_PREFERENCES);
  });
});

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
