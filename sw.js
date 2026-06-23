// sw.js - ShrimGen service worker
// Caches the small app shell (HTML/CSS/JS/icons) as an OFFLINE FALLBACK only.
// The primary strategy is network-first, so a fresh deploy is picked up on
// the very next load instead of serving a stale cached copy. Model weights
// are fetched from Hugging Face by the WebLLM library itself and cached via
// the browser's own Cache/IndexedDB storage; we deliberately leave those
// cross-origin requests alone here.

const CACHE_NAME = "shrimgen-shell-v0.5";
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
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.warn("ShrimGen SW: app shell cache failed", err))
  );
  // Activate this new worker as soon as it finishes installing, instead of
  // waiting for all tabs to close; this is what makes updates show up fast.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  // Take control of any already-open tabs immediately.
  self.clients.claim();
});

// Lets the page force this worker to activate right away (see app.js).
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
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

  // Network-first: always try to get the latest file. Only fall back to the
  // cached copy if the network is unavailable (offline), so deployed updates
  // are reflected on the very next load rather than staying stale.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});