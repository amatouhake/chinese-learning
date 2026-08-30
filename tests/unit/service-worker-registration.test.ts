import { describe, expect, test } from "bun:test";

import { registerProductionServiceWorker } from "../../src/web/service-worker-registration";

describe("service worker registration", () => {
  test("does not register or attach a load listener in Vite development", () => {
    let registrations = 0;
    let listeners = 0;
    registerProductionServiceWorker(
      false,
      {
        register: async () => {
          registrations += 1;
        },
      },
      () => {
        listeners += 1;
      },
    );

    expect(listeners).toBe(0);
    expect(registrations).toBe(0);
  });

  test("defers production registration until window load", async () => {
    let listener: (() => void) | undefined;
    const scripts: string[] = [];
    registerProductionServiceWorker(
      true,
      {
        register: async (scriptUrl) => {
          scripts.push(scriptUrl);
        },
      },
      (callback) => {
        listener = callback;
      },
    );

    expect(scripts).toEqual([]);
    listener?.();
    await Promise.resolve();
    expect(scripts).toEqual(["/service-worker.js"]);
  });
});
