/* Nightboard '83 — service worker
   Copyright (C) 2026 Ralf Wissing
   SPDX-License-Identifier: AGPL-3.0-or-later */
const CACHE = "nightboard83-v56";
const ASSETS = [
  "./",
  "./index.html",
  "./LICENSE",
  "./css/app.css",
  "./js/app.js",
  "./js/store.js",
  "./js/core.js",
  "./js/i18n.js",
  "./js/translate.js",
  "./assets/bergamot/translator.js",
  "./assets/bergamot/registry.json",
  "./assets/bergamot/worker/translator-worker.js",
  "./assets/bergamot/worker/bergamot-translator-worker.js",
  "./assets/bergamot/worker/bergamot-translator-worker.wasm",
  "./js/pouchdb.min.js",
  "./i18n/de.json",
  "./i18n/en.json",
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
  return /\.(?:html|js|css|webmanifest|json)$/i.test(path) || /\/$/.test(path);
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
