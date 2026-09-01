import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { chromium, expect, test, type APIRequestContext } from "@playwright/test";

test.describe("local Worker の PWA 更新", () => {
  test("既存タブが新しいビルドのシェルへ更新される", async ({ request }) => {
    const root = await mkdtemp(join(tmpdir(), "chinese-learning-local-update-"));
    const buildA = join(root, "build-a");
    const dist = join(process.cwd(), "dist");
    const indexPath = join(dist, "index.html");
    const serviceWorkerPath = join(dist, "service-worker.js");
    const indexB = await readFile(indexPath);
    const serviceWorkerB = await readFile(serviceWorkerPath);

    try {
      await cp(dist, buildA, { recursive: true });
      await markBuildA(buildA);
      await writeFile(indexPath, await readFile(join(buildA, "index.html")));
      await writeFile(serviceWorkerPath, await readFile(join(buildA, "service-worker.js")));
      await expect.poll(() => shell(request), { timeout: 10_000 }).toContain('lang="en"');

      const context = await chromium.launchPersistentContext(join(root, "profile"), {
        headless: true,
        viewport: { width: 390, height: 844 },
      });
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto("/#study", { waitUntil: "domcontentloaded" });
        await expect(page.locator("#app")).toHaveAttribute("data-local-build", "a");
        await page.evaluate(() => navigator.serviceWorker?.ready);

        await writeFile(indexPath, indexB);
        await writeFile(serviceWorkerPath, serviceWorkerB);
        await expect.poll(() => shell(request), { timeout: 10_000 }).toContain('lang="ja"');

        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(page.locator('#app[data-local-build="a"]')).toHaveCount(0, {
          timeout: 20_000,
        });
        await expect(page.locator(".global-header h1")).toHaveText("中文学习");
        await expect(page.locator("html")).toHaveAttribute("lang", "ja");
      } finally {
        await context.close();
      }
    } finally {
      await writeFile(indexPath, indexB).catch(() => undefined);
      await writeFile(serviceWorkerPath, serviceWorkerB).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function markBuildA(buildRoot: string): Promise<void> {
  const indexPath = join(buildRoot, "index.html");
  const index = await readFile(indexPath, "utf8");
  await writeFile(
    indexPath,
    index
      .replace('lang="ja"', 'lang="en"')
      .replace('<div id="app"></div>', '<div id="app" data-local-build="a"></div>'),
  );

  const serviceWorkerPath = join(buildRoot, "service-worker.js");
  const serviceWorker = await readFile(serviceWorkerPath, "utf8");
  const updated = serviceWorker.replace(
    /const SHELL_CACHE = `\$\{SHELL_CACHE_PREFIX\}[^`]+`;/,
    "const SHELL_CACHE = `${SHELL_CACHE_PREFIX}local-update-a`;",
  );
  if (updated === serviceWorker) throw new Error("build A has no shell cache version");
  await writeFile(serviceWorkerPath, updated);
}

async function shell(request: APIRequestContext): Promise<string> {
  const response = await request.get("/");
  if (!response.ok()) throw new Error(`shell returned ${response.status()}`);
  return response.text();
}
