// background.js の「拡張の再起動」まわりの回帰テスト (#30)。
// chrome.runtime.reload() は拡張のページを殺すがウィンドウ/タブは閉じないので、
// 先にダッシュボードのタブを閉じないと空ウィンドウが 1 枚残る。
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

const DASH_URL = 'chrome-extension://x/dashboard.html';

// opts:
//   dashTabs      ダッシュボードとして query に一致するタブ
//   invalidTabs   chrome-extension://invalid/* に一致するタブ (reload の残骸)
//   pingOk        ダッシュボードのタブが ping に答えるか (false = 死んでいる)
//   diskVersion   manifest.json (ディスク) の版。running は '0.0.0'
//   stored        chrome.storage.local の初期値
function boot(opts = {}) {
  const { dashTabs = [], invalidTabs = [], allTabs = null, pingOk = true, diskVersion = '0.0.0',
          stored = {}, removeThrows = false, queryThrows = false } = opts;
  const calls = [];                          // 呼ばれた順そのもの
  const listeners = { runtime: [], installed: [] };
  const noop = () => {};
  const ev = () => ({ addListener: noop, removeListener: noop });
  const store = { ...stored };
  let reloaded;
  const reloadedP = new Promise(res => { reloaded = res; });

  const chrome = {
    runtime: {
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (fn) => listeners.runtime.push(fn) },
      onMessageExternal: ev(), onStartup: ev(),
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      getURL: (p) => 'chrome-extension://x/' + p,
      getManifest: () => ({ version: '0.0.0' }),
      reload: () => { calls.push(['runtime.reload']); reloaded(); }
    },
    tabs: {
      query: async (q) => {
        if (queryThrows) throw new Error('no tabs permission');
        if (q.url === DASH_URL) return dashTabs;
        if (String(q.url).startsWith('chrome-extension://invalid')) return invalidTabs;
        if (q.url === undefined) return allTabs ?? [];        // chrome.tabs.query({}) = 全タブ
        return [];
      },
      sendMessage: async (id, msg) => {
        calls.push(['tabs.sendMessage', id, msg.type]);
        if (msg.target === 'dashboard') {
          if (!pingOk) throw new Error('Could not establish connection');
          return { ok: true };
        }
        return { ok: true };
      },
      remove: async (id) => { calls.push(['tabs.remove', id]); if (removeThrows) throw new Error('No tab with id: ' + id); },
      reload: async (id) => { calls.push(['tabs.reload', id]); },
      update: async (id, props = {}) => {
        calls.push(['tabs.update', id, props.url ?? null]);
        return { id, windowId: (dashTabs.find(t => t.id === id) || {}).windowId ?? 1 };
      },
      create: async (o) => { calls.push(['tabs.create', o.url]); return { id: 99, windowId: 999 }; },
      get: async (id) => ({ id, url: 'https://github.com/' }),
      onRemoved: ev(), onUpdated: ev()
    },
    windows: {
      update: async (id) => { calls.push(['windows.update', id]); },
      create: async (o) => { calls.push(['windows.create', o.url]); return { id: 555 }; }
    },
    alarms: { create: noop, onAlarm: ev() }, action: { onClicked: ev() },
    storage: {
      local: {
        get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : Object.fromEntries((k || []).map(x => [x, store[x]]))),
        set: async (patch) => { calls.push(['storage.set', JSON.stringify(patch)]); Object.assign(store, patch); },
        remove: async (k) => { for (const x of [].concat(k)) delete store[x]; }
      },
      onChanged: ev()
    },
    scripting: {}, notifications: { create: noop }
  };
  const ctx = {
    chrome, console, setTimeout, clearTimeout, Date, Promise,
    fetch: async () => ({ json: async () => ({ version: diskVersion }) })
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  const send = (msg, sender = {}) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no response')), 2000);
    for (const fn of listeners.runtime) fn(msg, sender, (r) => { clearTimeout(t); res(r); });
  });
  const fireInstalled = async () => { for (const fn of listeners.installed) await fn({ reason: 'update' }); };
  const names = () => calls.map(c => c[0]);
  return { calls, names, send, fireInstalled, store, reloadedP };
}

test('reload コマンド: ダッシュボードのタブを閉じてから runtime.reload する', async () => {
  const h = boot({ dashTabs: [{ id: 11, windowId: 1 }] });
  const r = await h.send({ target: 'background', type: 'command', command: 'reload' });
  assert.equal(r.ok, true);
  assert.equal(r.reloading, true);
  await h.reloadedP;

  const order = h.names();
  const iRemove = order.indexOf('tabs.remove');
  const iReload = order.indexOf('runtime.reload');
  assert.ok(iRemove >= 0, 'tabs.remove が呼ばれること: ' + JSON.stringify(h.calls));
  assert.ok(iReload > iRemove, 'tabs.remove → runtime.reload の順であること: ' + JSON.stringify(h.calls));
  assert.deepEqual(h.calls[iRemove], ['tabs.remove', 11]);
  assert.equal(h.store.reopenDashboard, true, 'reload 後に開き直すフラグが立つこと');
});

test('reload コマンド: ダッシュボードが開いていなければ開き直さない', async () => {
  const h = boot({ dashTabs: [] });
  await h.send({ target: 'background', type: 'command', command: 'reload' });
  await h.reloadedP;
  assert.ok(!h.names().includes('tabs.remove'));
  assert.equal(h.store.reopenDashboard, false);
});

test('reload コマンド: tabs.remove が throw しても runtime.reload まで進む', async () => {
  // タブが既に消えている / 閉じられない端末でも拡張の再起動は止めない
  const h = boot({ dashTabs: [{ id: 11, windowId: 1 }], removeThrows: true });
  await h.send({ target: 'background', type: 'command', command: 'reload' });
  await h.reloadedP;
  assert.ok(h.names().includes('runtime.reload'), JSON.stringify(h.calls));
});

