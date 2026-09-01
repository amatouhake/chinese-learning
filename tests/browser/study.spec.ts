import { expect, test, type Page } from "@playwright/test";

import type { AttemptInput } from "../../src/domain/types";

const DB_NAME = "chinese-learning.offline.v1";

test.describe("単語練習の毎日使う操作", () => {
  test.describe.configure({ timeout: 60_000 });

  test("次のセッションの方向と枚数を保存し、サーバーの文脈に記録する", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#study");
    await expect(page.getByRole("button", { name: "日本語 → 漢字" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "日本語 → 漢字" }).click();
    await page.locator(".size-options button").filter({ hasText: "20" }).click();
    const sessionRequest = page.waitForRequest(
      (request) => request.url().endsWith("/api/study/sessions") && request.method() === "POST",
    );
    await page.getByRole("button", { name: /練習を始める/ }).click();
    const body = (await (await sessionRequest).postDataJSON()) as {
      direction: string;
      maxCards: number;
    };
    expect(body).toMatchObject({ direction: "meaning_to_hanzi", maxCards: 20 });
    await expect(page.locator(".study-card")).toHaveAttribute("aria-busy", "false", {
      timeout: 20_000,
    });
    await expect(page.locator(".prompt-instruction")).toHaveText("漢字を思い出す");
    await expect(
      page.evaluate(() => localStorage.getItem("chinese-learning.study-preferences.v1")),
    ).resolves.toBe(JSON.stringify({ direction: "meaning_to_hanzi", size: 20 }));
  });

  test("回答はローカル保存後すぐ次へ進み、主要2択のFSRS評価を正確に記録する", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#study");
    await startStudy(page);
    await context.setOffline(true);

    const firstCardId = await page.locator(".study-card").getAttribute("data-card-id");
    await page.getByRole("button", { name: "答えを見る" }).click();
    await page.getByRole("button", { name: /忘れた/ }).click();
    await expect(page.getByRole("button", { name: "答えを見る" })).toBeVisible();
    const firstQueued = await readOutbox(page);
    expect(firstQueued.at(-1)?.fsrsReview?.rating).toBe(1);

    const secondCardId = await page.locator(".study-card").getAttribute("data-card-id");
    expect(secondCardId).not.toBe(firstCardId);
    await page.getByRole("button", { name: "答えを見る" }).click();
    await page.getByRole("button", { name: /思い出せた/ }).click();
    await expect(page.getByRole("button", { name: "答えを見る" })).toBeVisible();
    const queued = await readOutbox(page);
    expect(queued.slice(-2).map((attempt) => attempt.fsrsReview?.rating)).toEqual([1, 3]);
  });

  test("5枚のオフライン完了レビューは再読み込み後も残る", async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#study");
    await expect(page.getByRole("button", { name: "5" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "5" }).click();
    await page.getByRole("button", { name: /練習を始める/ }).click();
    await expect(page.getByRole("button", { name: "答えを見る" })).toBeVisible({
      timeout: 20_000,
    });
    const sessionId = (await readMeta(page)).activeSessionId;
    expect(typeof sessionId).toBe("string");
    await context.setOffline(true);

    for (let index = 0; index < 5; index += 1) {
      await page.getByRole("button", { name: "答えを見る" }).click();
      await page.getByRole("button", { name: /思い出せた/ }).click();
      if (index < 4) await expect(page.getByRole("button", { name: "答えを見る" })).toBeVisible();
    }

    await expect(page.getByRole("heading", { name: "単語練習を完了" })).toBeVisible();
    await expect(page.getByText("5枚を確認しました")).toBeVisible();
    await expect(page.locator(".study-review-list li")).toHaveCount(5);
    await page.reload();
    await expect(page.getByRole("heading", { name: "単語練習を完了" })).toBeVisible();
    await expect(page.locator(".study-review-list li")).toHaveCount(5);
    await expect(page.getByText("5枚を確認しました")).toBeVisible();

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const resultList = page.locator(".study-review-list");
      await expect(resultList).toBeVisible();
      await expect
        .poll(() =>
          resultList.evaluate((element) => {
            const style = getComputedStyle(element);
            return { overflowY: style.overflowY, maxHeight: style.maxHeight };
          }),
        )
        .toEqual({ overflowY: "visible", maxHeight: "none" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expect(page.getByRole("button", { name: "設定を変える" })).toBeVisible();
    }

    await page.getByRole("button", { name: "設定を変える" }).click();
    await expect(page.getByRole("heading", { name: "今日の単語練習" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "単語練習を完了" })).toHaveCount(0);
    expect((await readMeta(page)).activeSessionId).toBe(sessionId);
    await page.reload();
    await expect(page.getByRole("heading", { name: "今日の単語練習" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "単語練習を完了" })).toHaveCount(0);
    expect((await readMeta(page)).activeSessionId).toBe(sessionId);

    await context.setOffline(false);
    await page.getByRole("button", { name: /練習を始める/ }).click();
    await expect(page.getByRole("button", { name: "答えを見る" })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("ネットワーク同期が遅くても、耐久化後は保存画面を挟まず進む", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#study");
    await startStudy(page);
    await page.route("**/api/attempts", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.continue();
    });

    const firstCardId = await page.locator(".study-card").getAttribute("data-card-id");
    await page.getByRole("button", { name: "答えを見る" }).click();
    await page.getByRole("button", { name: /思い出せた/ }).click();
    await expect
      .poll(() => page.locator(".study-card").getAttribute("data-card-id"), {
        timeout: 700,
        intervals: [20, 40, 80],
      })
      .not.toBe(firstCardId);
    await expect(page.locator(".status-panel")).toHaveCount(0);
    await expect(page.locator(".study-card")).toBeVisible();
  });
});

async function startStudy(page: Page): Promise<void> {
  await expect(page.locator(".study-launcher, .study-card, .status-panel")).toBeVisible({
    timeout: 20_000,
  });
  const chooser = page.getByRole("button", { name: "練習を始める" });
  if (await chooser.isVisible()) await chooser.click();
  await expect(page.getByRole("button", { name: "答えを見る" })).toBeVisible({
    timeout: 20_000,
  });
}

function readOutbox(page: Page): Promise<AttemptInput[]> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return await new Promise<AttemptInput[]>((resolve, reject) => {
      const request = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () =>
        resolve(
          (request.result as AttemptInput[]).sort(
            (left, right) => left.deviceSeq - right.deviceSeq,
          ),
        );
    });
  }, DB_NAME);
}

function readMeta(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = db.transaction("meta", "readonly").objectStore("meta").get("state");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }, DB_NAME);
}
