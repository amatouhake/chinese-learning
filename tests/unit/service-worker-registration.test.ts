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
          return {};
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
    const updateOptions: Array<Record<string, string>> = [];
    registerProductionServiceWorker(
      true,
      {
        register: async (scriptUrl, options) => {
          scripts.push(scriptUrl);
          updateOptions.push(options ?? {});
          return { update: async () => undefined };
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
    expect(updateOptions).toEqual([{ updateViaCache: "none" }]);
  });

  test("watches local Worker updates and reloads after a new controller takes over", async () => {
    let focusListener: (() => void) | undefined;
    let intervalListener: (() => void) | undefined;
    let controllerChangeListener: (() => void) | undefined;
    let reloads = 0;
    let updates = 0;

    registerProductionServiceWorker(
      true,
      {
        controller: {},
        addEventListener: (_type, callback) => {
          controllerChangeListener = callback;
        },
        register: async () => ({ update: async () => void updates++ }),
      },
      (callback) => callback(),
      { watchForUpdates: true, updateIntervalMs: 1234 },
      {
        addEventListener: (_type, callback) => {
          focusListener = callback;
        },
        setInterval: (callback, timeout) => {
          expect(timeout).toBe(1234);
          intervalListener = callback;
          return 1;
        },
        location: { reload: () => reloads++ },
      },
    );

    await Promise.resolve();
    expect(updates).toBe(1);
    focusListener?.();
    intervalListener?.();
    expect(updates).toBe(3);
    controllerChangeListener?.();
    controllerChangeListener?.();
    expect(reloads).toBe(1);
  });

  test("does not reload when a first local install claims an uncontrolled page", async () => {
    const state: { controller?: unknown } = {};
    let controllerChangeListener: (() => void) | undefined;
    let reloads = 0;

    registerProductionServiceWorker(
      true,
      {
        get controller() {
          return state.controller;
        },
        addEventListener: (_type, callback) => {
          controllerChangeListener = callback;
        },
        register: async () => ({ update: async () => undefined }),
      },
      (callback) => callback(),
      { watchForUpdates: true },
      {
        addEventListener: () => undefined,
        setInterval: () => 1,
        location: { reload: () => reloads++ },
      },
    );

    await Promise.resolve();
    controllerChangeListener?.();
    expect(reloads).toBe(0);
    state.controller = {};
    controllerChangeListener?.();
    expect(reloads).toBe(1);
  });
});
