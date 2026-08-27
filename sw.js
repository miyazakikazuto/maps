// sw.js — Service Worker: cache app shell + map tiles for offline use.
const CACHE = "trail-gps-v2"; // bump tiap deploy agar cache lama ter-purge
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./geo.js",
  "./styles.css",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Map tiles (a/b/c.tile.openstreetmap.org): cache-first, then network + cache.
  // (cache-first penting biar offline tetap bisa membaca tile yg sudah didownload)
  if (url.hostname.endsWith("tile.openstreetmap.org")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const res = await fetch(event.request);
          if (res && (res.ok || res.type === "opaque")) {
            cache.put(event.request, res.clone());
          }
          return res;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // App shell: NETWORK-FIRST (selalu fresh saat online) dengan fallback cache (offline).
  if (event.request.method === "GET") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
