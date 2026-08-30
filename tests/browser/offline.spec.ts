import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { AttemptInput } from "../../src/domain/types";

const DB_NAME = "chinese-learning.offline.v1";

test.describe("offline PWA foundation", () => {
  test.describe.configure({ timeout: 60_000 });

  test("queues across offline reload, partially retries, and converges with workerd/D1", async ({
    page,
    context,
  }) => {
    await prepareVocabularyAndPronunciation(page);
    const manifest = await page.evaluate(async () => {
      const response = await fetch("/manifest.webmanifest");
      if (!response.ok) throw new Error(`manifest returned ${response.status}`);
      return response.json();
    });
    expect(manifest).toMatchObject({
      id: "/",
      start_url: "/#study",
      display: "standalone",
      icons: expect.arrayContaining([
        expect.objectContaining({ src: "/icon-192.png", sizes: "192x192" }),
        expect.objectContaining({ src: "/icon-512.png", sizes: "512x512" }),
      ]),
    });
    const shellCache = await inspectShellCache(page);
    expect(shellCache.name).toMatch(/^chinese-learning-shell-[0-9a-f]{16}$/);
    expect(shellCache.missing).toEqual([]);
    await context.setOffline(true);

    await completeVocabulary(page, 3);
    await page.getByRole("button", { name: "Pronunciation" }).click();
    await completePronunciation(page, 3);
    await expect(page.locator(".study-card")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "中文学习" })).toBeVisible();
    await completePronunciation(page, 2);
    await page.getByRole("button", { name: "Study" }).click();
    await completeVocabulary(page, 2);

    const queued = await readOutbox(page);
    expect(queued).toHaveLength(10);
    expect(queued.map((attempt) => attempt.deviceSeq)).toEqual(
      Array.from({ length: 10 }, (_, index) => queued[0]!.deviceSeq + index),
    );
    const vocabulary = queued.filter((attempt) => attempt.mode === "study");
    const pronunciation = queued.filter((attempt) => attempt.mode === "pronunciation");
    expect(vocabulary).toHaveLength(5);
    expect(
      vocabulary.every(
        (attempt) =>
          attempt.fsrsReview?.schedulerConfigId === vocabulary[0]?.fsrsReview?.schedulerConfigId,
      ),
    ).toBe(true);
    expect(pronunciation).toHaveLength(5);
    expect(pronunciation.every((attempt) => attempt.fsrsReview === undefined)).toBe(true);

    let pushNumber = 0;
    await page.route("**/api/attempts", async (route) => {
      pushNumber += 1;
      if (pushNumber === 2) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "simulated partial sync failure" }),
        });
        return;
      }
      await route.continue();
    });
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => outboxCount(page)).toBe(9);
    await expect(page.locator(".sync-status")).toContainText("9 queued");

    await page.unroute("**/api/attempts");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => outboxCount(page), { timeout: 20_000 }).toBe(0);
    await expect(page.locator(".sync-status")).toContainText("synced");

    const duplicate = await postAttempt(page, queued[0]!);
    expect(duplicate).toMatchObject({ disposition: "duplicate", eventId: queued[0]!.eventId });
    const canonicalChanges = await pullAllCanonicalChanges(page);
    const canonicalEventIds = canonicalChanges
      .filter((change) => change.entityType === "attempt")
      .map((change) => change.eventId);
    for (const attempt of queued) {
      expect(canonicalEventIds.filter((eventId) => eventId === attempt.eventId)).toHaveLength(1);
    }
    const localCardStates = await readCardStates(page);
    for (const cardId of new Set(vocabulary.map((attempt) => attempt.cardId))) {
      const canonical = canonicalChanges
        .filter(
          (change) => change.entityType === "card_state" && change.cardState?.cardId === cardId,
        )
        .at(-1)?.cardState;
      expect(localCardStates.find((state) => state.cardId === cardId)).toEqual(canonical);
    }
    const state = await readMeta(page);
    expect(state.learnerCursor).toBeGreaterThan(0);
    expect(state.contentRevision).not.toBeNull();
  });

  test("serializes device sequences across two offline tabs without overwriting outbox events", async ({
    page,
    context,
  }) => {
    await page.goto("/#study");
    await expect(page.getByRole("button", { name: "Reveal answer" })).toBeVisible({
      timeout: 20_000,
    });
    await waitForServiceWorker(page);
    await context.setOffline(true);
    const second = await context.newPage();
    await second.goto("/#study");
    await expect(second.getByRole("button", { name: "Reveal answer" })).toBeVisible();

    await page.getByRole("button", { name: "Reveal answer" }).click();
    await second.getByRole("button", { name: "Reveal answer" }).click();
    await page.getByRole("button", { name: "3: Good — Recalled" }).click();
    await second.getByRole("button", { name: "3: Good — Recalled" }).click();
    await expect(second.getByRole("alert")).toContainText("study state changed in another tab");

    await second.reload();
    await expect(second.getByRole("button", { name: "Reveal answer" })).toBeVisible();
    await second.getByRole("button", { name: "Reveal answer" }).click();
    await second.getByRole("button", { name: "3: Good — Recalled" }).click();
    await expect.poll(() => outboxCount(second)).toBe(2);

    const queued = await readOutbox(second);
    expect(queued).toHaveLength(2);
    expect(queued[1]!.deviceId).toBe(queued[0]!.deviceId);
    expect(queued[1]!.deviceSeq).toBe(queued[0]!.deviceSeq + 1);
    expect(new Set(queued.map((attempt) => attempt.eventId)).size).toBe(2);
  });

  test("keeps an exhausted offline session active until D1 canonically closes it", async ({
    page,
    context,
    request,
  }) => {
    await page.goto("/#study");
    await expect(page.getByRole("button", { name: "Reveal answer" })).toBeVisible({
      timeout: 20_000,
    });
    await waitForServiceWorker(page);
    const sessionId = (await readMeta(page)).activeSessionId;
    expect(typeof sessionId).toBe("string");
    await context.setOffline(true);

    for (let index = 0; index < 10; index += 1) {
      await page.getByRole("button", { name: "Reveal answer" }).click();
      await page.getByRole("button", { name: "3: Good — Recalled" }).click();
      if (index < 9) {
        await expect(page.getByRole("button", { name: "Reveal answer" })).toBeVisible();
      }
    }
    await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible();
    await expect.poll(() => outboxCount(page)).toBe(10);
    expect((await readMeta(page)).activeSessionId).toBe(sessionId);

    await page.route("**/api/sync/pull", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "simulated canonical pull failure" }),
      });
    });
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => outboxCount(page), { timeout: 20_000 }).toBe(0);
    expect((await readMeta(page)).activeSessionId).toBe(sessionId);
    await expect(page.locator(".sync-status")).toContainText("simulated canonical pull failure");

    await page.unroute("**/api/sync/pull");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await readMeta(page)).activeSessionId).toBeNull();
    const changes = await apiPullAll(request, (await readMeta(page)).deviceId as string);
    expect(
      changes.find(
        (change) =>
          change.entityType === "study_session" &&
          change.sessionId === sessionId &&
          typeof change.endedAt === "number",
      ),
    ).toBeDefined();
  });

  test("keeps an exhausted pronunciation session active until its pull succeeds", async ({
    page,
    context,
    request,
  }) => {
    await page.goto("/#pronunciation");
    await page.getByRole("button", { name: "Mixed practice" }).click();
    await expect(page.locator(".study-card")).toBeVisible({ timeout: 20_000 });
    await waitForServiceWorker(page);
    const sessionId = (await readMeta(page)).activePronunciationSessionId;
    expect(typeof sessionId).toBe("string");
    await context.setOffline(true);

    for (let index = 0; index < 10; index += 1) {
      await answerPronunciationCard(page);
      if (index < 9) await expect(page.locator(".study-card")).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Pronunciation set complete" })).toBeVisible();
    await expect.poll(() => outboxCount(page)).toBe(10);

    await page.route("**/api/sync/pull", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "simulated pronunciation pull failure" }),
      });
    });
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => outboxCount(page), { timeout: 20_000 }).toBe(0);
    expect((await readMeta(page)).activePronunciationSessionId).toBe(sessionId);

    await page.unroute("**/api/sync/pull");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await readMeta(page)).activePronunciationSessionId).toBeNull();
    const changes = await apiPullAll(request, (await readMeta(page)).deviceId as string);
    expect(
      changes.find(
        (change) =>
          change.entityType === "study_session" &&
          change.sessionId === sessionId &&
          change.mode === "pronunciation" &&
          typeof change.endedAt === "number",
      ),
    ).toBeDefined();
  });

  test("omits an uncreated pronunciation session while populating vocabulary", async ({ page }) => {
    const pulls: Array<Record<string, unknown>> = [];
    await page.route("**/api/sync/pull", async (route) => {
      pulls.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.continue();
    });
    await page.route("**/api/pronunciation/sessions", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "simulated session creation failure" }),
      });
    });

    await page.goto("/#pronunciation");
    await page.getByRole("button", { name: "Mixed practice" }).click();
    await expect(page.getByRole("alert")).toContainText("simulated session creation failure");
    const failedSessionId = (await readMeta(page)).activePronunciationSessionId;
    expect(typeof failedSessionId).toBe("string");

    await page.getByRole("button", { name: "Study" }).click();
    await expect(page.getByRole("button", { name: "Reveal answer" })).toBeVisible({
      timeout: 20_000,
    });
    expect(
      pulls.some(
        (pull) =>
          typeof pull.studySessionId === "string" && pull.pronunciationSessionId === undefined,
      ),
    ).toBe(true);
    expect((await readMeta(page)).activePronunciationSessionId).toBe(failedSessionId);
  });

  test("omits an uncreated vocabulary session while populating pronunciation", async ({ page }) => {
    const pulls: Array<Record<string, unknown>> = [];
    await page.route("**/api/sync/pull", async (route) => {
      pulls.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.continue();
    });
    await page.route("**/api/study/sessions", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "simulated vocabulary session creation failure" }),
      });
    });

    await page.goto("/#study");
    await expect(page.getByRole("alert")).toContainText(
      "simulated vocabulary session creation failure",
    );
    const failedSessionId = (await readMeta(page)).activeSessionId;
    expect(typeof failedSessionId).toBe("string");

    await page.getByRole("button", { name: "Pronunciation" }).click();
    await page.getByRole("button", { name: "Mixed practice" }).click();
    await expect(page.locator(".study-card")).toBeVisible({ timeout: 20_000 });
    expect(
      pulls.some(
        (pull) =>
          pull.studySessionId === undefined && typeof pull.pronunciationSessionId === "string",
      ),
    ).toBe(true);
    expect((await readMeta(page)).activeSessionId).toBe(failedSessionId);
  });

  test("uses cached pronunciation audio offline and clearly skips an uncached recording", async ({
    page,
    context,
  }) => {
    await page.goto("/#pronunciation");
    await page.getByRole("button", { name: /^Listening / }).click();
    await expect(page.getByText(/Audio →/)).toBeVisible({ timeout: 20_000 });
    await waitForServiceWorker(page);
    const mediaUrl = await firstCachedPronunciationMedia(page);
    expect(mediaUrl).not.toBeNull();
    expect(await audioCacheContains(page, mediaUrl!)).toBe(true);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Play or replay word audio" })).toBeEnabled();
    await page.getByRole("button", { name: "Play or replay word audio" }).click();

    await deleteCachedAudio(page, mediaUrl!);
    await page.reload();
    await expect(
      page.getByText("This recording was not cached before network loss."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Skip uncached audio" }).click();
    await expect(page.getByRole("button", { name: "Play or replay word audio" })).toBeEnabled();
  });

  test("migrates the localStorage identity and pending fact without sequence reuse", async ({
    page,
  }) => {
    const pending: AttemptInput = {
      eventId: "study-event:legacy-pending",
      deviceId: "browser:legacy-stable",
      deviceSeq: 7,
      occurredAt: "2026-08-30T01:00:00.000Z",
      cardId: "card:legacy",
      studySessionId: "study-session:legacy",
      mode: "study",
      activityType: "hanzi_to_meaning",
      expectedCardStateVersion: 0,
      fsrsReview: { rating: 3, schedulerConfigId: "config:legacy" },
    };
    await page.addInitScript(
      ({ pendingAttempt }) => {
        localStorage.setItem(
          "chinese-learning.study-browser.v1",
          JSON.stringify({
            version: 3,
            deviceId: pendingAttempt.deviceId,
            nextDeviceSeq: 8,
            activeSessionId: pendingAttempt.studySessionId,
            activePronunciationSessionId: null,
            activePronunciationFocus: null,
            pendingAttempt,
          }),
        );
      },
      { pendingAttempt: pending },
    );
    await page.goto("/#study");
    await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible({
      timeout: 20_000,
    });
    const state = await readMeta(page);
    const outbox = await readOutbox(page);
    expect(state).toMatchObject({
      deviceId: "browser:legacy-stable",
      nextDeviceSeq: 8,
    });
    expect(outbox).toEqual([pending]);
    await page.reload();
    expect(await readMeta(page)).toMatchObject({
      deviceId: "browser:legacy-stable",
      nextDeviceSeq: 8,
    });
  });

  test("reconciles a legacy-tab write after IndexedDB exists without reusing its sequence", async ({
    page,
    context,
  }) => {
    await page.goto("/#study");
    await expect(page.getByRole("button", { name: "Reveal answer" })).toBeVisible({
      timeout: 20_000,
    });
    await waitForServiceWorker(page);
    const state = await readMeta(page);
    const cached = await firstCachedStudyCard(page);
    if (!cached || typeof state.activeSessionId !== "string") {
      throw new Error("browser test has no cached vocabulary card");
    }
    const pending: AttemptInput = {
      eventId: "study-event:legacy-after-idb",
      deviceId: state.deviceId as string,
      deviceSeq: state.nextDeviceSeq as number,
      occurredAt: "2026-08-30T03:00:00.000Z",
      cardId: cached.card.cardId,
      studySessionId: state.activeSessionId,
      mode: "study",
      activityType: cached.card.activityType,
      expectedCardStateVersion: cached.card.state.version,
      responseMs: 100,
      metadata: { interaction: "legacy-tab" },
      fsrsReview: {
        rating: 3,
        schedulerConfigId: cached.card.schedulerConfigId,
      },
    };
    await page.evaluate(
      async ({ attempt, nextDeviceSeq, activeSessionId }) => {
        await navigator.locks.request("chinese-learning.study-browser.v1.lock", () => {
          localStorage.setItem(
            "chinese-learning.study-browser.v1",
            JSON.stringify({
              version: 3,
              deviceId: attempt.deviceId,
              nextDeviceSeq,
              activeSessionId,
              activePronunciationSessionId: null,
              activePronunciationFocus: null,
              pendingAttempt: attempt,
            }),
          );
        });
      },
      {
        attempt: pending,
        nextDeviceSeq: pending.deviceSeq + 1,
        activeSessionId: pending.studySessionId,
      },
    );

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Reveal answer" })).toBeVisible();
    expect(await readOutbox(page)).toEqual([pending]);
    expect(await readMeta(page)).toMatchObject({
      deviceId: pending.deviceId,
      nextDeviceSeq: pending.deviceSeq + 1,
    });
    expect(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem("chinese-learning.study-browser.v1") ?? "null"),
      ),
    ).toMatchObject({ nextDeviceSeq: pending.deviceSeq + 1, pendingAttempt: null });

    await page.getByRole("button", { name: "Reveal answer" }).click();
    await page.getByRole("button", { name: "3: Good — Recalled" }).click();
    await expect.poll(() => outboxCount(page)).toBe(2);
    const queued = await readOutbox(page);
    expect(queued).toHaveLength(2);
    expect(queued.map((attempt) => attempt.deviceSeq)).toEqual([
      pending.deviceSeq,
      pending.deviceSeq + 1,
    ]);
  });

  test("late offline review converges after a newer device review", async ({
    page,
    context,
    request,
  }) => {
    await page.goto("/#study");
    await expect(page.getByRole("button", { name: "Reveal answer" })).toBeVisible({
      timeout: 20_000,
    });
    await context.setOffline(true);
    await page.getByRole("button", { name: "Reveal answer" }).click();
    await page.getByRole("button", { name: "2: Hard — Barely" }).click();
    await expect.poll(() => outboxCount(page)).toBe(1);
    const older = (await readOutbox(page)).find(
      (attempt) => attempt.mode === "study" && attempt.fsrsReview !== undefined,
    );
    if (!older?.fsrsReview) throw new Error("offline review was not staged");

    const newerSessionId = `study-session:late-browser-${crypto.randomUUID()}`;
    const newerDeviceId = `browser:late-online-${crypto.randomUUID()}`;
    await apiPost(request, "/api/study/sessions", {
      sessionId: newerSessionId,
      deviceId: newerDeviceId,
      maxCards: 1,
    });
    const newer: AttemptInput = {
      ...older,
      eventId: `study-event:late-newer-${crypto.randomUUID()}`,
      deviceId: newerDeviceId,
      deviceSeq: 1,
      studySessionId: newerSessionId,
      occurredAt: new Date(Date.parse(older.occurredAt) + 60_000).toISOString(),
      fsrsReview: { ...older.fsrsReview, rating: 4 },
    };
    expect((await apiPost(request, "/api/attempts", newer)).disposition).toBe("inserted");

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => outboxCount(page), { timeout: 20_000 }).toBe(0);
    const changes = await apiPullAll(request, older.deviceId);
    const stateChanges = changes.filter(
      (change) => change.entityType === "card_state" && change.cardState?.cardId === older.cardId,
    );
    expect(stateChanges.at(-1)?.cardState).toMatchObject({
      version: (older.expectedCardStateVersion ?? 0) + 2,
    });
    expect(changes.filter((change) => change.eventId === older.eventId)).toHaveLength(1);
    expect(changes.filter((change) => change.eventId === newer.eventId)).toHaveLength(1);
  });
});

