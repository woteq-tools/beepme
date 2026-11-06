/**
 * sw.js — service worker for Geofence Beep.
 *
 * Strategies
 *   navigation  : network-first (with navigation preload), fall back to the
 *                 cached shell so the app opens offline.
 *   app shell   : cache-first + background revalidate (instant, offline-safe).
 *   map tiles   : stale-while-revalidate into a separate, size-capped cache.
 *
 * Only tiles that were actually viewed are cached, which keeps the load on
 * the OpenStreetMap tile servers reasonable.
 */

const VERSION = 'v1.0.0';
const SHELL_CACHE = `geofence-beep-shell-${VERSION}`;
const TILE_CACHE = `geofence-beep-tiles-${VERSION}`;
const MAX_TILES = 800;
/** How long the service worker waits for the network before using the cache. */
const NETWORK_TIMEOUT_MS = 3000;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/audio.js',
  './js/geo.js',
  './js/map.js',
  './js/storage.js',
  './js/wakeLock.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

/* --------------------------------------------------------------- install */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll is atomic — one missing file would abort the whole install,
      // so each asset is added individually and failures are tolerated.
      await Promise.allSettled(
        SHELL_ASSETS.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: 'reload' }));
            if (res.ok) await cache.put(url, res);
          } catch {
            /* offline during install: the runtime cache will fill it in */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

/* -------------------------------------------------------------- activate */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith('geofence-beep-') && key !== SHELL_CACHE && key !== TILE_CACHE,
          )
          .map((key) => caches.delete(key)),
      );
      if ('navigationPreload' in self.registration) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {
          /* not supported everywhere */
        }
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/* ----------------------------------------------------------- tile cache */

/** Keep the tile cache bounded by deleting the oldest entries first. */
async function trimTileCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_TILES) return;
  const excess = keys.slice(0, keys.length - MAX_TILES);
  await Promise.all(excess.map((key) => cache.delete(key)));
}

/* ---------------------------------------------------------------- fetch */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // --- map tiles -------------------------------------------------------
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(tileStrategy(request));
    return;
  }

  // --- navigation ------------------------------------------------------
  if (request.mode === 'navigate') {
    event.respondWith(navigationStrategy(event));
    return;
  }

  // --- everything else (same-origin assets) ----------------------------
  if (url.origin === self.location.origin) {
    event.respondWith(shellStrategy(request));
  }
});

async function navigationStrategy(event) {
  const { request } = event;
  const cache = await caches.open(SHELL_CACHE);

  try {
    // A preloaded response resolves as soon as the network responds.
    const preload = await event.preloadResponse;
    if (preload) {
      cache.put('./index.html', preload.clone());
      return preload;
    }

    const network = await fetch(request);
    if (network && network.ok) cache.put('./index.html', network.clone());
    return network;
  } catch {
    return (
      (await cache.match('./index.html')) ||
      (await cache.match('./')) ||
      new Response(
        '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
          '<body style="font-family:system-ui;padding:2rem;background:#0b1220;color:#e8eefc">' +
          '<h1>Offline</h1><p>Open the app once while online so it can be cached for offline use.</p>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 },
      )
    );
  }
}

async function shellStrategy(request) {
  const cache = await caches.open(SHELL_CACHE);
  const url = new URL(request.url);

  // Never cache the worker itself — the browser manages its own updates.
  if (url.pathname.endsWith('/sw.js')) {
    return fetch(request).catch(() => new Response('', { status: 504 }));
  }

  const cached = await cache.match(request);

  // Network-first with a short timeout: the app always runs the code that is
  // actually deployed, and falls back to the cached copy when the network is
  // unavailable (which rejects immediately, so offline start-up is not delayed).
  const fresh = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS).then(async (response) => {
    if (response && response.ok && response.type === 'basic') {
      try {
        await cache.put(request, response.clone());
      } catch {
        /* quota or opaque response — ignore */
      }
    }
    return response;
  }).catch(() => null);

  if (fresh) return fresh;
  if (cached) return cached;
  return new Response('', { status: 504, statusText: 'Offline' });
}

/** fetch() with an AbortController timeout. */
async function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tileStrategy(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then(async (response) => {
      if (response && (response.ok || response.type === 'opaque')) {
        await cache.put(request, response.clone());
        trimTileCache(cache).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    network.catch(() => {});
    return cached;
  }

  const fresh = await network;
  if (fresh) return fresh;

  // Offline and uncached: a 1x1 transparent PNG keeps the map from breaking.
  return new Response(
    Uint8Array.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
      0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
      0x44, 0x00, 0x3b,
    ]),
    { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } },
  );
}
