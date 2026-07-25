// EZ Money Manager service worker — offline app shell.
const CACHE = 'ezmoney-v2';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './defaults.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // never cache app data or Firestore/Auth traffic — must hit the network
  if (url.pathname.startsWith('/api/') ||
      /firestore\.googleapis\.com|firebaseio\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com/.test(url.host)) {
    return; // default network handling
  }

  // navigations: network-first, fall back to cached shell (offline)
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // firebase-config.js: always network-first so config edits take effect immediately
  if (url.pathname.endsWith('/firebase-config.js')) {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req)));
    return;
  }

  // same-origin shell + cross-origin static (fonts, firebase SDK): cache-first, then fill cache
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200 && (url.origin === location.origin ||
          /gstatic\.com|googleapis\.com\/css|fonts\./.test(url.host))) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => hit))
  );
});
