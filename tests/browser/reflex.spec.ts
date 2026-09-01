import { expect, test, type Page } from "@playwright/test";

import type { AttemptInput, ReflexAnswerRecord } from "../../src/domain/types";

const DB_NAME = "chinese-learning.offline.v1";

test.describe("Reflex automaticity dogfood", () => {
  test.describe.configure({ timeout: 90_000 });

  test("phone drill repeats weak material and converges across offline reload", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await introduceVocabulary(page, 8);
    const stateBeforeReflex = await readCardStates(page);
    await selectMobileMode(page, "瞬発");
    await expect(page.locator(".surface-nav")).toBeHidden();
    await expect(page.getByRole("button", { name: "音声オン" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "12問の瞬発練習を始める" }).click();
    await expect(page.locator(".reflex-card")).toBeVisible({ timeout: 20_000 });
    const sessionId = (await readMeta(page)).activeReflexSessionId;
    expect(typeof sessionId).toBe("string");

    const first = await currentQuestion(page);
    await answerReflex(page, 1, false, 2_650);
    await answerReflex(page, 2, true);
    await answerReflex(page, 3, true);

    const repeated = await currentQuestion(page);
    expect(repeated.cardId).toBe(first.cardId);
    expect(repeated.answerPosition).not.toBe(first.answerPosition);
    await answerReflex(page, 4, true);

    await context.setOffline(true);
    await answerReflex(page, 5, true);
    await answerReflex(page, 6, false);
    await page.reload();
    await expect(page.locator(".reflex-card")).toBeVisible();
    await answerReflex(page, 7, true);
    const queued = await readOutbox(page);
    const queuedReflex = queued.filter(({ mode }) => mode === "reflex");
    expect(queuedReflex).toHaveLength(3);
    expect(queuedReflex.every(({ fsrsReview }) => fsrsReview === undefined)).toBe(true);

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => outboxCount(page), { timeout: 20_000 }).toBe(0);
    await expect(page.locator(".sync-status")).toContainText("同期済み");

    const duplicate = await postAttempt(page, queuedReflex[0]!);
    expect(duplicate).toMatchObject({
      disposition: "duplicate",
      eventId: queuedReflex[0]!.eventId,
      reviewCreated: false,
      cardState: null,
    });

    for (let round = 8; round <= 12; round += 1) {
      await answerReflex(page, round, true, 0, round === 12);
    }
    await expect(page.getByRole("heading", { name: "瞬発練習を完了" })).toBeVisible({
      timeout: 20_000,
    });
    expect((await readMeta(page)).activeReflexSessionId).toBeNull();

    const stored = await readReflexSession(page, sessionId as string);
    expect(stored?.answers).toHaveLength(12);
    const reflexEventIds = new Set(stored?.answers.map(({ eventId }) => eventId));
    const canonical = await pullAllChanges(page);
    const canonicalAttempts = canonical.filter(
      (change) =>
        change.entityType === "attempt" &&
        typeof change.eventId === "string" &&
        reflexEventIds.has(change.eventId),
    );
    expect(canonicalAttempts).toHaveLength(12);
    expect(canonicalAttempts.every((change) => change.reviewCreated === false)).toBe(true);
    expect(await readCardStates(page)).toEqual(stateBeforeReflex);

    await page.getByRole("button", { name: "同じ練習をもう一度" }).click();
    await expect(page.locator(".reflex-card")).toBeVisible({ timeout: 20_000 });
    expect((await readMeta(page)).activeReflexSessionId).not.toBe(sessionId);
    expect(
      consoleErrors.filter((message) => !message.includes("ERR_INTERNET_DISCONNECTED")),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("desktop mode is low-friction and existing learning surfaces remain reachable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/#reflex");
    await page.getByRole("button", { name: "12問の瞬発練習を始める" }).click();
    await expect(page.locator(".reflex-choice-grid button")).toHaveCount(4, {
      timeout: 20_000,
    });
    await page.keyboard.press("1");
    await expect(page.getByRole("button", { name: "次へ" })).toBeEnabled();
    await page.keyboard.press("Enter");
    await expect(page.locator(".card-meta span").first()).toHaveText("2 / 12");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await page.getByRole("button", { name: "単語", exact: true }).click();
    await expect(page.getByRole("button", { name: "練習を始める" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "発音", exact: true }).click();
    await expect(page.getByRole("button", { name: "おまかせ" })).toBeVisible();
    await page.getByRole("button", { name: "読解", exact: true }).click();
    await expect(page.getByRole("button", { name: "例文を読む" })).toBeVisible();
    await expect(page.getByRole("button", { name: "文法コース" })).toBeVisible();
  });

  test("autoplays canonical pronunciation at the recall-safe phase and keeps replay available", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      const plays: string[] = [];
      Object.assign(window, { pronunciationPlays: plays });
      HTMLMediaElement.prototype.play = function () {
        plays.push(this.currentSrc || this.src);
        return Promise.resolve();
      };
    });
    await introduceVocabulary(page, 8);
    await page.evaluate(() => {
      (window as typeof window & { pronunciationPlays: string[] }).pronunciationPlays.length = 0;
    });
    await selectMobileMode(page, "瞬発");
    await page.getByRole("button", { name: "12問の瞬発練習を始める" }).click();
    await expect(page.locator(".reflex-card")).toBeVisible({ timeout: 20_000 });

    const observed = new Set<string>();
    let replayVerified = false;
    let playsBeforeQuestion = 0;
    for (let round = 1; round <= 12; round += 1) {
      await expect(page.locator(".card-meta span").first()).toHaveText(`${round} / 12`);
      const card = page.locator(".reflex-card");
      const activity = await card.getAttribute("data-activity");
      if (!activity) throw new Error("Reflex card has no activity identity");
      const hasMedia = (await page.locator(".reflex-audio").count()) === 1;
      const promptAutoplay = activity === "hanzi_to_meaning" || activity === "pinyin_to_hanzi";
      if (hasMedia && promptAutoplay) {
        await expect.poll(() => pronunciationPlayCount(page)).toBeGreaterThan(playsBeforeQuestion);
      } else if (hasMedia) {
        expect(await pronunciationPlayCount(page)).toBe(playsBeforeQuestion);
      }

      if (hasMedia) {
        observed.add(activity);
        if (!replayVerified) {
          const playsBeforeReplay = await pronunciationPlayCount(page);
          await page.locator(".reflex-audio").click();
          await expect.poll(() => pronunciationPlayCount(page)).toBeGreaterThan(playsBeforeReplay);
          replayVerified = true;
        }
      }

      const playsBeforeAnswer = await pronunciationPlayCount(page);
      await page.locator(".reflex-choice-grid button").first().click();
      if (hasMedia && !promptAutoplay) {
        await expect.poll(() => pronunciationPlayCount(page)).toBeGreaterThan(playsBeforeAnswer);
      }
      await expect(page.getByRole("button", { name: "次へ" })).toBeEnabled({
        timeout: 20_000,
      });
      playsBeforeQuestion = await pronunciationPlayCount(page);
      if (round < 12) await page.getByRole("button", { name: "次へ" }).click();
    }

    expect(observed.size).toBeGreaterThan(0);
    expect(replayVerified).toBe(true);
  });

  test("消音設定は自動再生と聞き直しを止め、再読み込み後も残る", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      const plays: string[] = [];
      Object.assign(window, { pronunciationPlays: plays });
      HTMLMediaElement.prototype.play = function () {
        plays.push(this.currentSrc || this.src);
        return Promise.resolve();
      };
    });
    await page.goto("/#study");
    await expect(page.getByRole("button", { name: "音声オン" })).toBeVisible();
    await page.getByRole("button", { name: "音声オン" }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "音声オフ" })).toBeVisible();

    await introduceVocabulary(page, 8);
    await selectMobileMode(page, "瞬発");
    await page.getByRole("button", { name: "12問の瞬発練習を始める" }).click();
    await expect(page.locator(".reflex-card")).toBeVisible({ timeout: 20_000 });

    let replayVerified = false;
    for (let round = 1; round <= 12; round += 1) {
      await expect(page.locator(".card-meta span").first()).toHaveText(`${round} / 12`);
      const audio = page.locator(".reflex-audio");
      if (!replayVerified && (await audio.count()) > 0) {
        await audio.click();
        replayVerified = true;
      }
      expect(await pronunciationPlayCount(page)).toBe(0);
      await page.locator(".reflex-choice-grid button").first().click();
      await expect(page.getByRole("button", { name: "次へ" })).toBeEnabled({ timeout: 20_000 });
      expect(await pronunciationPlayCount(page)).toBe(0);
      if (round < 12) await page.getByRole("button", { name: "次へ" }).click();
    }
    expect(replayVerified).toBe(true);
  });

  test("a brand-new offline drill fails clearly instead of inventing canonical material", async ({
    page,
    context,
  }) => {
    await page.goto("/#reflex");
    await context.setOffline(true);
    await page.getByRole("button", { name: "12問の瞬発練習を始める" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "再接続すると、新しい瞬発練習を準備できます",
    );
  });

  test("reserves the full feedback rail at phone widths", async ({ page }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/#reflex");
      const start = page.getByRole("button", { name: "12問の瞬発練習を始める" });
      await expect(start.or(page.locator(".reflex-card"))).toBeVisible({ timeout: 20_000 });
      if (await start.isVisible()) await start.click();
      await expect(page.locator(".reflex-card")).toBeVisible({ timeout: 20_000 });

      const before = await reflexGeometry(page);
      await page.locator(".reflex-choice-grid button").first().click();
      await expect(page.getByRole("button", { name: "次へ" })).toBeEnabled();
      const after = await reflexGeometry(page);

      for (const selector of [
        ".reflex-prompt",
        ".reflex-choice-grid",
        ".reflex-feedback",
        ".reflex-feedback .secondary-button",
        ".audio-note",
      ]) {
        for (const property of ["top", "left", "height"] as const) {
          expect(
            Math.abs(after[selector]![property] - before[selector]![property]),
            `${width}px ${selector} ${property}`,
          ).toBeLessThanOrEqual(1);
        }
      }
      await page.getByRole("button", { name: "次へ" }).click();
    }
  });
});