test('reload コマンド: tabs.query が throw しても runtime.reload まで進む', async () => {
  const h = boot({ queryThrows: true });
  await h.send({ target: 'background', type: 'command', command: 'reload' });
  await h.reloadedP;
  assert.ok(h.names().includes('runtime.reload'), JSON.stringify(h.calls));
});

test('ディスクの版が変わったら、タブを閉じてから reload する (self-update)', async () => {
  const h = boot({ dashTabs: [{ id: 21, windowId: 2 }], diskVersion: '9.9.9' });
  await h.send({ target: 'background', type: 'command', command: 'check-update' });
  await h.reloadedP;
  const order = h.names();
  assert.ok(order.indexOf('tabs.remove') >= 0);
  assert.ok(order.indexOf('runtime.reload') > order.indexOf('tabs.remove'));
  assert.equal(h.store.lastSelfUpdate, '0.0.0 -> 9.9.9');
});

test('ディスクの版が同じなら reload しない', async () => {
  const h = boot({ dashTabs: [{ id: 21, windowId: 2 }], diskVersion: '0.0.0' });
  await h.send({ target: 'background', type: 'command', command: 'check-update' });
  assert.ok(!h.names().includes('runtime.reload'));
  assert.ok(!h.names().includes('tabs.remove'));
});

test('open-dashboard: 既存タブが ping に答えなければ同じウィンドウで読み込み直す', async () => {
  const h = boot({ dashTabs: [{ id: 31, windowId: 3 }], pingOk: false });
  const r = await h.send({ target: 'background', type: 'open-dashboard', mode: 'popup' });
  assert.equal(r.windowId, 3, '同じウィンドウを返すこと (新しく開かない)');
  const order = h.names();
  assert.ok(order.includes('tabs.reload'), '死んだタブは tabs.reload する: ' + JSON.stringify(h.calls));
  assert.ok(!order.includes('windows.create'), '新しいウィンドウを開かないこと');
});

test('open-dashboard: 既存タブが生きていれば前面に出すだけ (読み込み直さない)', async () => {
  const h = boot({ dashTabs: [{ id: 31, windowId: 3 }], pingOk: true });
  const r = await h.send({ target: 'background', type: 'open-dashboard', mode: 'popup' });
  assert.equal(r.windowId, 3);
  const order = h.names();
  assert.ok(!order.includes('tabs.reload'), '生きているタブを reload しないこと');
  assert.ok(order.includes('windows.update'));
});

test('open-dashboard: タブが無ければ popup を開く', async () => {
  const h = boot({ dashTabs: [] });
  const r = await h.send({ target: 'background', type: 'open-dashboard', mode: 'popup' });
  assert.equal(r.windowId, 555);
  assert.ok(h.names().includes('windows.create'));
});

test('onInstalled: reopenDashboard が立っていれば invalid の残骸を閉じてから開き直す', async () => {
  const h = boot({ dashTabs: [], invalidTabs: [{ id: 41 }], stored: { reopenDashboard: true } });
  await h.fireInstalled();
  await new Promise(res => setTimeout(res, 50));
  const order = h.names();
  assert.deepEqual(h.calls.find(c => c[0] === 'tabs.remove'), ['tabs.remove', 41]);
  assert.ok(order.indexOf('windows.create') > order.indexOf('tabs.remove'), '掃除してから開くこと');
  assert.equal(h.store.reopenDashboard, undefined, 'フラグは消すこと');
});

test('onInstalled: reopenDashboard が無ければ何も開かず、他拡張の残骸も触らない', async () => {
  const h = boot({ dashTabs: [], invalidTabs: [{ id: 41 }] });
  await h.fireInstalled();
  await new Promise(res => setTimeout(res, 50));
  const order = h.names();
  assert.ok(!order.includes('tabs.remove'));
  assert.ok(!order.includes('windows.create'));
});

test('ダッシュボードが Chrome 最後の 1 枚なら閉じずに about:blank にする (Chrome を落とさない)', async () => {
  const tab = { id: 51, windowId: 5 };
  const h = boot({ dashTabs: [tab], allTabs: [tab] });
  await h.send({ target: 'background', type: 'command', command: 'reload' });
  await h.reloadedP;
  const order = h.names();
  assert.ok(!order.includes('tabs.remove'), '最後の 1 枚は remove しないこと: ' + JSON.stringify(h.calls));
  assert.deepEqual(h.calls.find(c => c[0] === 'tabs.update'), ['tabs.update', 51, 'about:blank']);
  assert.ok(order.indexOf('runtime.reload') > order.indexOf('tabs.update'));
  assert.equal(h.store.reopenTabId, 51, 'reload 後にそのタブへ読み込み直すため id を控えること');
});

test('他にタブがあれば従来どおり remove する', async () => {
  const tab = { id: 51, windowId: 5 };
  const h = boot({ dashTabs: [tab], allTabs: [tab, { id: 52, windowId: 6 }] });
  await h.send({ target: 'background', type: 'command', command: 'reload' });
  await h.reloadedP;
  assert.ok(h.names().includes('tabs.remove'));
});

test('onInstalled: reopenTabId があれば同じタブにダッシュボードを読み込み直す', async () => {
  const h = boot({ dashTabs: [], stored: { reopenDashboard: true, reopenTabId: 51 } });
  await h.fireInstalled();
  await new Promise(res => setTimeout(res, 50));
  assert.deepEqual(h.calls.find(c => c[0] === 'tabs.update'), ['tabs.update', 51, DASH_URL]);
  assert.ok(!h.names().includes('windows.create'), '新しいウィンドウを開かないこと');
  assert.equal(h.store.reopenTabId, undefined);
});
