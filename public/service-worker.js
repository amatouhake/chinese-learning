const SHELL_CACHE_PREFIX = "chinese-learning-shell-";
const SHELL_CACHE = `${SHELL_CACHE_PREFIX}__SHELL_VERSION__`;
const AUDIO_CACHE = "chinese-learning-pronunciation-audio-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const shell = await fetch(new Request("/", { cache: "reload" }));
      if (!shell.ok) throw new Error(`PWA shell returned ${shell.status}`);
      const html = await shell.clone().text();
      const paths = new Set([
        "/manifest.webmanifest",
        "/icon.svg",
        "/icon-192.png",
        "/icon-512.png",
      ]);
      for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        const path = match[1];
        if (path?.startsWith("/")) paths.add(path);
      }
      const resources = await Promise.all(
        [...paths].map(async (path) => {
          const response = await fetch(new Request(path, { cache: "reload" }));
          if (!response.ok)
            throw new Error(`PWA shell resource ${path} returned ${response.status}`);
          return { path, response };
        }),
      );
      await Promise.all([
        cache.put("/", shell),
        ...resources.map(({ path, response }) => cache.put(path, response)),
      ]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/media/")) {
    event.respondWith(
      (async () => {
        const cached = await caches.open(AUDIO_CACHE).then((cache) => cache.match(request));
        if (cached) return cached;
        try {
          return await fetch(request);
        } catch {
          return new Response("Pronunciation audio is not cached for offline use.", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      })(),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (!response.ok) throw new Error(`PWA navigation returned ${response.status}`);
          return response;
        } catch {
          const cached = await caches.open(SHELL_CACHE).then((cache) => cache.match("/"));
          return cached ?? new Response("Offline shell is unavailable.", { status: 503 });
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.open(SHELL_CACHE).then((cache) => cache.match(request));
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        await caches.open(SHELL_CACHE).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    })(),
  );
});