async function prepareVocabularyAndPronunciation(page: Page): Promise<void> {
  await page.goto("/#study");
  await expect(page.getByRole("button", { name: "Reveal answer" })).toBeVisible({
    timeout: 20_000,
  });
  await waitForServiceWorker(page);
  await page.getByRole("button", { name: "Pronunciation" }).click();
  await page.getByRole("button", { name: "Mixed practice" }).click();
  await expect(page.locator(".study-card")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Study" }).click();
  await expect(page.getByRole("button", { name: "Reveal answer" })).toBeVisible({
    timeout: 20_000,
  });
}

async function completeVocabulary(page: Page, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await page.getByRole("button", { name: "Reveal answer" }).click();
    await page.getByRole("button", { name: "3: Good — Recalled" }).click();
    await expect(page.getByRole("button", { name: "Reveal answer" })).toBeVisible();
  }
}

async function completePronunciation(page: Page, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await answerPronunciationCard(page);
    await expect(page.locator(".study-card")).toBeVisible();
  }
}

async function answerPronunciationCard(page: Page): Promise<void> {
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

async function waitForServiceWorker(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
}

function inspectShellCache(page: Page): Promise<{ name: string | null; missing: string[] }> {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const name = names.find((candidate) => candidate.startsWith("chinese-learning-shell-")) ?? null;
    if (!name) return { name, missing: ["/"] };
    const cache = await caches.open(name);
    const shell = await cache.match("/");
    if (!shell) return { name, missing: ["/"] };
    const html = await shell.text();
    const paths = new Set([
      "/",
      "/manifest.webmanifest",
      "/icon.svg",
      "/icon-192.png",
      "/icon-512.png",
    ]);
    for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      const path = match[1];
      if (path?.startsWith("/")) paths.add(path);
    }
    const missing: string[] = [];
    for (const path of paths) {
      if (!(await cache.match(path))) missing.push(path);
    }
    return { name, missing };
  });
}

