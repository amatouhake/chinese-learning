interface ServiceWorkerRegistrar {
  register(scriptUrl: string): Promise<unknown>;
}

type LoadListener = (callback: () => void) => void;

export function registerProductionServiceWorker(
  production: boolean,
  registrar: ServiceWorkerRegistrar | undefined = globalThis.navigator?.serviceWorker,
  onLoad: LoadListener = (callback) => globalThis.window.addEventListener("load", callback),
): void {
  if (!production || !registrar) return;
  onLoad(() => {
    void registrar.register("/service-worker.js").catch(() => undefined);
  });
}
