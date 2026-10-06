/* Servidor de salas para Link Master (2 jugadores). Corre en Render.
   Reconexión: si un jugador pierde la conexión, su lugar se guarda GRACIA ms. Al volver con su
   código de sala + token (mensaje "resume") sigue la partida donde se quedó. */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const GRACIA = (+process.env.GRACIA_MS) || 90 * 1000;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
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
      const char = m.char === 'l' ? 'l' : m.char === 'p' ? 'p' : 'm', code = newCode(), tok = newTok();
      rooms.set(code, { host: ws, guest: null, hostChar: char, tok: { host: tok, guest: null }, v2: { host: !!m.v, guest: false }, gone: { host: null, guest: null } });
      ws.room = code; ws.role = 'host';
      return send(ws, { t: 'created', code, char, tok });
    }

    if (m.t === 'join') {
      const code = String(m.code || '').toUpperCase().trim(), r = rooms.get(code);
      if (!r) return send(ws, { t: 'err', msg: 'Esa sala no existe o ya se cerró.' });
      if (r.guest && r.guest.readyState === 1) return send(ws, { t: 'err', msg: 'La sala ya está llena.' });
      if (r.gone.guest) return send(ws, { t: 'err', msg: 'La sala ya está llena.' }); /* su lugar está reservado un momento */
      const tok = newTok();
      r.gc = r.hostChar === 'm' ? 'l' : 'm';
      r.guest = ws; r.tok.guest = tok; r.v2.guest = !!m.v; ws.room = code; ws.role = 'guest';
      send(ws, { t: 'joined', code, char: guestChar(r), hostChar: r.hostChar, tok });
      send(r.host, { t: 'peer', on: true, char: guestChar(r) });
      return;
    }

    /* cambiar de personaje en la sala (antes de empezar): se avisa al otro jugador */
    if (m.t === 'char') {
      const r = rooms.get(ws.room); if (!r || r[ws.role] !== ws) return;
      const c = ['m', 'l', 'p'].includes(m.char) ? m.char : null; if (!c) return;
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
