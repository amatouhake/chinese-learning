import { expect, test, type Response } from "@playwright/test";

import { seedLegacyCompletedSession } from "./offline-fixtures";

interface ObservedCard {
  activityType: string;
  simplified: string;
  pinyin: string;
  mediaUrl: string | null;
}

const EXPECTED_MIXED_ACTIVITIES = new Set([
  "hanzi_to_pinyin",
  "pinyin_to_hanzi",
  "audio_to_hanzi",
  "audio_to_meaning",
  "tone_identification",
  "tone_pair_identification",
  "pronunciation_production",
]);

test.describe("pronunciation dogfood", () => {
  test("phone session exercises every foundation activity with real media", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const consoleErrors: string[] = [];
    const observedCards: ObservedCard[] = [];
    const nextResponses: Promise<void>[] = [];
    let captureCards = true;
    const audioResponses: Response[] = [];
    const vocabularyRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (captureCards && response.url().endsWith("/api/sync/pull")) {
        nextResponses.push(recordCards(response, observedCards));
      }
      if (response.url().includes("/media/audio-cmn/")) audioResponses.push(response);
    });
    page.on("request", (request) => {
      if (request.url().includes("/api/study/")) vocabularyRequests.push(request.url());
    });

    await page.goto("/#pronunciation");
    await page.getByRole("button", { name: "おまかせ" }).click();

    for (let item = 0; item < 10; item += 1) {
      const activity = await page.locator(".card-meta span").nth(1).textContent();
      if (activity?.startsWith("音声")) {
        await page.getByRole("button", { name: "単語の音声を再生・聞き直す" }).click();
      }
      const choices = page.locator(".choice-grid button");
      if ((await choices.count()) > 0) {
        await choices.first().click();
      } else if (activity === "発音して確認") {
        await page.getByRole("button", { name: "発音した — 答えと比べる" }).click();
        await page.getByRole("button", { name: /できた/ }).click();
      } else {
        await page.getByRole("button", { name: "ピンインを見る" }).click();
        await page.getByRole("button", { name: "思い出せた" }).click();
      }
      await page.getByRole("button", { name: "次へ" }).click();
      if (item < 9) {
        await expect(page.locator(".pronunciation-card")).toHaveAttribute("data-phase", "prompt");
      }
    }

    await expect(page.getByRole("heading", { name: "10問完了" })).toBeVisible({
      timeout: 20_000,
    });
    await Promise.all(nextResponses);
    captureCards = false;
    await page.reload();
    await expect(page.getByRole("heading", { name: "10問完了" })).toBeVisible();
    expect(new Set(observedCards.map((card) => card.activityType))).toEqual(
      EXPECTED_MIXED_ACTIVITIES,
    );
    expect(new Set(observedCards.map((card) => card.simplified)).size).toBe(10);
    expect(observedCards.every((card) => card.pinyin.length > 0)).toBe(true);
    expect(
      observedCards
        .filter((card) => card.activityType.startsWith("audio_to_"))
        .every((card) => card.mediaUrl?.startsWith("/media/audio-cmn/")),
    ).toBe(true);
    expect(audioResponses.length).toBeGreaterThanOrEqual(2);
    expect(audioResponses.every((response) => response.ok())).toBe(true);
    expect(vocabularyRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("desktop tone practice exposes the complete tone-pair grid and reference", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/#pronunciation");
    await page.getByRole("button", { name: /^声調/ }).click();

    await expect(page.getByText("声調を聞き分ける", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.locator(".choice-grid button").first().click();
    await page.getByRole("button", { name: "次へ" }).click();
    await expect(page.getByText("声調の組み合わせ", { exact: true })).toBeVisible();
    await expect(page.locator(".pair-grid button")).toHaveCount(25);
    await page.getByText("ピンインと声調の早見表").click();
    await expect(page.getByRole("heading", { name: "声母" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("session creation retry preserves the selected pronunciation focus", async ({ page }) => {
    const sessionRequests: Array<{ sessionId: string; focus: string }> = [];
    await page.route("**/api/pronunciation/sessions", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      sessionRequests.push(route.request().postDataJSON());
      if (sessionRequests.length === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "simulated session creation failure" }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/#pronunciation");
    await page.getByRole("button", { name: /^声調/ }).click();
    await expect(page.getByRole("alert")).toContainText("simulated session creation failure");
    await page.getByRole("button", { name: "もう一度試す" }).click();

    await expect(page.getByText("声調を聞き分ける", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    expect(sessionRequests).toHaveLength(2);
    expect(sessionRequests[1]).toEqual(sessionRequests[0]);
    expect(sessionRequests[1]?.focus).toBe("tones");
    expect(
      await page.evaluate(() => {
        return new Promise<unknown>((resolve, reject) => {
          const request = indexedDB.open("chinese-learning.offline.v1", 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const transaction = request.result.transaction("meta", "readonly");
            const get = transaction.objectStore("meta").get("state");
            get.onerror = () => reject(get.error);
            get.onsuccess = () => resolve(get.result?.activePronunciationFocus);
          };
        });
      }),
    ).toBe("tones");
  });

  test("reopens a legacy completed result with zero cached answer detail", async ({ page }) => {
    await page.goto("/#pronunciation");
    await expect(page.getByRole("button", { name: "おまかせ" })).toBeVisible();
    await seedLegacyCompletedSession(page, "pronunciation", {
      id: "pronunciation:legacy-completed",
      deviceId: "device:legacy-completed",
      focus: "speaking",
      maxItems: 10,
      completedItems: 10,
      startedAt: Date.parse("2026-08-31T00:00:00Z"),
      endedAt: Date.parse("2026-08-31T00:10:00Z"),
    });

    for (let reload = 0; reload < 2; reload += 1) {
      await page.reload();
      await expect(page.getByRole("heading", { name: "10問完了" })).toBeVisible();
      await expect(page.getByRole("status")).toContainText("0 / 10件分");
    }
  });
});

async function recordCards(response: Response, cards: ObservedCard[]): Promise<void> {
  const payload = (await response.json()) as {
    pronunciationPack: null | {
      cards: Array<{
        activityType: string;
        lexeme: { simplified: string };
        reading: { pinyin: string };
        media: null | { url: string };
      }>;
    };
  };
  if (!payload.pronunciationPack || cards.length > 0) return;
  cards.push(
    ...payload.pronunciationPack.cards.map((card) => ({
      activityType: card.activityType,
      simplified: card.lexeme.simplified,
      pinyin: card.reading.pinyin,
      mediaUrl: card.media?.url ?? null,
    })),
  );
}
