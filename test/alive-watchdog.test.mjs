// alive watchdog (extension/alive-watchdog.js) の単体テスト。タイマーは手動で進める。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAliveWatchdog } from '../extension/alive-watchdog.js';

// 手動タイマー。advance(ms) で期限の来たものを順に実行する
function fakeClock() {
  let t = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, x] = next; timers.delete(id); t = x.at; x.fn();
      }
      t = end;
    },
    pending: () => timers.size
  };
}

function setup(opts = {}) {
  const clock = fakeClock();
  const calls = [];
  const w = createAliveWatchdog({
    connect: () => calls.push('connect'),
    close: () => calls.push('close'),
    boot: () => { calls.push('boot'); w.onBoot(); },
    handshakeMs: 20000, baseBackoff: 4000, maxBackoff: 60000, bootEvery: 5,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now,
    ...opts
  });
  return { w, clock, calls };
}

test('connect 後に open が来れば watchdog は解除され connected になる', () => {
  const { w, clock, calls } = setup();
  w.onBoot();
  assert.deepEqual(calls, ['close', 'connect']);     // 未接続の boot は無条件で close → connect
  assert.equal(w.armed, true);
  w.onStatus({ state: 'connecting' });
  w.onStatus({ state: 'open' });
  assert.equal(w.state.connected, true);
  assert.equal(w.armed, false);
  clock.advance(60000);
  assert.deepEqual(calls, ['close', 'connect']);     // 余計な再接続は走らない
});

test('open も closed も来ない (CONNECTING で固まる) と watchdog が close → 再接続する (#25 の 1)', () => {
  const { w, clock, calls } = setup();
  w.onBoot();
  w.onStatus({ state: 'connecting' });
  calls.length = 0;
  clock.advance(19999);
  assert.deepEqual(calls, []);
  clock.advance(1);                                    // 20s: watchdog 発火 → fail → 4s 後に再接続
  assert.equal(w.state.fails, 1);
  assert.equal(w.pending, true);
  assert.match(w.state.note, /watchdog/);
  clock.advance(4000);
  assert.deepEqual(calls, ['close', 'connect']);
  assert.equal(w.armed, true);                        // 再接続にも watchdog が付く
});

test('連続失敗は指数バックオフし、5 回に 1 回は boot を呼ぶ', () => {
  const { w, clock, calls } = setup();
  w.onBoot();
  const waits = [];
  for (let i = 1; i <= 6; i++) {
    calls.length = 0;
    const before = clock.now();
    clock.advance(20000);                              // watchdog 発火
    assert.equal(w.state.fails, i);
    const retryAt = w.state.nextRetryAt;
    clock.advance(retryAt - clock.now());
    waits.push(retryAt - before - 20000);
    if (i === 5) assert.deepEqual(calls, ['close', 'boot', 'close', 'connect']);
    else assert.deepEqual(calls, ['close', 'connect']);
  }
  assert.deepEqual(waits, [4000, 8000, 16000, 32000, 60000, 60000]);   // maxBackoff=60000 で頭打ち
});

test('error と closed が連続で届いても再接続は 1 回しか積まない', () => {
  const { w, clock, calls } = setup();
  w.onBoot(); w.onStatus({ state: 'open' });
  calls.length = 0;
  w.onStatus({ state: 'error' });
  w.onStatus({ state: 'closed', code: 1006 });
  assert.equal(w.state.fails, 1);
  assert.equal(w.state.connected, false);
  clock.advance(4000);
  assert.deepEqual(calls, ['close', 'connect']);
  clock.advance(100);
  assert.deepEqual(calls, ['close', 'connect']);
});

test('自分で閉じた (byUs) closed は失敗に数えない', () => {
  const { w, clock } = setup();
  w.onBoot(); w.onStatus({ state: 'open' });
  w.reset('test');
  w.onStatus({ state: 'closed', code: 1000, byUs: 'dashboard' });
  assert.equal(w.state.fails, 0);
  assert.equal(w.pending, false);
  assert.equal(w.armed, true);                         // reset 後の connect を見張っている
  w.onStatus({ state: 'open' });
  assert.equal(w.state.connected, true);
  clock.advance(60000);
});

test('connect の送信自体が失敗したら (タブ無し等) バックオフ再接続に入る (#25 の 2)', () => {
  const { w, clock, calls } = setup();
  w.onBoot();
  w.onConnectError('no github tab');
  assert.equal(w.state.fails, 1);
  assert.equal(w.armed, false);
  assert.equal(w.pending, true);
  calls.length = 0;
  clock.advance(4000);
  assert.deepEqual(calls, ['close', 'connect']);
});

