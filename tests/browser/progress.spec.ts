import { expect, test } from "@playwright/test";

import type { ProgressSnapshot } from "../../src/domain/types";

test.describe("local progress dashboard dogfood", () => {
  test("renders the real local D1 snapshot without console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.setViewportSize({ width: 412, height: 915 });
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/progress") && response.request().method() === "POST",
    );
    await page.goto("/#progress");
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const payload = (await response.json()) as ProgressSnapshot;
    expect(payload.snapshotVersion).toBe(1);
    expect(payload.timezone).toBe("Asia/Tokyo");
    expect(payload.pronunciation.byActivity).toHaveLength(7);
    await expect(page.getByRole("heading", { name: "進捗" })).toBeVisible();
    await expect(page.locator(".mode-progress-grid .mode-card-progress")).toHaveCount(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(consoleErrors).toEqual([]);
  });

  test("keeps activity semantics legible without overflow at phone and desktop sizes", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.route("**/api/progress", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(snapshot),
      });
    });

    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto("/#progress");
    await expect(page.getByRole("heading", { name: "進捗" })).toBeVisible();
    await expect(page.getByText("復習 3 · 新規 17", { exact: true })).toBeVisible();
    await expect(page.getByText("正答率 50%", { exact: true })).toHaveCount(1);
    await expect(page.getByText("自己評価 2.8 / 4", { exact: true })).toBeVisible();
    await expect(page.getByText(/正誤は判定しません/)).toBeVisible();
    await expect(page.getByText(/自動化の記録のみ/)).toBeVisible();
    await expect(page.getByText("好", { exact: true })).toBeVisible();
    await expect(page.getByText(/2.5秒以上/)).toBeVisible();
    await expect(page.getByText(/集計は実際に練習した時刻/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const modeTrigger = page.locator("#mobile-mode-trigger");
    await expect(modeTrigger).toBeVisible();
    await expect(modeTrigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(modeTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".surface-nav")).toBeHidden();
    await modeTrigger.click();
    await expect(page.locator("#mobile-mode-menu")).toBeVisible();
    await expect(page.locator("#mobile-mode-menu [role='menuitemradio']")).toHaveCount(5);
    await expect(page.locator("#mobile-mode-menu [aria-checked='true']")).toHaveText("進捗");
    await expect(page.locator("#mobile-mode-menu [aria-checked='true']")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByRole("menuitemradio", { name: "単語" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: "瞬発" })).toBeFocused();
    const mobileMode = await modeTrigger.boundingBox();
    expect(mobileMode).not.toBeNull();
    expect(mobileMode!.x + mobileMode!.width).toBeLessThanOrEqual(320);
    const menu = await page.locator("#mobile-mode-menu").boundingBox();
    expect(menu).not.toBeNull();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(320);
    await page.keyboard.press("Escape");
    await expect(page.locator("#mobile-mode-menu")).toBeHidden();
    await expect(modeTrigger).toBeFocused();
    await modeTrigger.click();
    await page.mouse.click(8, 300);
    await expect(page.locator("#mobile-mode-menu")).toBeHidden();
    await modeTrigger.click();
    await page.getByRole("menuitemradio", { name: "発音" }).click();
    await expect(modeTrigger).toHaveText("発音");
    await modeTrigger.click();
    await page.getByRole("menuitemradio", { name: "進捗" }).click();
    await expect(page.getByRole("heading", { name: "進捗" })).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator(".mode-progress-grid .mode-card-progress")).toHaveCount(5);
    await expect(page.locator(".freshness-strip span")).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await page.getByRole("button", { name: "発音", exact: true }).click();
    await expect(page.getByRole("button", { name: "おまかせ" })).toBeVisible();
    await page.getByRole("button", { name: "進捗" }).click();
    await expect(page.getByRole("heading", { name: "進捗" })).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });
});

