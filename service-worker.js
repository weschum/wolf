/* Wolf PWA Service Worker
   Versioned precache + sane caching strategies
*/
'use strict';

/* Wolf PWA Service Worker
   Versioned precache + sane caching strategies
   ============================================================
   VERSION BUMP CHECKLIST
   ============================================================
   When releasing a new version:

   1) Rename versioned asset files in /assets/ FIRST:
        - styles.vX.X.X.css
        - app.vX.X.X.js

      (The app version shown in the UI is derived from app.vX.X.X.js)

   2) Update <link> + <script> references in index.html:
        ./assets/styles.vX.X.X.css
        ./assets/app.vX.X.X.js

   3) Update SW_VERSION below (must match the same version).

   4) Update the PRECACHE_URLS list in this file
      to match the new filenames.

   IMPORTANT:
     • All version numbers must match exactly.
     • If filenames and SW_VERSION differ, update behavior may break.

   This ensures:
     • Browsers fetch new JS/CSS immediately
     • Old caches are invalidated safely
     • The displayed version always matches the loaded build
     • The PWA update banner works correctly
   ============================================================
*/
'use strict';

const SW_VERSION = 'v2.21.1';

const CACHE_STATIC = `wolf-static-${SW_VERSION}`;
const CACHE_PAGES  = `wolf-pages-${SW_VERSION}`;

// How long a page load waits for the network before using the cached shell
const NAV_TIMEOUT_MS = 3000;

// Update this list whenever you bump asset filenames (v2, v3, etc.)
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',

  // DO NOT precache the service worker itself:
  // './service-worker.js',

  './assets/styles.2.21.1.css',
  './assets/app.2.21.1.js',

  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_STATIC);
      await cache.addAll(PRECACHE_URLS);
      // Keep your current flow: activation happens when user taps Update Now (SKIP_WAITING)
      // self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith('wolf-') && k !== CACHE_STATIC && k !== CACHE_PAGES)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Allow the page to tell the SW to activate immediately
self.addEventListener('message', (event) => {
  const msg = event?.data;

  if (msg === 'SKIP_WAITING' || msg?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (msg === 'GET_VERSION' || msg?.type === 'GET_VERSION') {
    const payload = { type: 'VERSION', version: SW_VERSION };

    // Prefer replying to the sender, but fall back to broadcasting
    if (event.source?.postMessage) {
      event.source.postMessage(payload);
    } else {
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clients => clients.forEach(c => c.postMessage(payload)))
        .catch(() => {});
    }
  }
});

function isNavigationRequest(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

function isStaticAsset(url) {
  // Your app currently uses /assets/... (including icons under /assets/icons/)
  return url.pathname.includes('/assets/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle our own origin
  if (url.origin !== self.location.origin) return;

  // Never intercept the service worker file itself
  if (url.pathname.endsWith('/service-worker.js')) return;

  // 1) HTML / navigations: network-first for the SPA shell (index.html),
  //    bypass HTTP cache, fall back to cache. On a weak signal the network
  //    can stall for a long time, so give up after NAV_TIMEOUT_MS and serve
  //    the cached shell while the fetch keeps refreshing the cache.
  if (isNavigationRequest(req)) {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html') || await caches.match('./');

      const network = (async () => {
        try {
          const fresh = await fetch('./index.html', { cache: 'reload' });
          // Never overwrite the good shell with an error page
          if (fresh.ok) {
            const cache = await caches.open(CACHE_PAGES);
            await cache.put('./index.html', fresh.clone());
            return fresh;
          }
          return cached ? null : fresh;
        } catch {
          return null;
        }
      })();

      // Nothing cached yet: all we can do is wait for the network
      if (!cached) return (await network) || Response.error();

      event.waitUntil(network);
      const timeout = new Promise(resolve => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
      return (await Promise.race([network, timeout])) || cached;
    })());
    return;
  }

  // 2) Static assets: stale-while-revalidate
  if (isStaticAsset(url) && req.method === 'GET') {
    event.respondWith((async () => {
      const cached = await caches.match(req);

      const fetchAndUpdate = (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh.ok) {
            const cache = await caches.open(CACHE_STATIC);
            await cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          return null;
        }
      })();

      // Return cached immediately if present; otherwise wait for network
      if (cached) {
        // Update in background (don’t block response)
        event.waitUntil(fetchAndUpdate);
        return cached;
      }

      const fresh = await fetchAndUpdate;
      return fresh || fetch(req);
    })());
    return;
  }

  // 3) Default: cache-first then network
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    return fetch(req);
  })());
});
