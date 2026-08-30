import { expect, test, type Page, type Response } from "@playwright/test";

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
    const audioResponses: Response[] = [];
    const vocabularyRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (
        response.url().includes("/api/pronunciation/sessions/") &&
        response.url().endsWith("/next")
      ) {
        nextResponses.push(recordCard(response, observedCards));
      }
      if (response.url().includes("/media/audio-cmn/")) audioResponses.push(response);
    });
    page.on("request", (request) => {
      if (request.url().includes("/api/study/")) vocabularyRequests.push(request.url());
    });

    await page.goto("/#pronunciation");
    await page.getByRole("button", { name: "Mixed practice" }).click();

    for (let item = 0; item < 10; item += 1) {
      const activity = await page.locator(".card-meta span").nth(1).textContent();
      if (activity?.startsWith("Audio")) {
        await page.getByRole("button", { name: "Play or replay word audio" }).click();
      }
      const choices = page.locator(".choice-grid button");
      if ((await choices.count()) > 0) {
        await choices.first().click();
      } else if (activity === "Pronunciation production") {
        await page.getByRole("button", { name: "I said it — compare" }).click();
        await page.getByRole("button", { name: /^Good/ }).click();
      } else {
        await page.getByRole("button", { name: "Reveal pinyin" }).click();
        await page.getByRole("button", { name: "Got it" }).click();
      }
      await page.getByRole("button", { name: "Continue" }).click();
    }

    await expect(page.getByRole("heading", { name: "Pronunciation set complete" })).toBeVisible();
    await Promise.all(nextResponses);
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
    await page.getByRole("button", { name: /^Tones / }).click();

    await expect(page.getByText("Tone identification", { exact: true })).toBeVisible();
    await page.locator(".choice-grid button").first().click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Tone pair", { exact: true })).toBeVisible();
    await expect(page.locator(".pair-grid button")).toHaveCount(25);
    await page.getByText("Quick pinyin & tone reference").click();
    await expect(page.getByRole("heading", { name: "Initials" })).toBeVisible();
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
    await page.getByRole("button", { name: /^Tones / }).click();
    await expect(page.getByRole("alert")).toContainText("simulated session creation failure");
    await page.getByRole("button", { name: "Try again" }).click();

    await expect(page.getByText("Tone identification", { exact: true })).toBeVisible();
    expect(sessionRequests).toHaveLength(2);
    expect(sessionRequests[1]).toEqual(sessionRequests[0]);
    expect(sessionRequests[1]?.focus).toBe("tones");
    expect(
      await page.evaluate(() => {
        const state = JSON.parse(
          localStorage.getItem("chinese-learning.study-browser.v1") ?? "null",
        ) as { activePronunciationFocus?: unknown } | null;
        return state?.activePronunciationFocus;
      }),
    ).toBe("tones");
  });
});

async function recordCard(response: Response, cards: ObservedCard[]): Promise<void> {
  const payload = (await response.json()) as {
    card: null | {
      activityType: string;
      lexeme: { simplified: string };
      reading: { pinyin: string };
      media: null | { url: string };
    };
  };
  if (!payload.card) return;
  cards.push({
    activityType: payload.card.activityType,
    simplified: payload.card.lexeme.simplified,
    pinyin: payload.card.reading.pinyin,
    mediaUrl: payload.card.media?.url ?? null,
  });
}
