// Network-first, cache as offline fallback (same approach as the finance tracker). Bump CACHE on each deploy.
const CACHE = 'langdon-v2026-10-05.3';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('langdon-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Cross-origin requests (the Worker / Companies House) are never touched.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) ??
        (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))
  );
});
