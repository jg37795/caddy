/* sw.js — offline-first service worker for the Caddy PWA.
 *
 * Shell + self-hosted Leaflet : cache-first (precached on install)
 * Map tiles                   : stale-while-revalidate, capped
 * Navigations                 : serve cached app shell offline
 * Versioned cleanup + skipWaiting/clients.claim for instant updates.
 *
 * BUMP CACHE_VERSION ON EVERY DEPLOY.
 */
const CACHE_VERSION = "v1.0.0";
const SHELL_CACHE = `caddy-shell-${CACHE_VERSION}`;
const TILE_CACHE = `caddy-tiles-${CACHE_VERSION}`;
const CURRENT = new Set([SHELL_CACHE, TILE_CACHE]);

const MAX_TILE_ENTRIES = 400; // FIFO cap; opaque tiles pad quota heavily

// Same-origin shell. SELF-HOST Leaflet for reliable offline (see notes).
const APP_SHELL = ["./", "./index.html"];

const isTile = (url) =>
  /\/\d+\/\d+\/\d+(@2x)?\.(png|jpg|jpeg|webp)(\?|$)/i.test(url.pathname) ||
  /(tile\.|tiles\.|arcgisonline|openstreetmap|cartocdn|mapbox|maptiler|stadiamaps)/i.test(
    url.hostname,
  );

const cacheable = (res) => !!res && (res.ok || res.type === "opaque");

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Per-asset so one missing optional file doesn't fail the whole install.
      await Promise.all(
        APP_SHELL.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: "reload" }));
            if (cacheable(res)) await cache.put(url, res);
          } catch (err) {
            /* optional asset — ignore */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => (CURRENT.has(k) ? null : caches.delete(k))),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return; // never touch POST/etc.
  const url = new URL(request.url);

  // fetch handler — navigations:
  if (request.mode === "navigate") {
    e.respondWith(cacheFirst(new Request("./index.html"), SHELL_CACHE));
    return;
  }
  // Map tiles → SWR, capped.
  if (isTile(url)) {
    e.respondWith(staleWhileRevalidate(e, request, TILE_CACHE));
    return;
  }
  // Same-origin assets → cache-first (picks up shell + anything fetched).
  if (url.origin === self.location.origin) {
    e.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }
  // Other cross-origin → network, fall back to any cache hit.
  e.respondWith(fetch(request).catch(() => caches.match(request)));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (cacheable(res)) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    // cacheFirst catch:
    return (
      (await cache.match("./index.html")) ||
      new Response("Offline", { status: 503 })
    );
  }
}

async function staleWhileRevalidate(event, request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (cacheable(res)) {
        cache.put(request, res.clone()).catch(() => {});
        event.waitUntil(trimCache(cacheName, MAX_TILE_ENTRIES));
      }
      return res;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || new Response("", { status: 504 });
}

async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  // keys() is roughly insertion-ordered → evict oldest (FIFO).
  await Promise.all(
    keys.slice(0, keys.length - max).map((k) => cache.delete(k)),
  );
}
