// background.js の「relay → ダッシュボード」中継の回帰テスト (#25 の真因)。
// relay の alive-status / alive-message には target:'background' が付いている。
// 中継時に target を 'dashboard' に付け替えないとダッシュボードが全部捨てる。
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

function boot() {
  const sent = [];
  const listeners = { runtime: [] };
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
    tabs: { query: async () => [], onRemoved: ev(), onUpdated: ev(), sendMessage: async () => ({ ok: true }) },
    windows: {}, alarms: { create: noop, onAlarm: ev() }, action: { onClicked: ev() },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: ev() },
    scripting: {}, notifications: { create: noop }
  };
  const ctx = { chrome, console, setTimeout, clearTimeout, fetch: async () => ({ json: async () => ({}) }), Date, Promise };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  // mode 'async' なら sendResponse が呼ばれるのを待つ (alive-state など非同期応答)
  const onMessage = (msg, sender = { tab: { id: 1 } }, mode = 'sync') => {
    if (mode === 'async') return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('no response')), 1000);
      for (const fn of listeners.runtime) fn(msg, sender, (r) => { clearTimeout(t); res(r); });
    });
    let resp;
    for (const fn of listeners.runtime) fn(msg, sender, (r) => { resp = r; });
    return resp;
  };
  return { sent, onMessage };
}

test('relay の alive-status は target:dashboard に付け替えて中継される', () => {
  const { sent, onMessage } = boot();
  onMessage({ target: 'background', instance: 'abc', type: 'alive-status', state: 'open' });
  const relayed = sent.filter(m => m.type === 'alive-status');
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].target, 'dashboard');
  assert.equal(relayed[0].state, 'open');
  assert.equal(relayed[0].instance, 'abc');
});

test('relay の alive-message (push) も target:dashboard で届く', () => {
  const { sent, onMessage } = boot();
  onMessage({ target: 'background', type: 'alive-message', data: '{"ch":"x"}' });
  const relayed = sent.filter(m => m.type === 'alive-message');
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].target, 'dashboard');
  assert.equal(relayed[0].data, '{"ch":"x"}');
});

test('alive-state は最後の alive-status と relay の ping を返す', async () => {
  const { onMessage } = boot();
  onMessage({ target: 'background', type: 'alive-ready', href: 'https://github.com/' }, { tab: { id: 7 } });
  onMessage({ target: 'background', type: 'alive-status', state: 'subscribed', count: 3 }, { tab: { id: 7 } });
  const got = await onMessage({ target: 'background', type: 'alive-state' }, {}, 'async');
  assert.equal(got.ok, true);
  assert.equal(got.tabId, 7);
  assert.equal(got.state.state, 'subscribed');
  assert.equal(got.relay.ok, true);                    // stub の tabs.sendMessage が返す
});
