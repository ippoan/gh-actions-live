// content script (extension/alive-relay.js) をそのまま vm で走らせて検証する。
// chrome.runtime / WebSocket / タイマーは偽物を注入する。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../extension/alive-relay.js'), 'utf8');

class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closeCalls = 0; FakeWebSocket.instances.push(this); }
  send(s) { this.sent.push(s); }
  close() { this.closeCalls++; this.readyState = 2; }
  // テスト側から起こす
  _open() { this.readyState = 1; this.onopen?.(); }
  _close(code = 1006, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  _msg(data) { this.onmessage?.({ data }); }
}

function makeEnv() {
  let t = 0, seq = 0; const timers = new Map();
  const posted = [];
  let listener = null;
  const chrome = {
    runtime: {
      sendMessage: (m) => { posted.push(m); },
      onMessage: { addListener: (fn) => { listener = fn; } }
    }
  };
  const ctx = {
    chrome, WebSocket: FakeWebSocket, location: { href: 'https://github.com/o/r/actions' },
    Date: { now: () => t }, Math,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id),
    console
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const run = () => vm.runInContext(SRC, ctx);
  const send = (msg) => new Promise(res => { const r = listener(msg, {}, res); if (r !== true) res(undefined); });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); t = next[1].at; next[1].fn();
    }
    t = end;
  };
  FakeWebSocket.instances.length = 0;
  return { ctx, run, send, posted, advance, sockets: FakeWebSocket.instances, statuses: () => posted.filter(p => p.type === 'alive-status').map(p => p.state) };
}

test('読み込み時に alive-ready を post し、connect で WebSocket を張って open → subscribe する', async () => {
  const env = makeEnv(); env.run();
  assert.equal(env.posted[0].type, 'alive-ready');
  const r = await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a', 'b'] });
  assert.equal(r.ok, true);
  assert.equal(r.readyState, 0);
  assert.equal(r.tokens, 2);
  assert.equal(env.sockets.length, 1);
  env.sockets[0]._open();
  assert.deepEqual(env.statuses(), ['connecting', 'open', 'subscribed']);
  assert.deepEqual(JSON.parse(env.sockets[0].sent[0]), { subscribe: { a: null, b: null } });
});

test('CONNECTING が 15s 続いたら close して error を post する (握手タイムアウト)', async () => {
  const env = makeEnv(); env.run();
  await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a'] });
  env.advance(14999);
  assert.equal(env.sockets[0].closeCalls, 0);
  env.advance(1);
  assert.equal(env.sockets[0].closeCalls, 1);
  const errs = env.posted.filter(p => p.type === 'alive-status' && p.state === 'error');
  assert.equal(errs.length, 1);
  assert.match(errs[0].error, /handshake timeout 15s/);
  // その後の onclose は byUs 付きで届く (ダッシュボードは失敗に数えない)
  env.sockets[0]._close(1006);
  const closed = env.posted.filter(p => p.type === 'alive-status' && p.state === 'closed');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].byUs, 'handshake-timeout');
  // ping は socket 無しを返す
  const p = await env.send({ target: 'alive-relay', type: 'ping' });
  assert.equal(p.readyState, null);
  // 次の connect は新しい socket を張る
  await env.send({ target: 'alive-relay', type: 'connect' });
  assert.equal(env.sockets.length, 2);
});

test('open したら握手タイマーは止まる', async () => {
  const env = makeEnv(); env.run();
  await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a'] });
  env.sockets[0]._open();
  env.advance(60000);
  assert.equal(env.sockets[0].closeCalls, 0);
  assert.ok(!env.posted.some(p => p.state === 'error'));
});

test('CONNECTING 中に connect が来たら黙らず connecting (readyState / sinceMs) を返す', async () => {
  const env = makeEnv(); env.run();
  await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a'] });
  env.advance(3000);
  const before = env.posted.length;
  const r = await env.send({ target: 'alive-relay', type: 'connect' });
  assert.equal(env.sockets.length, 1);                 // 新しい socket は作らない
  assert.equal(r.readyState, 0);
  assert.equal(r.connectingMs, 3000);
  const st = env.posted.slice(before).filter(p => p.type === 'alive-status');
  assert.equal(st.length, 1);
  assert.equal(st[0].state, 'connecting');
  assert.equal(st[0].readyState, 0);
  assert.equal(st[0].sinceMs, 3000);
});

test('OPEN 中の connect は新しいトークンで購読し直すだけ', async () => {
  const env = makeEnv(); env.run();
  await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a'] });
  env.sockets[0]._open();
  await env.send({ target: 'alive-relay', type: 'connect', tokens: ['a', 'b', 'c'] });
  assert.equal(env.sockets.length, 1);
  assert.deepEqual(JSON.parse(env.sockets[0].sent[1]), { subscribe: { a: null, b: null, c: null } });
  assert.equal(env.statuses().filter(s => s === 'subscribed').length, 2);
});