async function introduceVocabulary(page: Page, count: number): Promise<void> {
  await page.goto("/#study");
  await expect(page.getByRole("button", { name: "練習を始める" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "練習を始める" }).click();
  await expect(page.getByRole("button", { name: "答えを見る" })).toBeVisible({ timeout: 20_000 });
  for (let index = 0; index < count; index += 1) {
    await page.getByRole("button", { name: "答えを見る" }).click();
    await page.getByRole("button", { name: /思い出せた/ }).click();
    await expect(page.getByRole("button", { name: "答えを見る" })).toBeVisible();
  }
  await expect.poll(() => outboxCount(page), { timeout: 20_000 }).toBe(0);
}

async function currentQuestion(page: Page): Promise<{
  cardId: string;
  answerPosition: number;
}> {
  const card = page.locator(".reflex-card");
  const cardId = await card.getAttribute("data-card-id");
  if (!cardId) throw new Error("Reflex card has no canonical identity");
  const choiceIds = await page
    .locator(".reflex-choice-grid button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-choice-id")));
  return { cardId, answerPosition: choiceIds.indexOf(cardId) };
}

function pronunciationPlayCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as typeof window & { pronunciationPlays: string[] }).pronunciationPlays.length,
  );
}

async function answerReflex(
  page: Page,
  round: number,
  correct: boolean,
  delayMs = 0,
  final = false,
): Promise<void> {
  await expect(page.locator(".card-meta span").first()).toHaveText(`${round} / 12`);
  const question = await currentQuestion(page);
  const choices = page.locator(".reflex-choice-grid button");
  const ids = await choices.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("data-choice-id")),
  );
  const index = correct
    ? ids.findIndex((id) => id === question.cardId)
    : ids.findIndex((id) => id !== question.cardId);
  expect(index).toBeGreaterThanOrEqual(0);
  if (delayMs > 0) await page.waitForTimeout(delayMs);
  await choices.nth(index).click();
  const continueButton = page.getByRole("button", { name: "次へ" });
  await expect(continueButton).toBeEnabled({ timeout: 20_000 });
  if (final) return;
  await continueButton.click();
  await expect(page.locator(".card-meta span").first()).toHaveText(`${round + 1} / 12`);
}

