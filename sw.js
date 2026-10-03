const CACHE = 'mesa-v2';
const ASSETS = [
  '/juego-de-mesa/',
  '/juego-de-mesa/index.html',
  '/juego-de-mesa/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(ASSETS.map(u => fetch(u, { cache: 'reload' }).then(r => c.put(u, r)).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Red primero: siempre baja la versión nueva; la copia guardada solo se usa sin internet.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  // el audio (peticiones por rangos) lo maneja directamente el navegador
  if (e.request.headers.has('range') || e.request.destination === 'audio') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(r => {
        const copia = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
