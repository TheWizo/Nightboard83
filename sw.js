const CACHE = "nightboard83-v26";
const ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./js/store.js",
  "./js/pouchdb.min.js",
  "./manifest.webmanifest",
  "./fonts/PressStart2P.woff2",
  "./fonts/PressStart2P-latin-ext.woff2",
  "./fonts/VT323.woff2",
  "./fonts/VT323-latin-ext.woff2",
  "./fonts/Caveat.woff2",
  "./icons/icon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => {
      if (!self.registration.active) return self.skipWaiting();
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function putInCache(request, res) {
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return res;
}

function isAppShell(request, url) {
  if (request.mode === "navigate") return true;
  const dest = request.destination;
  if (dest === "document" || dest === "script" || dest === "style" || dest === "manifest") return true;
  const path = url.pathname;
  return /\.(?:html|js|css|webmanifest)$/i.test(path) || /\/$/.test(path);
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const isConfig = /\/config\.json$/i.test(url.pathname);
  if (isConfig || isAppShell(event.request, url)) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((res) => putInCache(event.request, res))
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request)
        .then((res) => putInCache(event.request, res))
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
