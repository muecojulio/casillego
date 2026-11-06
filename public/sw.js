const SHELL = "casillego-shell-v2";
const TILES = "casillego-tiles-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await Promise.all(
        ["/", "/privacidad", "/favicon.svg", "/maplibre/maplibre-gl-worker.mjs"].map((path) =>
          cache.add(path).catch(() => undefined),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== SHELL && key !== TILES).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/@") || url.pathname.includes("__vite")) return;
  if (url.hostname.includes("nominatim") || url.hostname.includes("overpass")) return;

  if (url.hostname.includes("openfreemap.org")) {
    event.respondWith(cacheFirst(TILES, request, 180));
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(SHELL, request));
});

async function networkFirst(name, request) {
  const cache = await caches.open(name);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) await cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = (await cache.match(request)) || (request.mode === "navigate" ? await cache.match("/") : undefined);
    if (cached) return cached;
    return new Response("Sin conexión", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

async function cacheFirst(name, request, limit) {
  const cache = await caches.open(name);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh.ok || fresh.type === "opaque") {
    await cache.put(request, fresh.clone());
    const keys = await cache.keys();
    if (keys.length > limit) await cache.delete(keys[0]);
  }
  return fresh;
}
