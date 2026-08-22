// 依存なしの最小 WebSocket サーバー。拡張 (Windows Chrome) が張りに来る。
//
//   受信フレーム  → stdout に 1 行 = Monitor のイベント 1 件
//   stdin の 1 行 → 全クライアントへ送信 (Linux → 拡張のコマンド)
//
// 使い方:  node ws-bridge.mjs [port]
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || 8799);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();

const out = (...a) => { process.stdout.write(a.join(' ') + '\n'); };

function frame(str) {                       // server → client (mask 無し)
  const p = Buffer.from(str);
  const len = p.length;
  let head;
  if (len < 126)        { head = Buffer.from([0x81, len]); }
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else                  { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, p]);
}

const server = http.createServer((req, res) => {
  // 疎通確認用。ブラウザから開けば到達性がすぐ分かる。
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end(`ws-bridge ok  clients=${clients.size}\n`);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  clients.add(socket);
  out(`[bridge] client connected from ${req.socket.remoteAddress} (${clients.size} total)`);

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

      if (opcode === 0x8) { socket.end(); return; }           // close
      if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; } // ping
      if (opcode === 0x1) out(payload.toString('utf8'));       // text → イベント
    }
  });

  const bye = () => { clients.delete(socket); out(`[bridge] client gone (${clients.size} left)`); };
  socket.on('close', bye);
  socket.on('error', bye);
});

// stdin の 1 行 = 全クライアントへ送るコマンド
let stdinBuf = '';
process.stdin.on('data', d => {
  stdinBuf += d;
  let i;
  while ((i = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, i).trim();
    stdinBuf = stdinBuf.slice(i + 1);
    if (!line) continue;
    for (const c of clients) { try { c.write(frame(line)); } catch {} }
  }
});

server.listen(PORT, '0.0.0.0', () => out(`[bridge] listening on 0.0.0.0:${PORT}`));
