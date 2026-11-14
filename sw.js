// Service worker: makes the app work offline.
//
// - Our own files (page, app.jsx, data): network first, so a new deploy shows
//   up straight away when online; the cached copy is the fallback when the
//   network is down or takes longer than 4 seconds.
// - Libraries and fonts from CDNs: cache first. Their URLs are version-pinned,
//   so a cached copy never goes stale.
//
// Keep SHELL in sync with the files in data/ and CDN in sync with index.html.
// A file missing from SHELL still gets cached the first time it is fetched.
const CACHE = "b1b2-v1";
const SHELL = [
  "./", "./index.html", "./app.jsx", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/apple-touch-icon.png",
  "./data/vocab.json", "./data/verbs.json", "./data/verb_sentences.json",
  "./data/expressions.json", "./data/expression_sentences.json",
  "./data/nuances.json", "./data/podcast.json",
];
const CDN = [
  "https://unpkg.com/react@18.3.1/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js",
  "https://unpkg.com/@babel/standalone@7.26.4/babel.min.js",
];
const CDN_HOSTS = /^(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(SHELL);
    await Promise.allSettled(CDN.map(u => c.add(u))); // best effort
    await self.skipWaiting();
  }));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin) e.respondWith(networkFirst(e.request));
  else if (CDN_HOSTS.test(url.hostname)) e.respondWith(cacheFirst(e.request));
});
