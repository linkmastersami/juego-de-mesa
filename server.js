/* Servidor de salas para Link Master (2 jugadores). Corre en Render.
   Reconexión: si un jugador pierde la conexión, su lugar se guarda GRACIA ms. Al volver con su
   código de sala + token (mensaje "resume") sigue la partida donde se quedó. */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const fs = require('fs');
const path = require('path');
let webpush = null; try { webpush = require('web-push'); } catch {}

const GRACIA = (+process.env.GRACIA_MS) || 90 * 1000;

/* ---- avisos push (opcionales): se activan con las variables VAPID_PRIVATE (y NOTIFY_KEY para avisar de actualizaciones) ---- */
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || 'BIyNaaaLkcqYomZkvKt6Rp1u9Oy3lx725RtEJ-DoNOdT6uBddUBY8G_ian368mrIVy8pgpk2BDQtSl1a21XW9uU';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
const pushOn = !!(webpush && VAPID_PRIVATE);
if (pushOn) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://linkmastersami.github.io/juego-de-mesa/', VAPID_PUBLIC, VAPID_PRIVATE);
/* ---- respaldo en GitHub (rama "datos" del repositorio): nombres de jugadores y suscripciones de avisos.
   Render borra su disco en cada reinicio; con GH_TOKEN los datos se recuperan al arrancar. ---- */
