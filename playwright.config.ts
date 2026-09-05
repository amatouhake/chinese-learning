import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const browserTestRoot = resolve(".generated/browser-test");

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "bun run dev:worker -- --ip 127.0.0.1 --port 8787 " +
      "--persist-to .generated/browser-test/d1 --env-file .dev.vars.example",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: resolve(browserTestRoot, "wrangler.log"),
      XDG_CONFIG_HOME: resolve(browserTestRoot, "config"),
    },
  },
});
