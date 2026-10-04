/* Servidor de salas para Link Master (2 jugadores). Corre en Render. */
const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map(); /* code -> {host, guest, hostChar} */
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let c; do { c = Array.from({ length: 5 }, () => ABC[Math.random() * ABC.length | 0]).join(''); } while (rooms.has(c)); return c; };
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ping') return send(ws, { t: 'pong' });

    if (m.t === 'create') {
      if (ws.room) return;
      const char = m.char === 'l' ? 'l' : 'm', code = newCode();
      rooms.set(code, { host: ws, guest: null, hostChar: char });
      ws.room = code; ws.role = 'host';
      return send(ws, { t: 'created', code, char });
    }

    if (m.t === 'join') {
      const code = String(m.code || '').toUpperCase().trim(), r = rooms.get(code);
      if (!r) return send(ws, { t: 'err', msg: 'Esa sala no existe o ya se cerró.' });
      if (r.guest && r.guest.readyState === 1) return send(ws, { t: 'err', msg: 'La sala ya está llena.' });
      r.guest = ws; ws.room = code; ws.role = 'guest';
      const gc = r.hostChar === 'm' ? 'l' : 'm';
      send(ws, { t: 'joined', code, char: gc, hostChar: r.hostChar });
      send(r.host, { t: 'peer', on: true, char: gc });
      return;
    }

    if (m.t === 'msg') { /* reenvía cualquier acción al otro jugador */
      const r = rooms.get(ws.room); if (!r) return;
      send(ws.role === 'host' ? r.guest : r.host, { t: 'msg', data: m.data });
    }
  });
  ws.on('close', () => {
    const r = rooms.get(ws.room); if (!r) return;
    if (ws.role === 'host') { send(r.guest, { t: 'peer', on: false }); rooms.delete(ws.room); }
    else { r.guest = null; send(r.host, { t: 'peer', on: false }); }
  });
});

setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 30000);
server.listen(process.env.PORT || 3000, () => console.log('Servidor listo'));