const GH_TOKEN = process.env.GH_TOKEN || '', GH_REPO = process.env.GH_REPO || 'linkmastersami/juego-de-mesa', GH_BRANCH = process.env.GH_BRANCH || 'datos';
const GH_SHA = {};
async function ghGet(file) {
  if (!GH_TOKEN) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${file}?ref=${GH_BRANCH}`, { headers: { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'link-master', Accept: 'application/vnd.github+json' } });
    if (!r.ok) return null;
    const j = await r.json(); GH_SHA[file] = j.sha;
    return JSON.parse(Buffer.from(j.content || '', 'base64').toString('utf8'));
  } catch { return null; }
}
const GH_T = {};
function ghPut(file, getData) { /* agrupa cambios: se sube como máximo cada 15 s */
  if (!GH_TOKEN || GH_T[file]) return;
  GH_T[file] = setTimeout(async () => {
    GH_T[file] = null;
    for (let i = 0; i < 2; i++) {
      try {
        const body = { message: 'datos: ' + file, branch: GH_BRANCH, content: Buffer.from(JSON.stringify(getData())).toString('base64') };
        if (GH_SHA[file]) body.sha = GH_SHA[file];
        const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${file}`, { method: 'PUT', headers: { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'link-master', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.ok) { GH_SHA[file] = (await r.json()).content.sha; return; }
        if (r.status === 409 || r.status === 422) { await ghGet(file); continue; } /* la copia cambió: se toma su sha y se reintenta */
        return;
      } catch { return; }
    }
  }, 15000);
}
const SUBS_FILE = path.join(__dirname, 'subs.json');
const SUBS = new Map(); /* endpoint -> suscripción */
try { JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')).forEach(s => s && s.endpoint && SUBS.set(s.endpoint, s)); } catch {}
const saveSubs = () => { try { fs.writeFileSync(SUBS_FILE, JSON.stringify([...SUBS.values()])); } catch {} ghPut('subs.json', () => [...SUBS.values()]); };
/* ---- nombres de jugadores: únicos, 3 a 8 letras o números, en mayúsculas ----
   El teléfono guarda su nombre y una clave secreta; aquí solo se guarda el hash de la clave. */
const NAMES = new Map(); /* NOMBRE -> { h: hash de la clave, t: fecha de registro } */
const hashK = k => crypto.createHash('sha256').update(String(k)).digest('hex');
const okName = n => typeof n === 'string' && /^[A-Z0-9Ñ]{3,8}$/.test(n);
const BAD = ['PUTO','PUTA','PUTI','PENDEJ','PENDJ','PNDJ','PENDE','VERGA','VRGA','CULO','CULER','PINCHE','CHINGA','CHNGA','MAMON','MAMADA','JOTO','PANOCH','PITO','CABRON','CBRN','COJER','COGER','ZORRA','PERRA','NAZI','HITLER','FUCK','SHIT','BITCH','DICK','PUSSY','CUNT','NIGG','NIGA','SEX','XXX','PORN','PORNO','ANAL','TETA','TETAS','MIERDA','MRDA','VIOLA','PEDO','KK','CACA','IDIOTA','ESTUPID','IMBECIL','MARICA','MARICO','PUTAZO','CHUPA','POLLA','COÑO','CONO','HDP','PTM','ALV','NMMS','VTV'];
const norm = n => n.replace(/0/g, 'O').replace(/1/g, 'I').replace(/3/g, 'E').replace(/4/g, 'A').replace(/5/g, 'S').replace(/7/g, 'T').replace(/8/g, 'B').replace(/Ñ/g, 'N');
const badName = n => { const a = norm(n); return BAD.some(w => a.includes(norm(w)) || n.includes(w)); };
const saveNames = () => ghPut('nombres.json', () => Object.fromEntries(NAMES));
(async () => {
  const nm = await ghGet('nombres.json'); if (nm && typeof nm === 'object') Object.entries(nm).forEach(([n, v]) => { if (okName(n) && v && v.h) NAMES.set(n, v); });
  const sb = await ghGet('subs.json'); if (Array.isArray(sb)) { sb.forEach(s => s && s.endpoint && !SUBS.has(s.endpoint) && SUBS.set(s.endpoint, s)); try { fs.writeFileSync(SUBS_FILE, JSON.stringify([...SUBS.values()])); } catch {} }
  console.log('Datos cargados:', NAMES.size, 'nombres,', SUBS.size, 'suscripciones', GH_TOKEN ? '(respaldo en GitHub activo)' : '(sin GH_TOKEN: solo memoria)');
})();
async function pushAll(payload, skip) {
  if (!pushOn) return 0;
  let n = 0;
  await Promise.all([...SUBS.values()].filter(s => s.endpoint !== skip).map(async s => {
    try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600 }); n++; }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) { SUBS.delete(s.endpoint); saveSubs(); } }
  }));
  return n;
}
const PERF = new Map(); /* código -> { d: perfil, t } (solo en memoria, 30 min) */
const PLAZA = new Map(); /* NOMBRE -> { a: guerrero, t: última vez visto } (solo en memoria) */
const AVS = ['arquera', 'barbaro', 'guerrero', 'mago', 'ninja', 'paladin'];
/* aviso a un jugador en particular (todos sus teléfonos registrados) */
async function pushTo(name, payload) {
  const u = NAMES.get(name); if (!pushOn || !u || !Array.isArray(u.ep)) return 0;
  let n = 0;
  for (const ep of u.ep.slice()) {
    const s = SUBS.get(ep); if (!s) { u.ep = u.ep.filter(x => x !== ep); continue; }
    try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 600 }); n++; }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) { SUBS.delete(ep); u.ep = u.ep.filter(x => x !== ep); saveSubs(); } }
  }
  return n;
}
const LAST = new Map(); /* NOMBRE -> última vez que abrió el juego (para "conectado") */
const INV = new Map();  /* NOMBRE invitado -> [{ de, c, t }] */
let lastQuickPush = 0, lastUpdPush = 0;
const readBody = (req, cb, max = 4096) => { let b = ''; req.on('data', d => { b += d; if (b.length > max) req.destroy(); }); req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { cb(null); } }); };
const waiting = () => [...rooms.entries()].filter(([, r]) => r.pub && !r.guest && !r.gone.guest && r.host && r.host.readyState === 1);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-key');
  const url = (req.url || '').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  /* registrar un nombre nuevo (respuesta: ok | taken | bad) */
  if (req.method === 'POST' && url === '/name/claim') {
    return readBody(req, b => {
      const n = b && String(b.n || '').toUpperCase(), k = b && String(b.k || '');
      const out = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!okName(n) || k.length < 16) return out({ r: 'bad' });
      if (badName(n)) return out({ r: 'rude' });
      const cur = NAMES.get(n), h = hashK(k);
      if (cur && cur.h !== h) return out({ r: 'taken' });
      if (!cur) { if (NAMES.size > 20000) return out({ r: 'full' }); NAMES.set(n, { h, t: Date.now() }); saveNames(); }
      out({ r: 'ok' });
    });
  }
  /* al abrir el juego: el teléfono confirma su nombre (si el servidor lo había olvidado, se vuelve a registrar) */
  if (req.method === 'POST' && url === '/name/hello') {
    return readBody(req, b => {
      const n = b && String(b.n || '').toUpperCase(), k = b && String(b.k || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!okName(n) || k.length < 16) return res.end(JSON.stringify({ r: 'bad' }));
      const cur = NAMES.get(n), h = hashK(k);
      if (cur && cur.h !== h) return res.end(JSON.stringify({ r: 'taken' }));
      if (!cur) { NAMES.set(n, { h, t: Date.now() }); saveNames(); }
      res.end(JSON.stringify({ r: 'ok' }));
    });
  }
  /* pasar el perfil a otra dirección del juego: se guarda 30 min con un código de 6 letras */
  if (req.method === 'POST' && url === '/perfil/subir') {
    return readBody(req, b => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const d = b && b.d;
      if (!d || typeof d !== 'object') return res.end(JSON.stringify({ r: 'bad' }));
      const now = Date.now();
      for (const [c, v] of PERF) if (now - v.t > 30 * 60000) PERF.delete(c);
      if (PERF.size > 500) return res.end(JSON.stringify({ r: 'full' }));
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c;
      do { c = ''; for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)]; } while (PERF.has(c));
      PERF.set(c, { d, t: now });
      res.end(JSON.stringify({ r: 'ok', c }));
    }, 400000);
  }
  if (req.method === 'POST' && url === '/perfil/bajar') {
    return readBody(req, b => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const c = b && String(b.c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), v = PERF.get(c);
      if (!v || Date.now() - v.t > 30 * 60000) return res.end(JSON.stringify({ r: 'none' }));
      PERF.delete(c); res.end(JSON.stringify({ r: 'ok', d: v.d }));
    });
  }
  /* el jugador borra su perfil: se libera su nombre */
  if (req.method === 'POST' && url === '/name/delete') {
    return readBody(req, b => {
      const n = b && String(b.n || '').toUpperCase(), k = b && String(b.k || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const cur = okName(n) && NAMES.get(n);
      if (!cur || cur.h !== hashK(k)) return res.end(JSON.stringify({ r: 'bad' }));
      NAMES.delete(n); PLAZA.delete(n); INV.delete(n);
      for (const v of NAMES.values()) { if (Array.isArray(v.f)) v.f = v.f.filter(x => x !== n); if (Array.isArray(v.rq)) v.rq = v.rq.filter(x => x !== n); }
      saveNames();
      res.end(JSON.stringify({ r: 'ok' }));
    });
  }
  /* plaza de la Comunidad: cada teléfono avisa que está ahí (con su guerrero) y recibe a los demás que están ahora */
  if (req.method === 'POST' && url === '/plaza') {
    return readBody(req, b => {
      const n = b && String(b.n || '').toUpperCase(), k = b && String(b.k || ''), av = b && String(b.a || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const cur = okName(n) && NAMES.get(n);
      if (!cur || cur.h !== hashK(k)) return res.end(JSON.stringify({ r: 'bad' }));
      const a = AVS.includes(av) ? av : 'guerrero', now = Date.now();
      if (cur.a !== a) { cur.a = a; saveNames(); }
      LAST.set(n, now); const old = PLAZA.get(n) || {};
      const em = typeof b.e === 'string' && b.e.length <= 24 ? { e: b.e, et: now } : (old.et && now - old.et < 6000 ? { e: old.e, et: old.et } : {});
      if (b.bye) PLAZA.delete(n); else PLAZA.set(n, { a, t: now, ...em });
      for (const [m, v] of PLAZA) if (now - v.t > 30000) PLAZA.delete(m);
      const p = [...PLAZA.entries()].filter(([m]) => m !== n).sort((x, y) => y[1].t - x[1].t).slice(0, 14).map(([m, v]) => ({ n: m, a: v.a, e: v.et && now - v.et < 6000 ? v.e : undefined, et: v.et }));
      res.end(JSON.stringify({ r: 'ok', p, total: PLAZA.size }));
    });
  }
  /* ---- amigos: solicitudes, lista, invitaciones (todo con nombre + clave) ---- */
  if (req.method === 'POST' && url.startsWith('/amigos')) {
    return readBody(req, b => {
      const out = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const n = b && String(b.n || '').toUpperCase(), k = b && String(b.k || ''), me = okName(n) && NAMES.get(n);
      if (!me || me.h !== hashK(k)) return out({ r: 'bad' });
      const now = Date.now(); LAST.set(n, now);
      me.f = Array.isArray(me.f) ? me.f : []; me.rq = Array.isArray(me.rq) ? me.rq : [];
      if (typeof b.ep === 'string' && /^https:\/\//.test(b.ep) && SUBS.has(b.ep)) { me.ep = Array.isArray(me.ep) ? me.ep : []; if (!me.ep.includes(b.ep)) { me.ep.push(b.ep); me.ep = me.ep.slice(-3); saveNames(); } }
      const a = String(b.a || '').toUpperCase(), ot = a && okName(a) && NAMES.get(a);
      const fix = u => { u.f = Array.isArray(u.f) ? u.f : []; u.rq = Array.isArray(u.rq) ? u.rq : []; };
      if (url === '/amigos/pedir') {
        if (!ot || a === n) return out({ r: 'none' }); fix(ot);
        if (me.f.includes(a)) return out({ r: 'ya' });
        if (me.rq.includes(a)) { me.rq = me.rq.filter(x => x !== a); me.f.push(a); ot.f.push(n); ot.rq = ot.rq.filter(x => x !== n); saveNames(); pushTo(a, { kind: 'amigo', title: 'Link Master Dungeon', body: `🤝 ${n} y tú ahora son amigos` }); return out({ r: 'amigos' }); }
        if (!ot.rq.includes(n)) { if (ot.rq.length > 50) return out({ r: 'full' }); ot.rq.push(n); saveNames(); pushTo(a, { kind: 'amigo', title: 'Link Master Dungeon', body: `👋 ${n} quiere ser tu amigo` }); }
        return out({ r: 'ok' });
      }
      if (url === '/amigos/resp') {
        if (!me.rq.includes(a)) return out({ r: 'none' });
        me.rq = me.rq.filter(x => x !== a);
        if (b.ok && ot) { fix(ot); if (!me.f.includes(a)) me.f.push(a); if (!ot.f.includes(n)) ot.f.push(n); pushTo(a, { kind: 'amigo', title: 'Link Master Dungeon', body: `🤝 ${n} aceptó tu solicitud de amistad` }); }
        saveNames(); return out({ r: 'ok' });
      }
      if (url === '/amigos/quitar') {
        me.f = me.f.filter(x => x !== a); if (ot) { fix(ot); ot.f = ot.f.filter(x => x !== n); } saveNames(); return out({ r: 'ok' });
      }
      if (url === '/amigos/invitar') {
        const c = String(b.c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!ot || !me.f.includes(a) || !c) return out({ r: 'none' });
        const L = (INV.get(a) || []).filter(x => x.de !== n && now - x.t < 10 * 60000); L.push({ de: n, c, t: now }); INV.set(a, L);
        pushTo(a, { kind: 'inv', sala: c, title: 'Link Master Dungeon', body: `⚔️ ${n} te está esperando para jugar` });
        return out({ r: 'ok' });
      }
      if (url === '/amigos/noinv') { INV.set(n, (INV.get(n) || []).filter(x => x.de !== a)); return out({ r: 'ok' }); }
      /* /amigos: estado completo */
      const on = m => now - (LAST.get(m) || 0) < 45000;
      const inv = (INV.get(n) || []).filter(x => now - x.t < 10 * 60000 && me.f.includes(x.de));
      return out({ r: 'ok', f: me.f.map(m => ({ n: m, a: (NAMES.get(m) || {}).a || 'guerrero', on: on(m) })).sort((x, y) => (y.on - x.on) || x.n.localeCompare(y.n)), rq: me.rq.slice(), inv: inv.map(x => ({ de: x.de, c: x.c })) });
    });
  }
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  /* cuántas salas rápidas están esperando jugador */
  if (url === '/quick') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ n: waiting().length, push: pushOn, key: VAPID_PUBLIC })); }
  if (req.method === 'POST' && url === '/push/sub') {
    return readBody(req, b => {
      const s = b && b.sub;
      if (!pushOn || !s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) { res.writeHead(400); return res.end(); }
      if (SUBS.size > 5000 && !SUBS.has(s.endpoint)) { res.writeHead(503); return res.end(); }
      SUBS.set(s.endpoint, { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }); saveSubs();
      res.writeHead(204); res.end();
    });
  }
  if (req.method === 'POST' && url === '/push/unsub') {
    return readBody(req, b => { if (b && b.endpoint && SUBS.delete(b.endpoint)) saveSubs(); res.writeHead(204); res.end(); });
  }
  /* aviso de actualización: lo llama GitHub Actions con la clave NOTIFY_KEY (máx. 1 cada 20 min) */
  if (req.method === 'POST' && url === '/push/update') {
    const k = process.env.NOTIFY_KEY;
    if (!pushOn || !k || req.headers['x-key'] !== k) { res.writeHead(403); return res.end(); }
    if (Date.now() - lastUpdPush < 20 * 60 * 1000) { res.writeHead(429); return res.end(); }
    lastUpdPush = Date.now();
    return pushAll({ kind: 'update', title: 'Link Master Dungeon', body: '¡Hay una actualización nueva del juego!', badge: 1 }).then(n => { res.writeHead(200); res.end(String(n)); });
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
/* code -> { host, guest, hostChar, tok:{host,guest}, v2:{host,guest}, gone:{host,guest} (timers) } */
const rooms = new Map();
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let c; do { c = Array.from({ length: 5 }, () => ABC[Math.random() * ABC.length | 0]).join(''); } while (rooms.has(c)); return c; };
const newTok = () => crypto.randomBytes(12).toString('hex');
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const other = role => role === 'host' ? 'guest' : 'host';
const guestChar = r => r.gc || (r.hostChar === 'm' ? 'l' : 'm'); /* el invitado puede cambiarlo con {t:'char'}; por defecto, uno distinto al anfitrión */

