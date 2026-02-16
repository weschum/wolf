/* Wolf PWA Service Worker
   Versioned precache + sane caching strategies
*/
'use strict';

const SW_VERSION = 'v6';
const CACHE_STATIC = `wolf-static-${SW_VERSION}`;
const CACHE_PAGES  = `wolf-pages-${SW_VERSION}`;

// Update this list whenever you bump asset filenames (v2, v3, etc.)
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './service-worker.js',

  './assets/styles.css',
  './assets/app.js',

  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) => cache.addAll(PRECACHE_URLS))
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
  }
});

function isNavigationRequest(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

function isVersionedAsset(url) {
  return url.pathname.includes('/assets/') || url.pathname.includes('/icons/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle our own origin
  if (url.origin !== self.location.origin) return;

  // 1) HTML / navigations: network-first, fallback to cache
  if (isNavigationRequest(req)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_PAGES);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match('./index.html');
        return cached || caches.match('./');
      }
    })());
    return;
  }

  // 2) Versioned static assets: cache-first (fast), fallback network
  if (isVersionedAsset(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE_STATIC);
      cache.put(req, fresh.clone());
      return fresh;
    })());
    return;
  }

  // 3) Default: try cache, then network
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    return fetch(req);
  })());
});