async function selectMobileMode(page: Page, label: string): Promise<void> {
  await page.locator("#mobile-mode-trigger").click();
  await page.getByRole("menuitemradio", { name: label }).click();
  await expect(page.locator("#mobile-mode-trigger")).toHaveText(label);
}

function reflexGeometry(
  page: Page,
): Promise<Record<string, { top: number; left: number; height: number }>> {
  return page.evaluate(() => {
    const selectors = [
      ".reflex-prompt",
      ".reflex-choice-grid",
      ".reflex-feedback",
      ".reflex-feedback .secondary-button",
      ".audio-note",
    ];
    return Object.fromEntries(
      selectors.map((selector) => {
        const rect = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        if (!rect) throw new Error(`missing ${selector}`);
        return [selector, { top: rect.top, left: rect.left, height: rect.height }];
      }),
    );
  });
}

function readMeta(page: Page): Promise<Record<string, unknown>> {
  return readStoreValue(page, "meta", "state") as Promise<Record<string, unknown>>;
}

function readCardStates(page: Page): Promise<Array<Record<string, unknown>>> {
  return readAll(page, "cardStates");
}

function readOutbox(page: Page): Promise<AttemptInput[]> {
  return readAll(page, "outbox").then((attempts) =>
    (attempts as unknown as AttemptInput[]).sort((left, right) => left.deviceSeq - right.deviceSeq),
  );
}