/* quita definitivamente a un jugador (salida voluntaria o fin de la gracia) */
function drop(code, role) {
  const r = rooms.get(code); if (!r) return;
  clearTimeout(r.gone[role]); r.gone[role] = null;
  if (role === 'host') {
    send(r.guest, { t: 'peer', on: false });
    clearTimeout(r.gone.guest);
    rooms.delete(code);
  } else {
    r.guest = null; r.tok.guest = null; r.gc = null;
    send(r.host, { t: 'peer', on: false });
  }
}

wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ping') return send(ws, { t: 'pong' });

    if (m.t === 'create') {
      if (ws.room) return;
      const char = /^[a-z]$/.test(m.char || '') ? m.char : 'm', code = newCode(), tok = newTok();
      rooms.set(code, { host: ws, guest: null, hostChar: char, tok: { host: tok, guest: null }, v2: { host: !!m.v, guest: false }, gone: { host: null, guest: null } });
      ws.room = code; ws.role = 'host';
      return send(ws, { t: 'created', code, char, tok });
    }

    const doJoin = (code, r) => {
      const tok = newTok();
      r.gc = (m.t === 'quick' && /^[a-z]$/.test(m.char || '') && m.char !== r.hostChar) ? m.char : (r.hostChar === 'm' ? 'l' : 'm'); /* nunca el mismo personaje que el anfitrión */ r.pub = false; /* en partida rápida el invitado entra con el personaje que eligió */
      r.guest = ws; r.tok.guest = tok; r.v2.guest = !!m.v; ws.room = code; ws.role = 'guest';
      send(ws, { t: 'joined', code, char: guestChar(r), hostChar: r.hostChar, tok });
      send(r.host, { t: 'peer', on: true, char: guestChar(r) });
    };
    if (m.t === 'join') {
      const code = String(m.code || '').toUpperCase().trim(), r = rooms.get(code);
      if (!r) return send(ws, { t: 'err', msg: 'Esa sala no existe o ya se cerró.' });
      if (r.guest && r.guest.readyState === 1) return send(ws, { t: 'err', msg: 'La sala ya está llena.' });
      if (r.gone.guest) return send(ws, { t: 'err', msg: 'La sala ya está llena.' }); /* su lugar está reservado un momento */
      return doJoin(code, r);
    }

    /* partida rápida: si alguien ya espera, te une con el que lleva más tiempo; si no, abre una sala pública y espera */
    if (m.t === 'quick') {
      if (ws.room) return;
      const w = waiting().sort((a, b) => a[1].t0 - b[1].t0)[0];
      if (w) return doJoin(w[0], w[1]);
      const char = /^[a-z]$/.test(m.char || '') ? m.char : 'm', code = newCode(), tok = newTok();
      rooms.set(code, { host: ws, guest: null, hostChar: char, pub: true, t0: Date.now(), tok: { host: tok, guest: null }, v2: { host: !!m.v, guest: false }, gone: { host: null, guest: null } });
      ws.room = code; ws.role = 'host';
      send(ws, { t: 'created', code, char, tok, pub: 1 });
      if (pushOn && Date.now() - lastQuickPush > 2 * 60 * 1000) { /* máx. 1 aviso cada 2 min */
        lastQuickPush = Date.now();
        pushAll({ kind: 'quick', title: 'Link Master Dungeon', body: '⚔️ ¡Alguien está buscando jugador! Entra a partida rápida.', badge: 1 }, typeof m.ep === 'string' ? m.ep : null);
      }
      return;
    }

    /* cambiar de personaje en la sala (antes de empezar): se avisa al otro jugador */
    if (m.t === 'char') {
      const r = rooms.get(ws.room); if (!r || r[ws.role] !== ws) return;
      const c = /^[a-z]$/.test(m.char || '') ? m.char : null; if (!c) return;
      const otro = ws.role === 'host' ? (r.guest ? guestChar(r) : null) : r.hostChar;
      if (c === otro) return send(ws, { t: 'charno', char: ws.role === 'host' ? r.hostChar : guestChar(r) }); /* ya lo tiene el otro jugador */
      if (ws.role === 'host') r.hostChar = c; else r.gc = c;
      return send(r[other(ws.role)], { t: 'pchar', char: c });
    }

    /* volver a entrar a una sala después de perder la conexión */
    if (m.t === 'resume') {
      const code = String(m.code || '').toUpperCase().trim(), r = rooms.get(code);
      const role = r && (r.tok.host && r.tok.host === m.tok ? 'host' : r.tok.guest && r.tok.guest === m.tok ? 'guest' : null);
      if (!r || !role) return send(ws, { t: 'err', msg: 'La sala ya no existe o se acabó el tiempo para volver.', gone: 1 });
      const old = r[role];
      clearTimeout(r.gone[role]); r.gone[role] = null;
      r[role] = ws; ws.room = code; ws.role = role;
      if (old && old !== ws) { old.room = null; try { old.terminate(); } catch {} }
      const peer = r[other(role)], peerOn = !!(peer && peer.readyState === 1);
      send(ws, { t: 'resumed', code, role, char: role === 'host' ? r.hostChar : guestChar(r), hostChar: r.hostChar, peer: peerOn || !!r.gone[other(role)], peerChar: role === 'host' ? guestChar(r) : r.hostChar });
      send(peer, { t: 'peer', on: true, back: 1, char: role === 'host' ? r.hostChar : guestChar(r) });
      return;
    }

    if (m.t === 'leave') { /* salida voluntaria: sin gracia */
      if (ws.room) drop(ws.room, ws.role);
      ws.room = null; return;
    }

    if (m.t === 'msg') { /* reenvía cualquier acción al otro jugador */
      const r = rooms.get(ws.room); if (!r || r[ws.role] !== ws) return;
      const o = { t: 'msg', data: m.data };
      if (m.n) o.n = m.n;
      send(r[other(ws.role)], o);
    }
  });
  ws.on('close', () => {
    const code = ws.room, r = rooms.get(code); if (!r || r[ws.role] !== ws) return;
    const role = ws.role;
    if (!r.v2[role]) return drop(code, role); /* cliente viejo: sin reconexión */
    r.gone[role] = setTimeout(() => drop(code, role), GRACIA);
    send(r[other(role)], { t: 'peer', on: false, wait: Math.round(GRACIA / 1000) });
  });
});

setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 30000);
server.listen(process.env.PORT || 3000, () => console.log('Servidor listo'));
