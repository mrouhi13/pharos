// Bump CACHE when an icon or font changes; code and data are network-first.
const CACHE = "pharos-v16";
const SHELL = [
  "/",
  "/app.css",
  "/app.js",
  "/config.json",
  "/manifest.json",
  "/icons/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/fonts/JetBrainsMono-Variable.woff2",
  "/fonts/SpaceGrotesk-Variable.woff2",
];
const STATUS = "/data/status.json";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Network first; the saved copy is the offline fallback. "no-cache" revalidates, so an
// unchanged file is a tiny 304, and a copy is saved only when its ETag changed.
const saved = {};
function networkFirst(request, key, markCached) {
  return fetch(request, { cache: "no-cache" })
    .then((response) => {
      const tag = response.headers.get("etag");
      if (response.ok && (!tag || tag !== saved[key])) {
        saved[key] = tag;
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(key, copy));
      }
      return response;
    })
    .catch(() =>
      caches.match(key).then((cached) => {
        if (!cached || !markCached) return cached || Response.error();
        // Tell the page this is a saved copy so it shows the stale state.
        const headers = new Headers(cached.headers);
        headers.set("x-pharos-cache", "1");
        return cached.blob().then((body) => new Response(body, { status: 200, headers }));
      })
    );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // actions: always live, never cached

  if (url.pathname === STATUS) {
    event.respondWith(networkFirst(request, STATUS, true));
  } else if (request.mode === "navigate") {
    // Network-first keeps the bind-mounted dashboard live.
    event.respondWith(networkFirst(request, "/", false));
  } else if (/\.(js|css|json)$/.test(url.pathname)) {
    event.respondWith(networkFirst(request, url.pathname, false));
  } else {
    // Fonts and icons: cache-first.
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});