function readMeta(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ({ dbName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(dbName, 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const get = db.transaction("meta", "readonly").objectStore("meta").get("state");
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result);
      });
    },
    { dbName: DB_NAME },
  );
}

function readOutbox(page: Page): Promise<AttemptInput[]> {
  return page.evaluate(
    async ({ dbName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(dbName, 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
      return await new Promise<AttemptInput[]>((resolve, reject) => {
        const get = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result.sort((a, b) => a.deviceSeq - b.deviceSeq));
      });
    },
    { dbName: DB_NAME },
  );
}

function firstCachedStudyCard(page: Page): Promise<{
  position: number;
  card: {
    cardId: string;
    activityType: AttemptInput["activityType"];
    schedulerConfigId: string;
    state: { version: number };
  };
} | null> {
  return page.evaluate(
    async ({ dbName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(dbName, 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
      const cards = await new Promise<
        Array<{
          position: number;
          card: {
            cardId: string;
            activityType: AttemptInput["activityType"];
            schedulerConfigId: string;
            state: { version: number };
          };
        }>
      >((resolve, reject) => {
        const get = db.transaction("studyCards", "readonly").objectStore("studyCards").getAll();
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result);
      });
      return cards.sort((left, right) => left.position - right.position)[0] ?? null;
    },
    { dbName: DB_NAME },
  );
}

async function outboxCount(page: Page): Promise<number> {
  return (await readOutbox(page)).length;
}

function readCardStates(page: Page): Promise<Array<Record<string, any>>> {
  return page.evaluate(
    async ({ dbName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(dbName, 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
      return await new Promise<Array<Record<string, any>>>((resolve, reject) => {
        const get = db.transaction("cardStates", "readonly").objectStore("cardStates").getAll();
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result);
      });
    },
    { dbName: DB_NAME },
  );
}

async function firstCachedPronunciationMedia(page: Page): Promise<string | null> {
  return page.evaluate(
    async ({ dbName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(dbName, 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
      const cards = await new Promise<
        Array<{ position: number; card: { media?: { url: string } } }>
      >((resolve, reject) => {
        const get = db
          .transaction("pronunciationCards", "readonly")
          .objectStore("pronunciationCards")
          .getAll();
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result);
      });
      return cards.sort((a, b) => a.position - b.position)[0]?.card.media?.url ?? null;
    },
    { dbName: DB_NAME },
  );
}

function audioCacheContains(page: Page, url: string): Promise<boolean> {
  return page.evaluate(
    async ({ mediaUrl }) =>
      (await caches
        .open("chinese-learning-pronunciation-audio-v1")
        .then((cache) => cache.match(mediaUrl))) !== undefined,
    { mediaUrl: url },
  );
}

function deleteCachedAudio(page: Page, url: string): Promise<boolean> {
  return page.evaluate(
    async ({ mediaUrl }) =>
      caches
        .open("chinese-learning-pronunciation-audio-v1")
        .then((cache) => cache.delete(mediaUrl)),
    { mediaUrl: url },
  );
}

function postAttempt(page: Page, attempt: AttemptInput): Promise<Record<string, unknown>> {
  return page.evaluate(async (body) => {
    const response = await fetch("/api/attempts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json();
  }, attempt);
}

async function pullAllCanonicalChanges(page: Page): Promise<Array<Record<string, any>>> {
  return page.evaluate(async () => {
    const state = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const open = indexedDB.open("chinese-learning.offline.v1", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const get = open.result.transaction("meta", "readonly").objectStore("meta").get("state");
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result);
      };
    });
    let cursor = 0;
    const changes: Array<Record<string, any>> = [];
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const response = await fetch("/api/sync/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cursor,
          contentRevision: null,
          deviceId: state.deviceId,
        }),
      });
      const pull = (await response.json()) as {
        learnerChanges: Array<Record<string, any>>;
        nextCursor: number;
        hasMore: boolean;
      };
      changes.push(...pull.learnerChanges);
      cursor = pull.nextCursor;
      if (!pull.hasMore) return changes;
    }
    throw new Error("browser pull exceeded page limit");
  });
}

async function apiPost(
  request: APIRequestContext,
  path: string,
  body: unknown,
): Promise<Record<string, any>> {
  const response = await request.post(`http://127.0.0.1:8787${path}`, {
    headers: { origin: "http://127.0.0.1:8787" },
    data: body,
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function apiPullAll(
  request: APIRequestContext,
  deviceId: string,
): Promise<Array<Record<string, any>>> {
  let cursor = 0;
  const changes: Array<Record<string, any>> = [];
  for (let page = 0; page < 100; page += 1) {
    const pull = await apiPost(request, "/api/sync/pull", {
      cursor,
      contentRevision: null,
      deviceId,
    });
    changes.push(...pull.learnerChanges);
    cursor = pull.nextCursor;
    if (!pull.hasMore) return changes;
  }
  throw new Error("API pull exceeded page limit");
}
