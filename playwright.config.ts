import { defineConfig } from "@playwright/test";

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
    command: "bun run dev:worker -- --ip 127.0.0.1 --port 8787",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: "/tmp/chinese-learning-wrangler-config",
    },
  },
});
