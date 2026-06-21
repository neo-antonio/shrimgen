// sw.js — ShrimGen service worker
// Only caches the small app shell (HTML/CSS/JS/icons) so the UI loads offline.
// Model weights are fetched from Hugging Face by the WebLLM library itself and
// cached via the browser's own Cache/IndexedDB storage — we deliberately leave
// those cross-origin requests alone here.

const CACHE_NAME = "shrimgen-shell-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./ai-engine.js",
  "./manifest.json",
  "./icons/favicon.png",
  "./icons/favicon-64.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch((err) => {
      console.warn("ShrimGen SW: app shell cache failed", err);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only manage same-origin GET requests for the app shell.
  // Everything else (CDN scripts, Hugging Face model weights, etc.) is left
  // untouched so WebLLM's own caching logic works as intended.
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