test('接続できたら fails / backoff が戻る', () => {
  const { w, clock } = setup();
  w.onBoot();
  clock.advance(20000); clock.advance(4000);
  clock.advance(20000); clock.advance(8000);
  assert.equal(w.state.fails, 2);
  w.onStatus({ state: 'subscribed', count: 3 });
  assert.equal(w.state.fails, 0);
  assert.equal(w.state.backoff, 4000);
  assert.equal(w.pending, false);
});

test('接続済みの boot は close せず connect (購読し直し) だけ', () => {
  const { w, calls } = setup();
  w.onBoot(); w.onStatus({ state: 'open' });
  calls.length = 0;
  w.onBoot();
  assert.deepEqual(calls, ['connect']);
  assert.equal(w.armed, false);
});

test('未接続で再接続予約中の boot は予約を捨てて即 close → connect', () => {
  const { w, clock, calls } = setup();
  w.onBoot();
  clock.advance(20000);                                // fail #1、4s 後に予約
  assert.equal(w.pending, true);
  calls.length = 0;
  w.onBoot();
  assert.deepEqual(calls, ['close', 'connect']);
  assert.equal(w.pending, false);
  clock.advance(4000);
  assert.deepEqual(calls, ['close', 'connect']);      // 古い予約は走らない
});

test('reset はバックオフを捨てて即 close → connect', () => {
  const { w, clock, calls } = setup();
  w.onBoot();
  for (let i = 0; i < 3; i++) { clock.advance(20000); clock.advance(w.state.nextRetryAt - clock.now()); }
  assert.equal(w.state.fails, 3);
  calls.length = 0;
  w.reset('bridge');
  assert.deepEqual(calls, ['close', 'connect']);
  assert.equal(w.state.fails, 0);
  assert.equal(w.state.backoff, 4000);
  assert.equal(w.armed, true);
});

test('ensure: 接続済みなら connect、未接続で予約があれば何もしない、何も無ければ張る', () => {
  const { w, clock, calls } = setup();
  w.onBoot(); w.onStatus({ state: 'open' });
  calls.length = 0;
  w.ensure();
  assert.deepEqual(calls, ['connect']);
  w.onStatus({ state: 'closed', code: 1006 });         // 予約が入る
  calls.length = 0;
  w.ensure();
  assert.deepEqual(calls, []);
  clock.advance(4000);
  calls.length = 0;
  // watchdog が張られている間も何もしない
  w.ensure();
  assert.deepEqual(calls, []);
});

test('relay が CONNECTING を報告してきたら (watchdog 未装備なら) 張る', () => {
  const { w, clock, calls } = setup();
  // 何も頼んでいないのに connecting が届く = 別経路 (alive-ready → background) で relay が繋ぎ始めた
  w.onStatus({ state: 'connecting', sinceMs: 30000 });
  assert.equal(w.armed, true);
  assert.match(w.state.note, /30s/);
  clock.advance(20000);
  assert.equal(w.state.fails, 1);
  clock.advance(4000);
  assert.deepEqual(calls, ['close', 'connect']);
});

test('connect / close / boot が throw しても状態機械は止まらない', () => {
  const clock = fakeClock();
  const logs = [];
  const w = createAliveWatchdog({
    connect: () => { throw new Error('boom'); }, close: () => Promise.reject(new Error('nope')),
    handshakeMs: 1000, baseBackoff: 100, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now,
    log: (...a) => logs.push(a.join(' '))
  });
  w.onBoot();
  clock.advance(1000);
  clock.advance(100);
  assert.equal(w.state.fails, 1);
  assert.ok(logs.some(l => /boom/.test(l)));
});

/* ---- 繋がった後の見張り (idle watchdog, #28) ---- */
// half-open (readyState は OPEN のまま TCP が死ぬ) では onclose も onerror も来ず、
// ws.send() も通ってしまう。生きている証拠は「フレームを受け取ったこと」だけなので、
// 無受信が閾値を超えたら張り直して確かめる。

const IDLE = 600000;   // 10 分

test('接続中に閾値を超えて無受信だと close → connect で張り直す (#28)', () => {
  const { w, clock, calls } = setup({ idleLimitMs: IDLE });
  w.onBoot();
  w.onStatus({ state: 'open' });
  calls.length = 0;
  clock.advance(IDLE - 1);
  assert.deepEqual(calls, []);                    // まだ閾値内
  assert.equal(w.state.connected, true);
  clock.advance(1);
  assert.deepEqual(calls, ['close', 'connect']);  // reset('idle') = 張り直して生死を確かめる
  assert.equal(w.state.idleResets, 1);
  assert.equal(w.state.connected, false);
  assert.match(w.state.note, /無受信/);
  assert.equal(w.armed, true);                    // 張り直しには握手 watchdog が付く
});

