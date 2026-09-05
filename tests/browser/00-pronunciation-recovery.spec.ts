import { expect, test } from "@playwright/test";

test("uses recovered exact-reading audio without borrowing its sibling", async ({ page }) => {
  await page.goto("/#pronunciation");
  const pullResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/sync/pull") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^聞き取り /u }).click();

  const payload = (await (await pullResponse).json()) as {
    pronunciationPack: null | {
      cards: Array<{
        activityType: string;
        lexeme: { simplified: string };
        reading: { numericPinyin: string };
        media: null | { url: string };
      }>;
    };
  };
  const recoveredCards = (payload.pronunciationPack?.cards ?? []).filter(
    ({ lexeme }) => lexeme.simplified === "的",
  );
  expect(recoveredCards).toHaveLength(1);
  expect(recoveredCards[0]).toMatchObject({
    reading: { numericPinyin: "de5" },
    media: { url: expect.stringContaining("/media/audio-cmn/") },
  });
  expect(["audio_to_hanzi", "audio_to_meaning"]).toContain(recoveredCards[0]?.activityType);
  await expect(page.locator(".pronunciation-card")).toHaveAttribute("data-phase", "prompt");
  await expect(page.getByRole("button", { name: "単語の音声を再生・聞き直す" })).toBeEnabled();

  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator(".pronunciation-card")).toHaveAttribute("data-phase", "prompt");
  await expect(page.getByRole("button", { name: "単語の音声を再生・聞き直す" })).toBeEnabled();
  await expect(page.locator(".audio-error")).toHaveCount(0);
});