const snapshot: ProgressSnapshot = {
  snapshotVersion: 1,
  generatedAt: Date.parse("2026-08-31T11:30:00Z"),
  timezone: "Asia/Tokyo",
  dataThrough: {
    serverSeq: 248,
    changedAt: Date.parse("2026-08-31T11:29:00Z"),
    latestAttemptReceivedAt: Date.parse("2026-08-31T11:29:00Z"),
    latestAttemptOccurredAt: Date.parse("2026-08-31T11:28:30Z"),
  },
  overall: {
    last7Days: {
      days: 7,
      attempts: 38,
      answeredAttempts: 37,
      scheduledReviews: 12,
      activeDays: 4,
      sessions: 7,
      byMode: { study: 12, reflex: 10, pronunciation: 7, reading: 5, grammar: 4 },
    },
    last30Days: {
      days: 30,
      attempts: 101,
      answeredAttempts: 100,
      scheduledReviews: 42,
      activeDays: 14,
      sessions: 22,
      byMode: { study: 42, reflex: 24, pronunciation: 18, reading: 9, grammar: 8 },
    },
  },
  vocabulary: {
    totalScheduledCards: 1_190,
    dueNow: 3,
    new: 17,
    learning: 22,
    review: 1_148,
    recentScheduledReviews: 42,
    recentRatings: { 1: 3, 2: 6, 3: 30, 4: 3 },
    lastReviewedAt: Date.parse("2026-08-31T10:00:00Z"),
    troublesomeCards: [],
  },
  pronunciation: {
    recentResponses: 18,
    recentSkips: 1,
    byActivity: [
      pronunciationActivity("hanzi_to_pinyin", 6, {
        correctness: { responses: 6, correct: 5, rate: 0.833 },
      }),
      pronunciationActivity("pinyin_to_hanzi"),
      pronunciationActivity("audio_to_hanzi", 2, {
        skips: 1,
        correctness: { responses: 2, correct: 1, rate: 0.5 },
      }),
      pronunciationActivity("audio_to_meaning"),
      pronunciationActivity("tone_identification"),
      pronunciationActivity("tone_pair_identification"),
      pronunciationActivity("pronunciation_production", 10, {
        selfRatings: {
          responses: 10,
          average: 2.8,
          low: 3,
          distribution: { 1: 1, 2: 2, 3: 5, 4: 2 },
        },
      }),
    ],
    troublesomeItems: [],
  },
  reading: {
    recentResponses: 9,
    recentSentences: 5,
    comprehension: {
      responses: 9,
      average: 2.7,
      low: 3,
      distribution: { 1: 1, 2: 2, 3: 5, 4: 1 },
    },
    lastPracticedAt: Date.parse("2026-08-30T10:00:00Z"),
    difficultSentences: [],
  },
  grammar: {
    topicCounts: { total: 5, notIntroduced: 1, introduced: 1, learning: 2, comfortable: 1 },
    topics: [
      {
        id: "grammar:fixture",
        title: "是：名詞と名詞を結ぶ",
        status: "learning",
        confidence: 0.625,
        lastStudiedAt: Date.parse("2026-08-30T09:00:00Z"),
      },
    ],
    recentResponses: 8,
    correctness: { responses: 8, correct: 4, rate: 0.5 },
    confidence: {
      responses: 8,
      average: 2.6,
      low: 3,
      distribution: { 1: 1, 2: 2, 3: 4, 4: 1 },
    },
    lastPracticedAt: Date.parse("2026-08-30T09:00:00Z"),
    troublesomeTopics: [],
  },
  reflex: {
    recentResponses: 24,
    correctness: { responses: 24, correct: 12, rate: 0.5 },
    latency: { averageResponseMs: 2_180, slowResponses: 5, slowThresholdMs: 2_500 },
    lastPracticedAt: Date.parse("2026-08-31T11:28:30Z"),
    troublesomeItems: [],
  },
  troublesomeItems: [
    {
      id: "reflex:fixture-good",
      cardId: "fixture-good",
      mode: "reflex",
      activityType: "hanzi_to_meaning",
      label: "好",
      detail: "hǎo",
      recentAttempts: 4,
      lastPracticedAt: Date.parse("2026-08-31T11:28:30Z"),
      reasons: ["1 incorrect response recently", "1 response at or above 2.5s"],
      evidence: { errors: 1, slowResponses: 1, averageResponseMs: 2_650 },
    },
    {
      id: "reading:fixture-sentence",
      cardId: "fixture-sentence",
      mode: "reading",
      activityType: "sentence_reading",
      label: "你好吗？",
      detail: "Nǐ hǎo ma?",
      recentAttempts: 2,
      lastPracticedAt: Date.parse("2026-08-30T10:00:00Z"),
      reasons: ["2 low comprehension ratings"],
      evidence: { selfRatings: 2, averageSelfRating: 1.5 },
    },
  ],
};

function pronunciationActivity(
  activityType: ProgressSnapshot["pronunciation"]["byActivity"][number]["activityType"],
  responses = 0,
  overrides: Partial<ProgressSnapshot["pronunciation"]["byActivity"][number]> = {},
): ProgressSnapshot["pronunciation"]["byActivity"][number] {
  return {
    activityType,
    responses,
    skips: 0,
    distinctItems: responses,
    correctness: null,
    selfRatings: null,
    averageResponseMs: responses === 0 ? null : 1_400,
    lastPracticedAt: responses === 0 ? null : Date.parse("2026-08-31T10:00:00Z"),
    ...overrides,
  };
}
