// background.js の「alive タブが消えたらダッシュボードへ closed を送る」の回帰テスト (#36)。
// content script はタブごと死ぬので自分では closed を post できない。background が代わりに
// alive-status closed (byUs 無し・stale 無し) を送らないと、ダッシュボードは idle watchdog (10 分)
// まで connected:true のままで push が止まる。
// background.js は ESM + chrome API 前提なので、import を stub に差し替えて vm で走らせる。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../extension/background.js');
const SRC = fs.readFileSync(file, 'utf8')
  .replace(/^import \{ createBridge \} from '.\/bridge-client.js';$/m,
           "const createBridge = () => ({ ensure() {}, connect() {}, send() {}, close() {}, open: false });")
  .replace(/^import \{ applySeedConfig \} from '.\/seed-config.js';$/m,
           'const applySeedConfig = async () => {};');
assert.ok(!/^import /m.test(SRC), 'import を全部 stub に置き換えたこと');

// opts.pingOk: content script への ping が答えるか (false = 「Could not establish connection」で throw)
function boot({ pingOk = true } = {}) {
  const sent = [];                                  // runtime.sendMessage (ダッシュボード宛)
  const pings = [];                                 // tabs.sendMessage の (tabId, type)
  const listeners = { runtime: [], removed: [], updated: [] };
  const noop = () => {};
  const ev = () => ({ addListener: noop, removeListener: noop });
  const chrome = {
    runtime: {
      sendMessage: (m) => { sent.push(m); return Promise.resolve(); },
      onMessage: { addListener: (fn) => listeners.runtime.push(fn) },
      onMessageExternal: ev(), onInstalled: ev(), onStartup: ev(),
      getURL: (p) => 'chrome-extension://x/' + p,
      getManifest: () => ({ version: '0.0.0' })
    },
    tabs: {
      query: async () => [],
      sendMessage: async (id, msg) => {
        pings.push([id, msg.type]);
        if (!pingOk) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true };
      },
      get: async (id) => ({ id, url: 'https://github.com/' }),
      onRemoved: { addListener: (fn) => listeners.removed.push(fn), removeListener: noop },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn), removeListener: noop }
    },
    windows: {}, alarms: { create: noop, onAlarm: ev() }, action: { onClicked: ev() },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: ev() },
    scripting: {}, notifications: { create: noop }
  };
  const ctx = { chrome, console: { ...console, log: noop }, setTimeout, clearTimeout,
                fetch: async () => ({ json: async () => ({}) }), Date, Promise };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  const onMessage = (msg, sender = { tab: { id: 1 } }) => {
    let resp;
    for (const fn of listeners.runtime) fn(msg, sender, (r) => { resp = r; });
    return resp;
  };
  const aliveState = () => new Promise(res => {
    for (const fn of listeners.runtime) fn({ target: 'background', type: 'alive-state' }, {}, res);
  });
  // alive-ready で aliveTabId を tabId にする (content script が注入されたときと同じ経路)
  const adoptTab = (tabId) => onMessage({ target: 'background', type: 'alive-ready', href: 'https://github.com/' }, { tab: { id: tabId } });
  const removed = (tabId) => { for (const fn of listeners.removed) fn(tabId, { windowId: 1, isWindowClosing: false }); };
  // onUpdated ハンドラは async。全部の戻り値を待つ
  const updated = (tabId, info) => Promise.all(listeners.updated.map(fn => fn(tabId, info, { id: tabId })));
  const closedMsgs = () => sent.filter(m => m.type === 'alive-status' && m.state === 'closed');
  return { sent, pings, onMessage, aliveState, adoptTab, removed, updated, closedMsgs };
}

test('alive タブが閉じられたら dashboard へ closed (reason:tab-closed) を送る', async () => {
  const b = boot();
  b.adoptTab(7);
  b.removed(7);
  const closed = b.closedMsgs();
  assert.equal(closed.length, 1);
  assert.deepEqual({ ...closed[0] }, {   // vm 側の Object なので spread でこちらの realm に写す
     type: 'alive-status', state: 'closed', code: null, reason: 'tab-closed', tabId: 7, target: 'dashboard' });
  assert.equal(closed[0].byUs, undefined);            // byUs 無し = watchdog が fail → 再接続
  assert.equal(closed[0].stale, undefined);           // stale 無し = 本物の close として扱う
  const st = await b.aliveState();
  assert.equal(st.tabId, null);
  assert.equal(st.state.state, 'tab-closed');
  assert.equal(st.state.tabId, 7);
});

test('alive タブ以外のタブが閉じられても何も送らない', async () => {
  const b = boot();
  b.adoptTab(7);
  b.removed(8);
  assert.equal(b.closedMsgs().length, 0);
  assert.equal((await b.aliveState()).tabId, 7);
});

test('alive タブが github.com 以外へ遷移し content script が居なければ closed (reason:tab-gone)', async () => {
  const b = boot({ pingOk: false });
  b.adoptTab(7);
  await b.updated(7, { status: 'loading', url: 'https://example.com/' });
  const closed = b.closedMsgs();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].reason, 'tab-gone');
  assert.equal(closed[0].code, null);
  assert.equal(closed[0].target, 'dashboard');
  assert.ok(b.pings.some(([id, t]) => id === 7 && t === 'ping'), '送る前に ping で不在を確かめる');
  const st = await b.aliveState();
  assert.equal(st.tabId, null);
  assert.equal(st.state.state, 'tab-gone');
  assert.equal(st.state.url, 'https://example.com/');
});

test('alive タブが discard されたら closed (reason:tab-gone)', async () => {
  const b = boot({ pingOk: false });
  b.adoptTab(7);
  await b.updated(7, { discarded: true });
  const closed = b.closedMsgs();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].reason, 'tab-gone');
  assert.equal((await b.aliveState()).state.discarded, true);
});

test('github.com 内の遷移 (SPA) では ping もせず何も送らない', async () => {
  const b = boot({ pingOk: false });
  b.adoptTab(7);
  await b.updated(7, { status: 'loading', url: 'https://github.com/ippoan/gh-actions-live/actions' });
  await b.updated(7, { status: 'complete' });
  await b.updated(7, { title: 'Actions' });
  assert.equal(b.closedMsgs().length, 0);
  assert.equal(b.pings.filter(([id]) => id === 7).length, 0);
  assert.equal((await b.aliveState()).tabId, 7);
});

test('URL は変わっても content script が ping に答えるなら送らない (まだ居る)', async () => {
  const b = boot({ pingOk: true });
  b.adoptTab(7);
  await b.updated(7, { url: 'https://example.com/' });
  assert.equal(b.closedMsgs().length, 0);
  assert.equal((await b.aliveState()).tabId, 7);
});

test('alive タブ以外の onUpdated は無視する', async () => {
  const b = boot({ pingOk: false });
  b.adoptTab(7);
  await b.updated(8, { url: 'https://example.com/' });
  await b.updated(8, { discarded: true });
  assert.equal(b.closedMsgs().length, 0);
  assert.equal(b.pings.length, 0);
});
