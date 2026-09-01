interface ServiceWorkerRegistrar {
  register(
    scriptUrl: string,
    options?: { updateViaCache?: "imports" | "all" | "none" },
  ): Promise<ServiceWorkerRegistrationLike>;
  addEventListener?(type: "controllerchange", callback: () => void): void;
  controller?: unknown;
}

type LoadListener = (callback: () => void) => void;

interface ServiceWorkerRegistrationLike {
  update?: () => Promise<unknown>;
}

interface UpdateWatchOptions {
  watchForUpdates?: boolean;
  updateIntervalMs?: number;
}

interface BrowserLifecycle {
  addEventListener(type: "focus", callback: () => void): void;
  setInterval(callback: () => void, timeout: number): unknown;
  location: { reload(): void };
}

const LOCAL_UPDATE_INTERVAL_MS = 15_000;

export function registerProductionServiceWorker(
  production: boolean,
  registrar: ServiceWorkerRegistrar | undefined = globalThis.navigator?.serviceWorker,
  onLoad: LoadListener = (callback) => globalThis.window.addEventListener("load", callback),
  options: UpdateWatchOptions = {},
  lifecycle: BrowserLifecycle | undefined = globalThis.window,
): void {
  if (!production || !registrar) return;
  onLoad(() => {
    let hasController = Boolean(registrar.controller);
    let reloading = false;
    if (options.watchForUpdates && lifecycle) {
      registrar.addEventListener?.("controllerchange", () => {
        if (!hasController) {
          hasController = true;
          return;
        }
        if (reloading) return;
        reloading = true;
        lifecycle.location.reload();
      });
    }

    void registrar
      .register("/service-worker.js", { updateViaCache: "none" })
      .then((registration) => {
        const update = () => {
          hasController ||= Boolean(registrar.controller);
          void registration.update?.().catch(() => undefined);
        };
        update();
        if (!options.watchForUpdates || !lifecycle) return;
        lifecycle.addEventListener("focus", update);
        globalThis.document?.addEventListener("visibilitychange", () => {
          if (globalThis.document?.visibilityState === "visible") update();
        });
        lifecycle.setInterval(update, options.updateIntervalMs ?? LOCAL_UPDATE_INTERVAL_MS);
      })
      .catch(() => undefined);
  });
}
