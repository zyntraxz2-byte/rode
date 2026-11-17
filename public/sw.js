'use strict';
/*
 * Rode service worker. Makes the app installable and lets the shell open offline.
 * Business data is NEVER cached here: /api and /_blob always go to the network, so nothing
 * private is left on the device after sign-out and nothing stale is shown as live.
 * Bump VERSION when the shell files change in a way the revalidation below would not pick up.
 */
const VERSION = 'v1';
const SHELL_CACHE = `rode-shell-${VERSION}`;
const SHELL = ['/', '/app.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/offline.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('rode-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                       // fonts etc: browser default
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_blob/')) return; // private data: network only
  if (url.pathname === '/sw.js' || url.pathname === '/healthz' || url.pathname === '/readyz') return;

  if (req.mode === 'navigate') {
    // network first so deployments show up immediately; fall back to the cached shell, then the offline page
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put('/', copy)); }
        return res;
      }).catch(async () => (await caches.match('/')) || (await caches.match('/offline.html'))),
    );
    return;
  }

  // static files: serve cached copy immediately, refresh it in the background
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const refresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
      if (hit) { refresh.catch(() => {}); return hit; }
      return refresh;
    }),
  );
});
