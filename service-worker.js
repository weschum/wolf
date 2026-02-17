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

   1) Update SW_VERSION below (e.g., v2.17.4)

   2) Rename versioned asset files in /assets/:
        - styles.vX.X.X.css
        - app.vX.X.X.js

   3) Update <link> + <script> references in index.html:
        ./assets/styles.vX.X.X.css
        ./assets/app.vX.X.X.js

   4) Update the PRECACHE_URLS list in this file
      to match the new filenames.

   5) (Optional but recommended)
      Update the visible fallback version text in index.html
      inside #appVersion.

   This ensures:
     • Browsers fetch new JS/CSS immediately
     • Old caches are invalidated safely
     • PWA update banner works correctly
   ============================================================
*/
'use strict';

const SW_VERSION = 'v2.17.5';

const CACHE_STATIC = `wolf-static-${SW_VERSION}`;
const CACHE_PAGES  = `wolf-pages-${SW_VERSION}`;

// Update this list whenever you bump asset filenames (v2, v3, etc.)
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',

  // DO NOT precache the service worker itself:
  // './service-worker.js',

  './assets/styles.2.17.5.css',
  './assets/app.2.17.5.js',

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
  //    bypass HTTP cache, fallback to cache
  if (isNavigationRequest(req)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch('./index.html', { cache: 'reload' });
        const cache = await caches.open(CACHE_PAGES);
        await cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match('./index.html');
        return cached || caches.match('./');
      }
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
          const cache = await caches.open(CACHE_STATIC);
          await cache.put(req, fresh.clone());
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
