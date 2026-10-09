'use strict';
/**
 * Cells.io server: serves ./public and relays player state over WebSocket (/ws).
 * Clients are authoritative for their own position (simple, cheap, good for friends/small groups).
 * The server validates/sanitizes input, rate-limits clients and only sends nearby players.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS, 10) || 80;
const W = 4000, H = 4000;
const VIEW = 2600;      // players farther than this (on either axis) are not sent to a client
const TICK_MS = 50;     // 20 snapshots / second
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const radius = (m) => Math.sqrt(m) * 6;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const cleanName = (s) =>
  String(s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .trim()
    .slice(0, 14) || 'Гравець';

// ---------- static files ----------
const server = http.createServer((req, res) => {
  let url;
  try {
    url = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (url === '/') url = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(url));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
});

// ---------- game relay ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 });
const players = new Map();

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    ws.close(1013, 'full');
    return;
  }
  const id = crypto.randomBytes(4).toString('hex');
  const p = { id, ws, x: W / 2, y: H / 2, m: 20, c: '#54a0ff', n: 'Гравець', a: 0, tokens: 60, ts: Date.now() };
  players.set(id, p);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { t: 'hi', id });

  ws.on('message', (raw) => {
    // token bucket: ~40 messages / second per client
    const now = Date.now();
    p.tokens = Math.min(60, p.tokens + ((now - p.ts) / 1000) * 40);
    p.ts = now;
    if (p.tokens < 1) return;
    p.tokens -= 1;

    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 's') {
      const x = +m.x, y = +m.y, mass = +m.m;
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(mass)) {
        p.x = clamp(x, 0, W);
        p.y = clamp(y, 0, H);
        p.m = clamp(mass, 10, 20000);
      }
      if (typeof m.c === 'string' && /^#[0-9a-fA-F]{6}$/.test(m.c)) p.c = m.c;
      if (typeof m.n === 'string') p.n = cleanName(m.n);
      p.a = m.a === 1 ? 1 : 0;
    } else if (m.t === 'd') {
      // "I was eaten by <id>": reward the eater, using the mass the server knows about
      if (p.a !== 1) return;
      p.a = 0;
      const k = typeof m.by === 'string' ? players.get(m.by) : null;
      if (
        k && k !== p && k.a === 1 && k.m > p.m &&
        Math.hypot(k.x - p.x, k.y - p.y) < radius(k.m) * 1.5 + 200
      ) {
        send(k.ws, { t: 'k', m: Math.min(p.m, 5000) });
      }
    }
  });

  ws.on('close', () => { players.delete(id); });
  ws.on('error', () => {});
});

// snapshots with simple interest management
setInterval(() => {
  const alive = [];
  for (const p of players.values()) if (p.a === 1) alive.push(p);
  const total = players.size;
  for (const p of players.values()) {
    if (p.ws.readyState !== 1) continue;
    const near = [];
    for (const o of alive) {
      if (o === p) continue;
      if (Math.abs(o.x - p.x) < VIEW && Math.abs(o.y - p.y) < VIEW) {
        near.push([o.id, Math.round(o.x), Math.round(o.y), Math.round(o.m * 10) / 10, o.c, o.n]);
      }
    }
    send(p.ws, { t: 'p', p: near, c: total });
  }
}, TICK_MS);

// global leaderboard once a second
setInterval(() => {
  const top = [...players.values()]
    .filter((p) => p.a === 1)
    .sort((a, b) => b.m - a.m)
    .slice(0, 8)
    .map((p) => [p.id, p.n, Math.round(p.m)]);
  const msg = JSON.stringify({ t: 'l', l: top });
  for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(msg);
}, 1000);

// drop dead connections (proxies/mobile networks)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Cells.io listening on http://localhost:' + PORT);
});

function shutdown() {
  console.log('Shutting down…');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
