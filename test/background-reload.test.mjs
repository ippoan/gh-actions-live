// background.js の「拡張の再起動」まわりの回帰テスト (#30 / #32)。
// chrome.runtime.reload() は拡張のページを殺すがウィンドウ/タブは閉じないので、
// 放っておくと空ウィンドウが 1 枚残る (#30)。かといって tabs.remove で閉じると復活が
// 新規ウィンドウになり、reload 直後は Windows の foreground lock で前面に出ない (#32)。
// → ダッシュボードのタブは about:blank に差し替え、reload 後に同じタブへ読み込み直す。
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
//   updateThrows  tabs.update が throw する (タブが消えている)
function boot(opts = {}) {
  const { dashTabs = [], invalidTabs = [], allTabs = null, pingOk = true, diskVersion = '0.0.0',
          stored = {}, removeThrows = false, queryThrows = false, updateThrows = false } = opts;
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
        if (updateThrows) throw new Error('No tab with id: ' + id);
        return { id, windowId: (dashTabs.find(t => t.id === id) || {}).windowId ?? 1 };
      },
      create: async (o) => { calls.push(['tabs.create', o.url]); return { id: 99, windowId: 999 }; },
      get: async (id) => ({ id, url: 'https://github.com/' }),
      onRemoved: ev(), onUpdated: ev()
    },
    windows: {
      update: async (id, props = {}) => { calls.push(['windows.update', id, props]); },
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

// reload の前処理が「about:blank に差し替え → runtime.reload」の順で、tabs.remove を使わないこと
function assertBlankThenReload(h, tabId) {
  const order = h.names();
  const iBlank = h.calls.findIndex(c => c[0] === 'tabs.update' && c[1] === tabId && c[2] === 'about:blank');
  const iReload = order.indexOf('runtime.reload');
  assert.ok(!order.includes('tabs.remove'), 'tabs.remove は使わないこと (#32): ' + JSON.stringify(h.calls));
  assert.ok(iBlank >= 0, 'tabs.update(about:blank) が呼ばれること: ' + JSON.stringify(h.calls));
  assert.ok(iReload > iBlank, 'about:blank → runtime.reload の順であること: ' + JSON.stringify(h.calls));
  assert.ok(!order.includes('windows.create'), 'reload 前に新しいウィンドウを作らないこと');
}

test('reload コマンド: ダッシュボードのタブを about:blank にしてから runtime.reload する (閉じない)', async () => {
  const h = boot({ dashTabs: [{ id: 11, windowId: 1 }], allTabs: [{ id: 11, windowId: 1 }, { id: 12, windowId: 2 }] });
  const r = await h.send({ target: 'background', type: 'command', command: 'reload' });
  assert.equal(r.ok, true);
  assert.equal(r.reloading, true);
  await h.reloadedP;
  assertBlankThenReload(h, 11);
  assert.equal(h.store.reopenDashboard, true, 'reload 後に開き直すフラグが立つこと');
  assert.equal(h.store.reopenTabId, 11, 'reload 後に同じタブへ読み込み直すため id を控えること');
});

test('reload コマンド: ダッシュボードが開いていなければ開き直さない', async () => {
  const h = boot({ dashTabs: [] });
  await h.send({ target: 'background', type: 'command', command: 'reload' });
  await h.reloadedP;
  assert.ok(!h.names().includes('tabs.remove'));
  assert.ok(!h.names().includes('tabs.update'));
  assert.equal(h.store.reopenDashboard, false);
  assert.equal(h.store.reopenTabId, null, '古い reopenTabId を持ち越さないこと');
});

test('reload コマンド: ダッシュボードが複数あれば先頭を reopenTabId にし、全部 about:blank にする', async () => {
  const h = boot({ dashTabs: [{ id: 11, windowId: 1 }, { id: 12, windowId: 2 }] });
  await h.send({ target: 'background', type: 'command', command: 'reload' });
  await h.reloadedP;
  assertBlankThenReload(h, 11);
  assertBlankThenReload(h, 12);
  assert.equal(h.store.reopenTabId, 11);
});

test('reload コマンド: tabs.update が throw しても runtime.reload まで進む', async () => {
  // タブが既に消えている端末でも拡張の再起動は止めない
  const h = boot({ dashTabs: [{ id: 11, windowId: 1 }], updateThrows: true });
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

test('ディスクの版が変わったら、タブを about:blank にしてから reload する (self-update)', async () => {
  const h = boot({ dashTabs: [{ id: 21, windowId: 2 }], diskVersion: '9.9.9' });
  await h.send({ target: 'background', type: 'command', command: 'check-update' });
  await h.reloadedP;
  assertBlankThenReload(h, 21);
  assert.equal(h.store.reopenTabId, 21);
  assert.equal(h.store.lastSelfUpdate, '0.0.0 -> 9.9.9');
});

test('ディスクの版が同じなら reload しない', async () => {
  const h = boot({ dashTabs: [{ id: 21, windowId: 2 }], diskVersion: '0.0.0' });
  await h.send({ target: 'background', type: 'command', command: 'check-update' });
  assert.ok(!h.names().includes('runtime.reload'));
  assert.ok(!h.names().includes('tabs.remove'));
  assert.ok(!h.names().includes('tabs.update'));
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

test('open-dashboard: タブが無ければ popup を開き、もう一度前面要求を打つ (#32 の保険)', async () => {
  const h = boot({ dashTabs: [] });
  const r = await h.send({ target: 'background', type: 'open-dashboard', mode: 'popup' });
  assert.equal(r.windowId, 555);
  const order = h.names();
  const iCreate = order.indexOf('windows.create');
  assert.ok(iCreate >= 0);
  const focus = h.calls.find((c, i) => i > iCreate && c[0] === 'windows.update' && c[1] === 555);
  assert.ok(focus, 'windows.create の後に windows.update(555) を打つこと: ' + JSON.stringify(h.calls));
  // (vm コンテキスト越しのオブジェクトなので deepEqual ではなくフィールドで比べる)
  assert.equal(focus[2].focused, true);
  assert.equal(focus[2].drawAttention, true);
  assert.equal(focus[2].state, 'normal', 'popup 既定は state:normal で前面に戻すこと');
});

test('open-dashboard: fullscreen / maximized では state を normal に戻さない', async () => {
  for (const mode of ['fullscreen', 'maximized']) {
    const h = boot({ dashTabs: [] });
    await h.send({ target: 'background', type: 'open-dashboard', mode });
    const focus = h.calls.find(c => c[0] === 'windows.update' && c[1] === 555);
    assert.ok(focus, mode);
    assert.equal(focus[2].focused, true);
    assert.equal(focus[2].state, undefined, mode + ' の state を潰さないこと');
  }
});

test('onInstalled: reopenTabId があれば同じタブにダッシュボードを読み込み直し、前面に出す', async () => {
  const h = boot({ dashTabs: [{ id: 51, windowId: 5 }], stored: { reopenDashboard: true, reopenTabId: 51 } });
  await h.fireInstalled();
  await new Promise(res => setTimeout(res, 50));
  const iLoad = h.calls.findIndex(c => c[0] === 'tabs.update' && c[1] === 51 && c[2] === DASH_URL);
  assert.ok(iLoad >= 0, 'tabs.update(51, dashboard.html) が呼ばれること: ' + JSON.stringify(h.calls));
  const focus = h.calls.find((c, i) => i > iLoad && c[0] === 'windows.update' && c[1] === 5);
  assert.ok(focus, '読み込み直した後に windows.update(5, focused) を打つこと: ' + JSON.stringify(h.calls));
  assert.equal(focus[2].focused, true);
  assert.equal(focus[2].drawAttention, true);
  assert.ok(!h.names().includes('windows.create'), '新しいウィンドウを開かないこと');
  assert.ok(!h.names().includes('tabs.remove'), 'タブを閉じないこと');
  assert.equal(h.store.reopenTabId, undefined, 'フラグは消すこと');
  assert.equal(h.store.reopenDashboard, undefined);
});

test('onInstalled: reopenTabId のタブが消えていたら openDashboard にフォールバック', async () => {
  const h = boot({ dashTabs: [], stored: { reopenDashboard: true, reopenTabId: 51 }, updateThrows: true });
  await h.fireInstalled();
  await new Promise(res => setTimeout(res, 50));
  const order = h.names();
  assert.ok(order.includes('windows.create'), 'タブが無いときだけ新しく開くこと: ' + JSON.stringify(h.calls));
  assert.equal(h.store.reopenTabId, undefined);
});

test('onInstalled: reopenDashboard だけ (reopenTabId 無し) なら invalid の残骸を閉じてから開き直す', async () => {
  // 旧版 (tabs.remove していた v0.0.25 以前) から上げた直後の経路
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

test('ダッシュボードが Chrome 最後の 1 枚でも同じ (about:blank → reload → 同じタブ)。Chrome を落とさない', async () => {
  const tab = { id: 51, windowId: 5 };
  const h = boot({ dashTabs: [tab], allTabs: [tab] });
  await h.send({ target: 'background', type: 'command', command: 'reload' });
  await h.reloadedP;
  assertBlankThenReload(h, 51);
  assert.equal(h.store.reopenTabId, 51);
});

// 一連の流れ: reload コマンド → about:blank → runtime.reload → (新 worker の) onInstalled →
// 同じタブに dashboard.html → windows.update(focused)。reload 前後で windows.create は一度も出ない
test('通し: reload → onInstalled で同じウィンドウに復活し前面に出る (windows.create 無し)', async () => {
  const tab = { id: 61, windowId: 6 };
  const h1 = boot({ dashTabs: [tab], allTabs: [tab, { id: 62, windowId: 7 }] });
  await h1.send({ target: 'background', type: 'command', command: 'reload' });
  await h1.reloadedP;
  assertBlankThenReload(h1, 61);
  // reload 後の worker は storage だけ引き継ぐ
  const h2 = boot({ dashTabs: [{ id: 61, windowId: 6 }], stored: { ...h1.store } });
  await h2.fireInstalled();
  await new Promise(res => setTimeout(res, 50));
  const seq = h2.calls.filter(c => ['tabs.update', 'windows.update', 'windows.create', 'tabs.remove'].includes(c[0]))
    .map(c => c[0] === 'tabs.update' ? `tabs.update(${c[1]},${c[2]})` : c[0] === 'windows.update' ? `windows.update(${c[1]},focused=${c[2].focused})` : c[0]);
  assert.deepEqual(seq, [`tabs.update(61,${DASH_URL})`, 'windows.update(6,focused=true)'], JSON.stringify(h2.calls));
});
