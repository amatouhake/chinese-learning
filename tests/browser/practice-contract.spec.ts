import { expect, test, type Page } from "@playwright/test";

import type { AttemptInput } from "../../src/domain/types";

const DB_NAME = "chinese-learning.offline.v1";

test.describe("offline practice contract upgrades", () => {
  test.describe.configure({ timeout: 60_000 });

  test("blocks an unversioned production cache, preserves facts, and retries push-before-refresh", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#pronunciation");
    await page.getByRole("button", { name: "発話" }).click();
    await expect(page.locator(".pronunciation-card")).toHaveAttribute("data-phase", "prompt", {
      timeout: 20_000,
    });

    const sessionId = (await readMeta(page)).activePronunciationSessionId;
    expect(typeof sessionId).toBe("string");
    const answeredCardId = await page.locator(".pronunciation-card").getAttribute("data-card-id");
    await context.setOffline(true);
    await page.getByRole("button", { name: "発音した — 答えと比べる" }).click();
    await expect(page.getByRole("button", { name: "次へ" })).toBeVisible();
    await page.getByRole("button", { name: "次へ" }).click();
    await expect(page.locator(".pronunciation-card")).toHaveAttribute("data-phase", "prompt");

    const queuedBeforeMigration = await readOutbox(page);
    expect(queuedBeforeMigration).toHaveLength(1);
    await seedLegacyProductionCache(page, sessionId as string);
    const queuedLegacy = await readOutbox(page);

    await page.reload();
    await expect(page.getByText("練習内容が更新されました", { exact: true })).toBeVisible();
    await expect(page.locator(".pronunciation-card")).toHaveCount(0);
    await expect(page.locator(".choice-grid")).toHaveCount(0);
    expect(await readOutbox(page)).toEqual(queuedLegacy);
    expect((await readMeta(page)).practiceContractVersions).toMatchObject({ pronunciation: 1 });
    expect(await cachedPronunciationCardCount(page, sessionId as string)).toBeGreaterThan(0);
    expect(await cachedPronunciationProgress(page, sessionId as string)).toBe(1);

    let failedPush = true;
    await page.route("**/api/attempts", async (route) => {
      if (failedPush) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "simulated legacy push failure" }),
        });
        return;
      }
      await route.continue();
    });
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => readOutbox(page)).toEqual(queuedLegacy);
    await expect(page.getByText("練習内容が更新されました", { exact: true })).toBeVisible();
    expect((await readMeta(page)).practiceContractVersions).toMatchObject({ pronunciation: 1 });
    await expect(page.locator(".pronunciation-card")).toHaveCount(0);
    expect(await cachedPronunciationCardCount(page, sessionId as string)).toBeGreaterThan(0);

    failedPush = false;
    let withheldRefresh = true;
    await page.route("**/api/sync/pull", async (route) => {
      if (!withheldRefresh) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          pronunciationPack: null,
          practiceUpdateRequiredModes: ["pronunciation"],
        },
      });
      withheldRefresh = false;
    });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => readOutbox(page), { timeout: 20_000 }).toHaveLength(0);
    expect((await readMeta(page)).practiceContractVersions).toMatchObject({ pronunciation: 1 });
    await expect(page.getByText("練習内容が更新されました", { exact: true })).toBeVisible();
    await expect(page.locator(".pronunciation-card")).toHaveCount(0);
    expect(await cachedPronunciationCardCount(page, sessionId as string)).toBeGreaterThan(0);

    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".pronunciation-card")).toHaveAttribute("data-phase", "prompt", {
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: "発音した — 答えと比べる" })).toBeVisible();
    expect(await page.locator(`[data-card-id="${answeredCardId}"]`).count()).toBe(0);
    expect((await readMeta(page)).practiceContractVersions).toMatchObject({ pronunciation: 2 });
    await expect(page.getByText("練習内容が更新されました", { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.locator(".pronunciation-card")).toHaveAttribute("data-phase", "prompt", {
      timeout: 20_000,
    });
    await expect(page.getByText("練習内容が更新されました", { exact: true })).toHaveCount(0);
  });

  test("keeps stale prepared rows for an already-running tab until replacement", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#pronunciation");
    await page.getByRole("button", { name: "発話" }).click();
    await expect(page.locator(".pronunciation-card")).toHaveAttribute("data-phase", "prompt", {
      timeout: 20_000,
    });

    const sessionId = (await readMeta(page)).activePronunciationSessionId;
    expect(typeof sessionId).toBe("string");
    const newTab = await context.newPage();
    try {
      await newTab.goto("/#pronunciation");
      await context.setOffline(true);
      await seedLegacyProductionCache(newTab, sessionId as string);

      await newTab.reload();
      await expect(newTab.getByText("練習内容が更新されました", { exact: true })).toBeVisible();
      await expect(newTab.locator(".pronunciation-card")).toHaveCount(0);
      await expect(newTab.locator(".choice-grid")).toHaveCount(0);
      expect(await cachedPronunciationCardCount(newTab, sessionId as string)).toBeGreaterThan(0);

      await expect(page.locator(".pronunciation-card")).toHaveAttribute("data-phase", "prompt");
      await page.getByRole("button", { name: "発音した — 答えと比べる" }).click();
      await expect(page.getByRole("button", { name: "次へ" })).toBeVisible();
    } finally {
      await newTab.close();
    }
  });
});

