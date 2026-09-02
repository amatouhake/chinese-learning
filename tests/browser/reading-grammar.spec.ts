import { expect, test, type Page, type Response } from "@playwright/test";

import type { AttemptInput, GrammarCard, ReadingCard } from "../../src/domain/types";
import { readOfflineMeta, seedLegacyCompletedSession } from "./offline-fixtures";

test.describe("reading and grammar dogfood", () => {
  test.describe.configure({ timeout: 60_000 });

  test("phone flow reveals help in order and queues both activities through offline reload", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const consoleErrors: string[] = [];
    const captured = { reading: null as ReadingCard | null, grammar: null as GrammarCard | null };
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", (response) => void captureGuidedCards(response, captured));

    await page.goto("/#reading");
    await expect(page.getByText("中国語から読む", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator(".reading-prompt h2")).toBeVisible();
    await expect(page.locator(".vocabulary-reveal")).toHaveCount(0);
    await expect(page.getByLabel("例文のピンイン")).toHaveCount(0);
    await expect(page.getByLabel("例文の意味")).toHaveCount(0);
    await expect(page.getByLabel("文法の説明")).toHaveCount(0);

    await page.getByRole("button", { name: /単語を表示/ }).click();
    await expect(page.locator(".vocabulary-reveal")).toBeVisible();
    await expect.poll(() => isInViewport(page, ".staged-reveal")).toBe(true);
    await expect(page.getByLabel("例文のピンイン")).toHaveCount(0);
    await page.getByRole("button", { name: /ピンインを表示/ }).click();
    await expect(page.getByLabel("例文のピンイン")).toBeVisible();
    await expect.poll(() => isInViewport(page, ".staged-reveal")).toBe(true);
    await expect(page.getByLabel("例文の意味")).toHaveCount(0);
    await page.getByRole("button", { name: /意味を表示/ }).click();
    await expect(page.getByLabel("例文の意味")).toBeVisible();
    await expect.poll(() => isInViewport(page, ".staged-reveal")).toBe(true);
    await expect(page.getByLabel("文法の説明")).toHaveCount(0);
    await page.getByRole("button", { name: /文法を表示/ }).click();
    await expect(page.getByLabel("文法の説明")).toBeVisible();
    await expect(page.locator(".grammar-reveal code")).toBeVisible();
    await expect.poll(() => isInViewport(page, ".reading-card .rating-area")).toBe(true);
    await expect.poll(() => captured.reading).not.toBeNull();
    expect(
      captured.reading?.vocabulary.every((hint) => hint.readingId.startsWith("reading:")),
    ).toBe(true);
    await page.getByRole("button", { name: /だいたい/ }).click();
    await expect(page.locator(".reading-prompt h2")).toBeVisible();

    await page.getByRole("button", { name: "文法コース", exact: true }).click();
    await expect(page.getByRole("button", { name: "このパターンを練習する" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "例文のピンインと意味を表示" }).click();
    await expect(page.locator(".grammar-example .example-pinyin")).toBeVisible();
    await page.getByRole("button", { name: "このパターンを練習する" }).click();
    await expect(page.getByText("文を完成させる語を選ぶ")).toBeVisible();
    await expect.poll(() => captured.grammar).not.toBeNull();
    const grammarAnswer = captured.grammar?.topic.practice.choices.find(
      ({ id }) => id === captured.grammar?.topic.practice.answerChoiceId,
    );
    if (!grammarAnswer) throw new Error("captured grammar card has no answer choice");

    await context.setOffline(true);
    await page.getByRole("button", { name: grammarAnswer.label, exact: true }).click();
    await expect(page.getByText("正解", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /手がかりあり/ }).click();
    await expect(page.getByRole("button", { name: "このパターンを練習する" })).toBeVisible();

    await page.getByRole("button", { name: "例文を読む" }).click();
    await expect(page.locator(".reading-prompt h2")).toBeVisible();
    for (const label of ["単語を表示", "ピンインを表示", "意味を表示", "文法を表示"]) {
      await page.getByRole("button", { name: new RegExp(label) }).click();
    }
    await page.getByRole("button", { name: /手がかりあり/ }).click();
    await expect.poll(() => outboxCount(page)).toBe(2);

    await page.reload();
    await expect(page.getByRole("heading", { name: "中文学习" })).toBeVisible();
    await expect(page.locator(".reading-prompt h2")).toBeVisible();
    const queued = await readOutbox(page);
    expect(queued.map(({ mode }) => mode).sort()).toEqual(["grammar", "reading"]);
    expect(queued.every((attempt) => attempt.fsrsReview === undefined)).toBe(true);
    expect(queued.find(({ mode }) => mode === "grammar")?.metadata?.practiceVersionId).toBe(
      captured.grammar?.practiceVersionId,
    );
    const queuedSequences = queued.map(({ deviceSeq }) => deviceSeq).toSorted((a, b) => a - b);
    expect(queuedSequences).toEqual([queuedSequences[0]!, queuedSequences[0]! + 1]);

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => outboxCount(page), { timeout: 20_000 }).toBe(0);
    await expect(page.locator(".sync-status")).toContainText("同期済み");
    expect(
      consoleErrors.filter((message) => !message.includes("net::ERR_INTERNET_DISCONNECTED")),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("desktop grammar path presents the five systematic foundation topics", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const topics: GrammarCard[] = [];
    page.on("response", (response) => void collectGrammarCards(response, topics));
    await page.goto("/#reading");
    await page.getByRole("button", { name: "文法コース", exact: true }).click();
    await expect(page.getByRole("button", { name: "このパターンを練習する" })).toBeVisible({
      timeout: 20_000,
    });
    await expect.poll(() => topics.length).toBe(5);
    const systematicPath = topics.toSorted(
      (left, right) => left.topic.sequence - right.topic.sequence,
    );
    expect(systematicPath.map((card) => card.topic.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(systematicPath.map((card) => card.topicId)).toEqual([
      "grammar:foundation:shi-noun-link",
      "grammar:foundation:you-possession",
      "grammar:foundation:zai-location",
      "grammar:foundation:bu-negation",
      "grammar:foundation:ma-question",
    ]);
    expect(systematicPath.every((card) => card.examples.length > 0)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("the connected grammar action starts a session focused on the displayed topic", async ({
    page,
  }) => {
    const captured = { reading: null as ReadingCard | null };
    const requestedTopics: Array<string | null> = [];
    page.on("response", (response) => void captureLatestReadingCard(response, captured));
    page.on("request", (request) => {
      if (!request.url().endsWith("/api/grammar/sessions") || request.method() !== "POST") return;
      const body = request.postDataJSON() as { topicId?: string };
      requestedTopics.push(body.topicId ?? null);
    });

    await page.goto("/#reading");
    await expect(page.locator(".reading-prompt h2")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "文法コース", exact: true }).click();
    await expect(page.getByRole("button", { name: "このパターンを練習する" })).toBeVisible();
    expect(requestedTopics).toContain(null);

    await page.getByRole("button", { name: "例文を読む" }).click();
    for (const label of ["単語を表示", "ピンインを表示", "意味を表示", "文法を表示"]) {
      await page.getByRole("button", { name: new RegExp(label) }).click();
    }
    await expect.poll(() => captured.reading).not.toBeNull();
    const connectedTopic = captured.reading?.grammarTopics[0];
    if (!connectedTopic) throw new Error("captured reading card has no connected grammar topic");

    await page.getByRole("button", { name: "関連する文法コースを開く" }).click();
    await expect(page.locator(".grammar-heading h2")).toHaveText(connectedTopic.title);
    await expect.poll(() => requestedTopics.at(-1)).toBe(connectedTopic.id);
  });

  test("offline Reading results keep grammar topic titles through reconnect and history", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const captured = { reading: null as ReadingCard | null };
    page.on("response", (response) => void captureLatestReadingCard(response, captured));

    await page.goto("/#reading");
    await expect(page.locator(".reading-prompt h2")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => captured.reading).not.toBeNull();
    const topic = captured.reading?.grammarTopics[0];
    if (!topic) throw new Error("captured Reading card has no grammar topic");

    await context.setOffline(true);
    for (let index = 0; index < 5; index += 1) {
      for (const label of ["単語を表示", "ピンインを表示", "意味を表示", "文法を表示"]) {
        await page.getByRole("button", { name: new RegExp(label) }).click();
      }
      await page.getByRole("button", { name: /だいたい/ }).click();
      if (index < 4) await expect(page.locator(".reading-prompt h2")).toBeVisible();
    }

    await expect(page.getByRole("heading", { name: "5文完了" })).toBeVisible();
    await expect(page.locator(".practice-result")).toContainText(topic.title);
    await expect(page.locator(".practice-result")).not.toContainText(topic.id);

    await page.reload();
    await expect(page.getByRole("heading", { name: "5文完了" })).toBeVisible();
    await expect(page.locator(".practice-result")).toContainText(topic.title);
    await expect(page.locator(".practice-result")).not.toContainText(topic.id);

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => outboxCount(page), { timeout: 20_000 }).toBe(0);
    await page.goto("/#progress");
    await expect(page.getByRole("heading", { name: "最近の練習" })).toBeVisible();
    const historyEntry = page
      .locator(".session-history-list button")
      .filter({ hasText: "読解" })
      .first();
    await expect(historyEntry).toBeVisible({ timeout: 20_000 });
    await historyEntry.click();
    await expect(page.getByRole("heading", { name: "5文完了" })).toBeVisible();
    await expect(page.locator(".practice-result")).toContainText(topic.title);
    await expect(page.locator(".practice-result")).not.toContainText(topic.id);
  });

  for (const restoredMode of ["reading", "grammar"] as const) {
    test(`reopens a zero-detail legacy ${restoredMode} result in its saved submode`, async ({
      page,
    }) => {
      const sessionRequests: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/sessions")) {
          sessionRequests.push(new URL(request.url()).pathname);
        }
      });
      await page.goto("/#reading");
      await expect(page.locator(".reading-prompt h2")).toBeVisible({ timeout: 20_000 });
      await seedLegacyCompletedSession(page, restoredMode, {
        id: `${restoredMode}:legacy-completed`,
        deviceId: "device:legacy-completed",
        mode: restoredMode,
        maxItems: 5,
        completedItems: 5,
        focusTopicId: restoredMode === "grammar" ? "grammar:foundation:ma-question" : null,
        startedAt: Date.parse("2026-08-31T00:00:00Z"),
        endedAt: Date.parse("2026-08-31T00:10:00Z"),
      });
      const requestsBeforeReload = sessionRequests.length;

      for (let reload = 0; reload < 2; reload += 1) {
        await page.reload();
        await expect(
          page.getByRole("heading", { name: restoredMode === "reading" ? "5文完了" : "5問完了" }),
        ).toBeVisible();
        await expect(page.getByRole("status")).toContainText("0 / 5件分");
        await expect(page.locator(".guided-nav button.active")).toHaveText(
          restoredMode === "reading" ? "例文を読む" : "文法コース",
        );
      }
      expect(sessionRequests).toHaveLength(requestsBeforeReload);

      const nextSession = page.waitForRequest(
        (request) =>
          request.method() === "POST" && request.url().endsWith(`/api/${restoredMode}/sessions`),
      );
      await page
        .getByRole("button", {
          name: restoredMode === "reading" ? "別の読解を始める" : "別の文法を始める",
        })
        .click();
      await nextSession;
      expect((await readOfflineMeta(page)).presentedResult).toBeNull();
    });
  }
});

async function captureGuidedCards(
  response: Response,
  captured: { reading: ReadingCard | null; grammar: GrammarCard | null },
): Promise<void> {
  if (!response.url().endsWith("/api/sync/pull") || response.request().method() !== "POST") return;
  const payload = (await response.json()) as {
    readingPack?: { cards: ReadingCard[] } | null;
    grammarPack?: { cards: GrammarCard[] } | null;
  };
  captured.reading ??= payload.readingPack?.cards[0] ?? null;
  captured.grammar ??= payload.grammarPack?.cards[0] ?? null;
}

async function collectGrammarCards(response: Response, cards: GrammarCard[]): Promise<void> {
  if (!response.url().endsWith("/api/sync/pull") || response.request().method() !== "POST") return;
  const payload = (await response.json()) as { grammarPack?: { cards: GrammarCard[] } | null };
  if (cards.length === 0 && payload.grammarPack) cards.push(...payload.grammarPack.cards);
}

async function captureLatestReadingCard(
  response: Response,
  captured: { reading: ReadingCard | null },
): Promise<void> {
  if (!response.url().endsWith("/api/sync/pull") || response.request().method() !== "POST") return;
  const payload = (await response.json()) as { readingPack?: { cards: ReadingCard[] } | null };
  captured.reading = payload.readingPack?.cards[0] ?? captured.reading;
}

function isInViewport(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  });
}

function readOutbox(page: Page): Promise<AttemptInput[]> {
  return page.evaluate(() => {
    return new Promise<AttemptInput[]>((resolve, reject) => {
      const open = indexedDB.open("chinese-learning.offline.v1", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const request = open.result
          .transaction("outbox", "readonly")
          .objectStore("outbox")
          .getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result as AttemptInput[]);
      };
    });
  });
}

async function outboxCount(page: Page): Promise<number> {
  return (await readOutbox(page)).length;
}