async function outboxCount(page: Page): Promise<number> {
  return (await readOutbox(page)).length;
}

function readReflexSession(
  page: Page,
  sessionId: string,
): Promise<{ answers: ReflexAnswerRecord[] } | null> {
  return readStoreValue(page, "sessions", `reflex\u001f${sessionId}`) as Promise<{
    answers: ReflexAnswerRecord[];
  } | null>;
}

function readStoreValue(page: Page, storeName: string, key: string): Promise<unknown> {
  return page.evaluate(
    async ({ dbName, storeName, key }) => {
      const db = await openDb(dbName);
      return await new Promise<unknown>((resolve, reject) => {
        const get = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result ?? null);
      });

      function openDb(name: string): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open(name, 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
      }
    },
    { dbName: DB_NAME, storeName, key },
  );
}

function readAll(page: Page, storeName: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    async ({ dbName, storeName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const get = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result);
      });
    },
    { dbName: DB_NAME, storeName },
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

function pullAllChanges(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async () => {
    const meta = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const open = indexedDB.open("chinese-learning.offline.v1", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const get = open.result.transaction("meta", "readonly").objectStore("meta").get("state");
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result);
      };
    });
    let cursor = 0;
    const changes: Array<Record<string, unknown>> = [];
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const response = await fetch("/api/sync/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cursor,
          contentRevision: null,
          deviceId: meta.deviceId,
        }),
      });
      const pull = (await response.json()) as {
        learnerChanges: Array<Record<string, unknown>>;
        nextCursor: number;
        hasMore: boolean;
      };
      changes.push(...pull.learnerChanges);
      cursor = pull.nextCursor;
      if (!pull.hasMore) return changes;
    }
    throw new Error("canonical Reflex change pull exceeded its page bound");
  });
}