function readMeta(page: Page): Promise<Record<string, any>> {
  return page.evaluate(async (dbName) => {
    const openDatabase = (name: string): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
    const db = await openDatabase(dbName);
    return await new Promise<Record<string, any>>((resolve, reject) => {
      const request = db.transaction("meta", "readonly").objectStore("meta").get("state");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }, DB_NAME);
}

function readOutbox(page: Page): Promise<AttemptInput[]> {
  return page.evaluate(async (dbName) => {
    const openDatabase = (name: string): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
    const db = await openDatabase(dbName);
    return await new Promise<AttemptInput[]>((resolve, reject) => {
      const request = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () =>
        resolve(
          (request.result as AttemptInput[]).toSorted(
            (left, right) => left.deviceSeq - right.deviceSeq,
          ),
        );
    });
  }, DB_NAME);
}

function cachedPronunciationCardCount(page: Page, sessionId: string): Promise<number> {
  return page.evaluate(
    async ({ dbName, sessionId }) => {
      const openDatabase = (name: string): Promise<IDBDatabase> =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open(name, 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => resolve(open.result);
        });
      const db = await openDatabase(dbName);
      return await new Promise<number>((resolve, reject) => {
        const request = db
          .transaction("pronunciationCards", "readonly")
          .objectStore("pronunciationCards")
          .index("sessionId")
          .count(sessionId);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
    },
    { dbName: DB_NAME, sessionId },
  );
}

function cachedPronunciationProgress(page: Page, sessionId: string): Promise<number | null> {
  return page.evaluate(
    async ({ dbName, sessionKey }) => {
      const openDatabase = (name: string): Promise<IDBDatabase> =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open(name, 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => resolve(open.result);
        });
      const db = await openDatabase(dbName);
      return await new Promise<number | null>((resolve, reject) => {
        const request = db
          .transaction("sessions", "readonly")
          .objectStore("sessions")
          .get(sessionKey);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result?.session?.completedItems ?? null);
      });
    },
    { dbName: DB_NAME, sessionKey: `pronunciation\u001f${sessionId}` },
  );
}

function seedLegacyProductionCache(page: Page, sessionId: string): Promise<void> {
  return page.evaluate(
    async ({ dbName, sessionId }) => {
      const openDatabase = (name: string): Promise<IDBDatabase> =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open(name, 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => resolve(open.result);
        });
      const request = <T>(requestValue: IDBRequest<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          requestValue.onerror = () => reject(requestValue.error);
          requestValue.onsuccess = () => resolve(requestValue.result);
        });
      const transactionDone = (transaction: IDBTransaction): Promise<void> =>
        new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      const db = await openDatabase(dbName);
      const transaction = db.transaction(
        ["meta", "sessions", "pronunciationCards", "outbox"],
        "readwrite",
      );
      const metaStore = transaction.objectStore("meta");
      const sessionStore = transaction.objectStore("sessions");
      const sessionKey = `pronunciation\u001f${sessionId}`;
      const sessionRecord = await request<any>(sessionStore.get(sessionKey));
      delete sessionRecord.practiceContractVersion;
      delete sessionRecord.session.practiceContractVersion;
      sessionStore.put(sessionRecord);

      const meta = await request<any>(metaStore.get("state"));
      delete meta.practiceContractVersions;
      metaStore.put(meta);

      const cards = await request<any[]>(transaction.objectStore("pronunciationCards").getAll());
      const staleCard = cards.find((record) => record.sessionId === sessionId);
      if (staleCard) {
        staleCard.card = {
          ...staleCard.card,
          activityType: "pronunciation_production",
          choices: [],
          answerChoiceId: null,
        };
        transaction.objectStore("pronunciationCards").put(staleCard);
      }

      const attempts = await request<any[]>(transaction.objectStore("outbox").getAll());
      const queued = attempts.find((attempt) => attempt.studySessionId === sessionId);
      if (queued) {
        queued.selfRating = 4;
        queued.metadata = {
          ...queued.metadata,
          interaction: "speak-compare-self-rate",
        };
        transaction.objectStore("outbox").put(queued);
      }
      await transactionDone(transaction);
    },
    { dbName: DB_NAME, sessionId },
  );
}
