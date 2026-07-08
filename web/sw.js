/*
 * CyberSygn service worker.
 *
 * Goal: make the app open instantly and survive a flaky connection, WITHOUT
 * ever serving stale document data or caching anything private.
 *
 * Rules:
 *   - Only GET requests are touched. Everything else goes straight to network.
 *   - /api/* , anything with a query string, and cross-origin requests are
 *     NEVER cached (auth links, API calls, PDF bytes, Stripe, etc.).
 *   - HTML navigations are network-first (fresh content), falling back to a
 *     cached copy and finally an offline page.
 *   - Static shell assets (css/js/png/svg/woff) are stale-while-revalidate:
 *     instant from cache, refreshed in the background.
 *
 * Bump CACHE_VERSION to invalidate everything on the next visit.
 */

const CACHE_VERSION = 'cybersygn-v2';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  OFFLINE_URL,
  '/styles.css',
  '/shared/app-shell.css',
  '/shared/app-shell.js',
  '/brand/icon-192.png',
  '/brand/mark-white@2x.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Best-effort precache: a single 404 must not abort the whole install.
      Promise.allSettled(PRECACHE.map((u) => cache.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isCacheableStatic(url) {
  return /\.(css|js|png|jpg|jpeg|svg|webp|ico|woff2?|ttf)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never touch cross-origin, API, or anything carrying a query token.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.search && url.search.length > 0) return;

  const isNavigation = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    // Network-first so document data + marketing copy stay fresh.
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only cache a real, same-origin 200. Never write a 4xx/5xx error
          // page or a redirect into the cache, or it would later be served as
          // the offline fallback.
          if (res && res.status === 200 && (res.type === 'basic' || res.type === 'default')) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match(OFFLINE_URL))
        )
    );
    return;
  }

  if (isCacheableStatic(url)) {
    // Stale-while-revalidate for the static shell.
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(req).then((hit) => {
          const network = fetch(req)
            .then((res) => {
              if (res && res.status === 200) cache.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || network;
        })
      )
    );
  }
});
