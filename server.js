// Cucina Lampo: server online.
// Serve il gioco (index.html) e collega i giocatori in stanze con un codice di 4 lettere.
// Nessuna dipendenza esterna: basta Node 18 o più recente.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GAME = process.env.GAME_FILE || path.join(__dirname, 'index.html');
const MAX_MSG = 1 << 20;            // 1 MB per messaggio
const ROOM_SIZE = 2;                // host + 1 ospite
const rooms = new Map();            // codice -> { host, guests: [] }
let lastCode = '';

function page(res) {
  fs.readFile(GAME, 'utf8', (err, html) => {
    if (err) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Manca index.html accanto a server.js'); return; }
    html = html.replace('/*CL_SERVER*/', 'window.CL_SERVER=location.origin;');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(html);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ stanze: rooms.size })); return; }
  if (process.env.TEST && url === '/testcode') { res.end(lastCode); return; }
  if (url === '/' || url === '/index.html') return page(res);
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Non trovato');
});

function frame(op, payload) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

class Conn {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.frags = []; this.room = null; this.dead = false; this.seen = Date.now();
    sock.on('data', d => { this.seen = Date.now(); this.buf = Buffer.concat([this.buf, d]); try { this.parse(); } catch (e) { this.kill(); } });
    sock.on('close', () => this.kill());
    sock.on('error', () => this.kill());
  }
  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, o = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); o = 10; }
      if (len > MAX_MSG) { this.kill(); return; }
      const mo = o; if (masked) o += 4;
      if (b.length < o + len) return;
      const p = Buffer.from(b.subarray(o, o + len));
      if (masked) { const m = b.subarray(mo, mo + 4); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; }
      this.buf = b.subarray(o + len);
      if (op === 8) { this.write(frame(8, Buffer.alloc(0))); this.kill(); return; }
      if (op === 9) { this.write(frame(10, p)); continue; }
      if (op === 10) continue;
      this.frags.push(p);
      if (fin) { const text = Buffer.concat(this.frags).toString('utf8'); this.frags = []; this.onMessage(text); }
    }
  }
  write(buf) { if (!this.dead) { try { this.sock.write(buf); } catch (e) { this.kill(); } } }
  send(obj) { this.write(frame(1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)))); }
  onMessage(text) {
    let m = null;
    if (text.length < 300) { try { m = JSON.parse(text); } catch (e) { return; } }
    if (m && m.t === 'ping') { this.send({ t: 'pong' }); return; }
    if (m && m.t === 'create') { this.leave(); this.create(); return; }
    if (m && m.t === 'join') { this.leave(); this.join(String(m.code || '').toUpperCase()); return; }
    const r = this.room; if (!r) return;
    if (r.host === this) r.guests.forEach(g => g.send(text));
    else if (r.host) r.host.send(text);
  }
  create() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code;
    do { code = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(code));
    const r = { host: this, guests: [] }; rooms.set(code, r); this.room = r; r.code = code; lastCode = code;
    this.send({ t: 'room', code, role: 'host' });
  }
  join(code) {
    const r = rooms.get(code);
    if (!r) return this.send({ t: 'err', msg: 'Stanza ' + code + ' non trovata' });
    if (1 + r.guests.length >= ROOM_SIZE) return this.send({ t: 'err', msg: 'La stanza è piena' });
    r.guests.push(this); this.room = r;
    this.send({ t: 'room', code, role: 'guest' });
    r.host.send({ t: 'peer' });
  }
  leave() {
    const r = this.room; if (!r) return; this.room = null;
    if (r.host === this) { r.guests.forEach(g => { g.room = null; g.send({ t: 'left', who: 'host' }); }); rooms.delete(r.code); }
    else { r.guests = r.guests.filter(g => g !== this); if (r.host) r.host.send({ t: 'left', who: 'guest' }); }
  }
  kill() {
    if (this.dead) return;
    this.leave(); this.dead = true;
    try { this.sock.destroy(); } catch (e) { }
  }
}

const conns = new Set();
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!req.url.startsWith('/ws') || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = new Conn(sock); conns.add(c);
  sock.on('close', () => conns.delete(c));
});

// chiude le connessioni morte (nessun dato da 60 secondi)
setInterval(() => { const now = Date.now(); for (const c of conns) if (now - c.seen > 60000) c.kill(); }, 15000);

server.listen(PORT, () => console.log('Cucina Lampo online sulla porta ' + PORT));
