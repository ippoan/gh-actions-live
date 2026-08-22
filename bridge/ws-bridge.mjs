// 拡張 (Windows Chrome) と Claude Code (Linux) をつなぐ最小 WebSocket リレー。依存なし。
//
//   役割は接続 URL の ?role= で決める:
//     extension  (既定)  … 拡張。events / snapshot / hello を送ってくる。コマンドを受け取る
//     listener           … Claude 側の購読者 (Monitor の ws ソース等)。拡張の生 JSON を受け取る
//
//   拡張 → stdout  : 1 行 = 1 イベント (Claude Code の Monitor がこれを通知に変える)
//   拡張 → listener: 生 JSON をそのまま中継
//   listener / stdin の 1 行 / POST /cmd  → 全 extension へ送信 (Linux → 拡張のコマンド)
//   接続・切断などのノイズは stderr (Monitor は stdout だけを通知にする)
//
//   20 秒ごとに {"type":"ping"} を全クライアントへ送る。MV3 の service worker は
//   WebSocket のメッセージ往来が 30 秒以内にあれば生き続けるので、これが keepalive になる。
//
// 使い方:
//   node ws-bridge.mjs [port]                  (既定 8799)
//   curl -X POST localhost:8799/cmd -d '{"command":"open-dashboard","mode":"popup"}'
//   curl localhost:8799/                       (状態)
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || 8799);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Map();   // socket -> { role, remote, hello }

const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(`[bridge] ${s}\n`);

/* ---------- フレーム ---------- */
function frame(str) {
  const p = Buffer.from(str);
  const len = p.length;
  let head;
  if (len < 126)        head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else                  { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, p]);
}
function sendTo(sock, obj) { try { sock.write(frame(typeof obj === 'string' ? obj : JSON.stringify(obj))); } catch {} }
function broadcast(role, obj) { for (const [s, c] of clients) if (c.role === role) sendTo(s, obj); }

/* ---------- イベント整形 (stdout に出す 1 行) ---------- */
const fmtEvent = (e) => {
  const arrow = e.from ? `${e.from} → ${e.label}` : e.label;
  const tag = e.ref ? ` [${e.ref}]` : '';
  const title = e.title ? ` — ${String(e.title).slice(0, 80)}` : '';
  return `${e.repo} ${e.workflow} #${e.run}: ${arrow}${tag}${title}`;
};

function onExtensionMessage(sock, info, msg) {
  switch (msg.type) {
    case 'hello':
      info.hello = msg;
      err(`extension hello: repos=${(msg.repos || []).join(',')} v${msg.version || '?'} from ${info.remote}`);
      break;
    case 'pong': break;
    case 'events':
      for (const e of msg.events || []) out(fmtEvent(e));
      break;
    case 'snapshot': {
      const runs = msg.runs || [];
      const running = runs.filter(r => /running|queued|progress|waiting|pending/i.test(r.status)).length;
      const bad = runs.filter(r => /fail|cancel|timed|error/i.test(r.status)).length;
      out(`snapshot: ${runs.length} runs, ${running} running, ${bad} failed (${[...new Set(runs.map(r => r.repo))].join(', ')})`);
      break;
    }
    case 'log':
      err(`extension log: ${msg.text}`);
      break;
    default:
      out(JSON.stringify(msg));
  }
  broadcast('listener', msg);   // 生のまま listener へ
}

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (req.method === 'POST' && req.url.startsWith('/cmd')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let cmd;
      try { cmd = JSON.parse(body); } catch { res.writeHead(400, cors); res.end('bad json\n'); return; }
      const payload = { type: 'command', ...cmd };
      broadcast('extension', payload);
      const n = [...clients.values()].filter(c => c.role === 'extension').length;
      err(`cmd ${cmd.command || '?'} -> ${n} extension(s)`);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, delivered_to: n }) + '\n');
    });
    return;
  }

  const summary = [...clients.values()].map(c => `${c.role}@${c.remote}${c.hello?.repos ? ' ' + c.hello.repos.join(',') : ''}`);
  res.writeHead(200, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, port: PORT, clients: summary }, null, 1) + '\n');
});

/* ---------- WebSocket ---------- */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
               `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  const role = new URL(req.url, 'http://x').searchParams.get('role') || 'extension';
  const info = { role, remote: req.socket.remoteAddress, hello: null };
  clients.set(socket, info);
  err(`${role} connected from ${info.remote} (${clients.size} total)`);

  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126)      { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + maskLen + len);

      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (opcode !== 0x1) continue;

      const text = payload.toString('utf8');
      let msg; try { msg = JSON.parse(text); } catch { msg = { type: 'raw', text }; }
      if (info.role === 'extension') onExtensionMessage(socket, info, msg);
      else broadcast('extension', msg);   // listener からのコマンド
    }
  });

  const bye = () => { if (clients.delete(socket)) err(`${role} gone (${clients.size} left)`); };
  socket.on('close', bye);
  socket.on('error', bye);
});

/* ---------- stdin → 拡張 ---------- */
let stdinBuf = '';
process.stdin.on('data', d => {
  stdinBuf += d;
  let i;
  while ((i = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, i).trim();
    stdinBuf = stdinBuf.slice(i + 1);
    if (!line) continue;
    let obj; try { obj = JSON.parse(line); } catch { obj = { type: 'command', command: line }; }
    broadcast('extension', obj.type ? obj : { type: 'command', ...obj });
  }
});
process.stdin.on('error', () => {});

/* ---------- keepalive ---------- */
setInterval(() => { for (const s of clients.keys()) sendTo(s, { type: 'ping', t: Date.now() }); }, 20000);

server.listen(PORT, '0.0.0.0', () => err(`listening on 0.0.0.0:${PORT}`));