test('close コマンドで閉じると onclose は byUs 付き、ping は socket 無し', async () => {
  const env = makeEnv(); env.run();
  await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a'] });
  env.sockets[0]._open();
  const r = await env.send({ target: 'alive-relay', type: 'close', reason: 'dashboard' });
  assert.equal(r.closed, true);
  assert.equal(env.sockets[0].closeCalls, 1);
  env.sockets[0]._close(1000);
  const closed = env.posted.filter(p => p.state === 'closed');
  assert.equal(closed[0].byUs, 'dashboard');
  const p = await env.send({ target: 'alive-relay', type: 'ping' });
  assert.equal(p.readyState, null);
  // 何も無いときの close は closed:false
  const r2 = await env.send({ target: 'alive-relay', type: 'close' });
  assert.equal(r2.closed, false);
});

test('サーバー側から切れたら byUs 無しの closed を post する', async () => {
  const env = makeEnv(); env.run();
  await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a'] });
  env.sockets[0]._open();
  env.sockets[0]._close(1006, 'gone');
  const closed = env.posted.filter(p => p.state === 'closed');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].byUs, null);
  assert.equal(closed[0].code, 1006);
});

test('ack は alive-status:ack、それ以外は alive-message として中継', async () => {
  const env = makeEnv(); env.run();
  await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a'] });
  env.sockets[0]._open();
  env.sockets[0]._msg('{"ack":true}');
  env.sockets[0]._msg('{"ch":"x","data":{}}');
  assert.ok(env.posted.some(p => p.type === 'alive-status' && p.state === 'ack'));
  assert.ok(env.posted.some(p => p.type === 'alive-message' && p.data === '{"ch":"x","data":{}}'));
});

test('2 回読み込まれても (executeScript の入れ直し) listener も socket も増えない (#25 の 3)', async () => {
  const env = makeEnv(); env.run();
  const firstInstance = env.ctx.__ghAliveRelay.instance;
  let listeners = 0;
  env.ctx.chrome.runtime.onMessage.addListener = () => { listeners++; };
  env.run();                                           // 2 回目
  assert.equal(listeners, 0);
  assert.equal(env.ctx.__ghAliveRelay.instance, firstInstance);
  assert.equal(env.posted.filter(p => p.type === 'alive-ready').length, 1);
  await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a'] });
  await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a'] });
  assert.equal(env.sockets.length, 1);
});

test('URL 無しの connect は error を返す', async () => {
  const env = makeEnv(); env.run();
  await env.send({ target: 'alive-relay', type: 'connect', tokens: ['a'] });
  assert.equal(env.sockets.length, 0);
  assert.ok(env.posted.some(p => p.state === 'error' && /no socket url/.test(p.error)));
});

/* ---- lastFrameAt (#28) ---- */
// half-open では readyState が OPEN のままなので、生死の判断材料はフレームの受信時刻だけ。

test('フレームを受け取ると lastFrameAt / frames が進み、ping で見える', async () => {
  const env = makeEnv(); env.run();
  await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a'] });
  env.sockets[0]._open();
  let p = await env.send({ target: 'alive-relay', type: 'ping' });
  assert.equal(p.lastFrameAt, null);                 // まだ何も来ていない
  assert.equal(p.sinceLastFrameMs, null);
  assert.equal(p.frames, 0);

  env.advance(5000);
  env.sockets[0]._msg('{"e":"ack","off":"1-0","health":true}');
  env.advance(1000);
  p = await env.send({ target: 'alive-relay', type: 'ping' });
  assert.equal(p.lastFrameAt, 5000);
  assert.equal(p.sinceLastFrameMs, 1000);
  assert.equal(p.frames, 1);
  // ack の alive-status にも載る (ダッシュボードが idle を測り直す材料)
  const ack = env.posted.filter(x => x.type === 'alive-status' && x.state === 'ack').at(-1);
  assert.equal(ack.lastFrameAt, 5000);

  env.advance(2000);
  env.sockets[0]._msg('{"ch":"topic","e":"update"}');
  p = await env.send({ target: 'alive-relay', type: 'ping' });
  assert.equal(p.lastFrameAt, 8000);
  assert.equal(p.sinceLastFrameMs, 0);
  assert.equal(p.frames, 2);
  const push = env.posted.filter(x => x.type === 'alive-message').at(-1);
  assert.equal(push.lastFrameAt, 8000);
});

test('張り直すと lastFrameAt はリセットされる (前の socket の受信を引き継がない)', async () => {
  const env = makeEnv(); env.run();
  await env.send({ target: 'alive-relay', type: 'connect', url: 'wss://alive/x', tokens: ['a'] });
  env.sockets[0]._open();
  env.sockets[0]._msg('{"e":"ack"}');
  await env.send({ target: 'alive-relay', type: 'close', reason: 'idle' });
  await env.send({ target: 'alive-relay', type: 'connect' });
  assert.equal(env.sockets.length, 2);
  const p = await env.send({ target: 'alive-relay', type: 'ping' });
  assert.equal(p.lastFrameAt, null);
  assert.equal(p.frames, 0);
});
