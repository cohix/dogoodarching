// Do Good Arching service worker — app shell caching only.
//
// This file is NOT served from `public/`: the `serviceWorkerCache` plugin in
// vite.config.ts emits it as `dist/client/sw.js` with `__BUILD_HASH__` replaced
// by a hash of the final HTML, assets, public files and this source. Every deploy that changes the app therefore
// gets a new cache name, and `activate` below deletes every other cache
// (including the pre-hash `dga-shell-v1`), so users upgrade cleanly.
//
// Rules:
// - `/api/*` is NEVER cached: every API request goes straight to the network,
//   because the Worker/D1 backend is always the source of truth.
// - Navigations (`/invite#<token>` and legacy `/invite/<token>` links use the
//   Worker's SPA fallback) serve the shell offline and refresh it online.
//   Fragments never reach the network or cache keys. Returning the shell does
//   not redirect or rewrite the browser URL; the SPA captures and scrubs tokens.
// - Built assets under `/assets/` are runtime-cached cache-first.

const CACHE_NAME = "dga-shell-__BUILD_HASH__";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

// Delete every cache that isn't this build's (older `dga-shell-<hash>` caches
// and the legacy `dga-shell-v1`), then take control of open clients.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle same-origin GETs.
  if (url.origin !== self.location.origin || request.method !== "GET") return;

  // The API is always the source of truth — never serve or store API responses.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations ("/", "/invite", legacy paths, …): network first so deep links
  // load fresh; cache only under /index.html, never under an invite token.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }

  // Built assets (hashed JS/CSS/images): cache-first, then network.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