test('フレームを受け取ると idle は解除され、そこから測り直す', () => {
  const { w, clock, calls } = setup({ idleLimitMs: IDLE });
  w.onBoot();
  w.onStatus({ state: 'open' });
  calls.length = 0;
  for (let i = 0; i < 5; i++) {                   // 9 分おきに push が来ている限り張り直さない
    clock.advance(IDLE - 60000);
    w.onMessage({ type: 'alive-message' });
    assert.deepEqual(calls, []);
  }
  assert.equal(w.state.lastMessageAt, clock.now());
  assert.equal(w.state.idleResets, 0);
  clock.advance(IDLE);                            // 止まったら張り直す
  assert.deepEqual(calls, ['close', 'connect']);
  assert.equal(w.state.idleResets, 1);
});

test('alive の ack もフレームなので idle を戻す', () => {
  const { w, clock, calls } = setup({ idleLimitMs: IDLE });
  w.onBoot();
  w.onStatus({ state: 'open' });
  calls.length = 0;
  clock.advance(IDLE - 1000);
  w.onStatus({ state: 'ack', sample: '{"e":"ack","health":true}' });
  clock.advance(IDLE - 1000);
  assert.deepEqual(calls, []);
  assert.equal(w.state.connected, true);
});

test('切断中は idle で張り直さない (再接続のバックオフに任せる)', () => {
  const { w, clock, calls } = setup({ idleLimitMs: IDLE });
  w.onBoot();
  w.onStatus({ state: 'open' });
  w.onStatus({ state: 'closed', code: 1006 });    // fail → バックオフで再接続
  calls.length = 0;
  const before = w.state.fails;
  clock.advance(4000);                            // バックオフ分の再接続 1 回だけ
  assert.deepEqual(calls, ['close', 'connect']);
  calls.length = 0;
  clock.advance(IDLE * 2);                        // 未接続のまま。idle 由来の張り直しは無い
  assert.equal(w.state.idleResets, 0);
  assert.ok(w.state.fails > before);
});

test('idleLimitMs: 0 で idle 監視を止められる', () => {
  const { w, clock, calls } = setup({ idleLimitMs: 0 });
  w.onBoot();
  w.onStatus({ state: 'open' });
  calls.length = 0;
  clock.advance(60 * 60000);
  assert.deepEqual(calls, []);
  assert.equal(w.idlePending, false);
});

test('snapshot に lastMessageAt / idleMs / idleLimitMs が出る (bridge の status 用)', () => {
  const { w, clock } = setup({ idleLimitMs: IDLE });
  w.onBoot();
  assert.equal(w.snapshot().lastMessageAt, null);
  assert.equal(w.snapshot().idleMs, null);
  w.onStatus({ state: 'open' });
  const at = clock.now();
  clock.advance(90000);
  const s = w.snapshot();
  assert.equal(s.lastMessageAt, at);
  assert.equal(s.idleMs, 90000);
  assert.equal(s.idleLimitMs, IDLE);
  assert.equal(s.idleArmed, true);
});

test('reset で idle の起点も張り直され、直後に誤発火しない', () => {
  const { w, clock, calls } = setup({ idleLimitMs: IDLE });
  w.onBoot();
  w.onStatus({ state: 'open' });
  clock.advance(IDLE - 1000);
  w.reset('alive-reset');
  calls.length = 0;
  w.onStatus({ state: 'open' });                  // 張り直し成功
  clock.advance(IDLE - 1);
  assert.deepEqual(calls, []);
  assert.equal(w.state.idleResets, 0);
});

test('古い socket の close (stale) は接続済みの状態を壊さない (#28 の実機検証)', () => {
  const { w, clock, calls } = setup({ idleLimitMs: IDLE });
  w.onBoot();
  w.onStatus({ state: 'open' });
  calls.length = 0;
  clock.advance(IDLE);                                  // idle → reset('idle') = close → connect
  assert.deepEqual(calls, ['close', 'connect']);
  w.onStatus({ state: 'ack' });                         // 張り直し成功 (実機では 0.8s 後)
  assert.equal(w.state.connected, true);
  calls.length = 0;
  clock.advance(2200);
  w.onStatus({ state: 'closed', code: 1005, byUs: 'dashboard', stale: true });  // 前の socket の後片付け
  assert.equal(w.state.connected, true);                // 上書きされない
  assert.equal(w.state.lastState, 'ack');
  assert.equal(w.armed, false);
  assert.equal(w.pending, false);
  clock.advance(IDLE - 2200 - 1);                       // idle も生きたまま (無受信ならまた張り直す)
  assert.deepEqual(calls, []);
  clock.advance(1);                                     // ack から idleLimitMs
  assert.deepEqual(calls, ['close', 'connect']);
});
