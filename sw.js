/* Link Master Dungeon · service worker
   - index.html y manifest: primero la red (así siempre llegan las actualizaciones);
     si no hay internet se usa la copia guardada.
   - cartas, música y demás archivos: primero la copia guardada en el teléfono
     (se refrescan en segundo plano cuando hay internet).
   - la música se entrega por rangos (Range) para que suene sin conexión.
   - la descarga completa de cartas y música la hace la página (botón del lobby). */
const SHELL = 'lm-shell-v7', ASSETS = 'lm-assets';
const BASE = new URL('./', self.location).href;
const SHELL_FILES = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map(f => {
      const u = new URL(f, BASE).href;
      return fetch(u, { cache: 'reload' }).then(r => { if (r.ok) return c.put(u, r); }).catch(() => {});
    }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('lm-shell-') && k !== SHELL) await caches.delete(k);
  /* copias viejas de index/manifest que quedaron en lm-assets al guardar el juego: se borran */
  try{const as=await caches.open(ASSETS);for(const k of await as.keys()){const p=new URL(k.url).pathname;if(/\/(index\.html|manifest\.json)$/.test(p)||k.url===BASE)await as.delete(k)}}catch(_){}
  await self.clients.claim();
})()));

async function ranged(req, res) {
  const h = req.headers.get('range');
  if (!h || res.status !== 200) return res;
  const m = /bytes=(\d*)-(\d*)/.exec(h);
  if (!m) return res;
  const blob = await res.blob(), size = blob.size;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - +m[2]); end = size - 1; }
  else { start = +m[1]; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206, statusText: 'Partial Content',
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

const REFRESCADAS = new Set(); /* cada archivo se revisa en la red una sola vez por sesión del service worker */
async function refresh(url) {
  if (REFRESCADAS.has(url)) return;
  REFRESCADAS.add(url);
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok && res.status === 200) (await caches.open(ASSETS)).put(url, res);
  } catch (_) {}
}

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const font = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (u.origin !== location.origin && !font) return;

  /* index.html / manifest: red primero. Sin internet se usa SIEMPRE la copia más reciente guardada en el shell
     (antes caches.match podía devolver una copia vieja que quedó en lm-assets al guardar el juego). */
  if (r.mode === 'navigate' || /\/(index\.html|manifest\.json|version\.json)$/.test(u.pathname)) {
    e.respondWith((async () => {
      try {
        const res = await fetch(r, { cache: 'no-cache' });
        if (res.ok) {
          const sh = await caches.open(SHELL), as = await caches.open(ASSETS), idx = new URL('index.html', BASE).href;
          await sh.put(r, res.clone());
          if (r.mode === 'navigate') await sh.put(idx, res.clone());
          /* si lm-assets ya tiene una copia de este archivo, se actualiza para que no quede vieja */
          for (const k of [r.url, ...(r.mode === 'navigate' ? [idx, BASE] : [])]) if (await as.match(k)) await as.put(k, res.clone());
        }
        return res;
      } catch (_) {
        const sh = await caches.open(SHELL);
        return (await sh.match(r, { ignoreSearch: true })) ||
               (await sh.match(new URL('index.html', BASE).href)) ||
               (await sh.match(BASE)) ||
               (await caches.match(r, { ignoreSearch: true })) ||
               (await caches.match(new URL('index.html', BASE).href)) ||
               Response.error();
      }
    })());
    return;
  }

  /* descargas pedidas por el juego para actualizar (cache: reload / no-store): siempre a la red */
  if (r.cache === 'reload' || r.cache === 'no-store') {
    e.respondWith(fetch(r).catch(() => Response.error()));
    return;
  }

  /* resto: copia guardada primero */
  e.respondWith((async () => {
    const hit = await caches.match(r.url, { ignoreSearch: true });
    if (hit) {
      if (!font && !r.headers.has('range') && !/\.(mp3|ogg|m4a|wav)$/i.test(u.pathname)) e.waitUntil(refresh(r.url));
      return ranged(r, hit);
    }
    try {
      const res = await fetch(r);
      const guardable = (res.ok && res.status === 200) || (font && res.type === 'opaque');
      if (guardable && !r.headers.has('range')) (await caches.open(ASSETS)).put(r.url, res.clone());
      return res;
    } catch (_) {
      return Response.error();
    }
  })());
});
