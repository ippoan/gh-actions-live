// Service worker: ウィンドウの開閉・通知・Linux 側リレーからのコマンド受け口。
// WebSocket と描画の本体はダッシュボードのウィンドウ側が持つ (開いている限り死なない)。
//
// ここでもリレーに 1 本張っておくのは、ダッシュボードが閉じているときでも
// Linux から「ウィンドウを開け」を受けられるようにするため。MV3 の service worker は
// 短命だが、WebSocket の往来 (リレーの 20 秒 ping と pong) が続く限り生き続ける。
// 念のため chrome.alarms (最小 30 秒) でも再接続を蹴る。
import { createBridge } from './bridge-client.js';
import { applySeedConfig } from './seed-config.js';

const DASH = 'dashboard.html';

async function openDashboard({ mode = 'popup' } = {}) {
  const url = chrome.runtime.getURL(DASH);

  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.windows.update(existing[0].windowId, { focused: true, drawAttention: true });
    await chrome.tabs.update(existing[0].id, { active: true });
    return existing[0].windowId;
  }

  if (mode === 'tab') return (await chrome.tabs.create({ url })).windowId;

  const opts = { url, focused: true };
  if (mode === 'fullscreen')     Object.assign(opts, { type: 'popup', state: 'fullscreen' });
  else if (mode === 'maximized') Object.assign(opts, { type: 'normal', state: 'maximized' });
  else                           Object.assign(opts, { type: 'popup', width: 1280, height: 820 });

  return (await chrome.windows.create(opts)).id;
}

// ---- alive socket を持つ github.com タブの管理 ----
// 拡張ページから張ると Origin が chrome-extension:// になり alive に 1006 で切られる。
// github.com のタブ (content script alive-relay.js) から張れば Origin は https://github.com。
// ダッシュボードから socket URL と購読トークンを受け取り、そのタブへ中継する。
let aliveTabId = null;
let aliveCfg = null;          // { url, tokens }
let aliveState = { state: 'idle' };

async function findGithubTab() {
  const tabs = await chrome.tabs.query({ url: 'https://github.com/*' });
  // content script が入っているタブを優先 (ping が返るもの)
  for (const t of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, { target: 'alive-relay', type: 'ping' });
      if (r?.ok) return t.id;
    } catch { /* content script 未注入 */ }
  }
  return tabs[0]?.id ?? null;
}

// socket を持たせる github.com のタブを用意する。無ければ「監視対象 repo の Actions ページ」を
// pinned タブで開く (元々「Actions ページを開く」前提の設計。ユーザーの操作を邪魔しないよう
// pinned + 非アクティブ)。
async function ensureAliveTab() {
  if (aliveTabId != null) {
    try {
      const r = await chrome.tabs.sendMessage(aliveTabId, { target: 'alive-relay', type: 'ping' });
      if (r?.ok) return aliveTabId;
    } catch { aliveTabId = null; }
  }
  let id = await findGithubTab();
  if (id == null) {
    const { repos = [] } = await chrome.storage.local.get('repos');
    const url = repos.length ? `https://github.com/${repos[0]}/actions` : 'https://github.com/';
    const tab = await chrome.tabs.create({ url, pinned: true, active: false });
    id = tab.id;
    await new Promise(res => {                       // content script の注入を待つ
      const done = (tid, info) => { if (tid === id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); res(); } };
      chrome.tabs.onUpdated.addListener(done);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); res(); }, 15000);
    });
  } else {
    // 既存タブに content script が無ければ入れる (拡張の更新直後など)
    try { await chrome.scripting.executeScript({ target: { tabId: id }, files: ['alive-relay.js'] }); } catch {}
  }
  aliveTabId = id;
  return id;
}

async function aliveConnect(cfg) {
  if (cfg) aliveCfg = cfg;
  if (!aliveCfg?.url) return { ok: false, error: 'no socket url' };
  const id = await ensureAliveTab();
  if (id == null) return { ok: false, error: 'no github tab' };
  try {
    await chrome.tabs.sendMessage(id, { target: 'alive-relay', type: 'connect', url: aliveCfg.url, tokens: aliveCfg.tokens });
    return { ok: true, tabId: id };
  } catch (e) {
    aliveTabId = null;
    return { ok: false, error: String(e?.message || e) };
  }
}

chrome.tabs.onRemoved.addListener(id => { if (id === aliveTabId) { aliveTabId = null; aliveState = { state: 'tab-closed' }; } });

// content script からのイベントをダッシュボードへ中継する
function relayToDashboard(msg) { chrome.runtime.sendMessage({ target: 'dashboard', ...msg }).catch(() => {}); }

// ---- Linux 側リレー ----
const bridge = createBridge({
  role: 'extension-bg',
  getUrl: async () => (await chrome.storage.local.get('bridgeUrl')).bridgeUrl || '',
  log: (...a) => console.log('[bg]', ...a),
  onCommand: async (msg) => {
    const r = await handleCommand(msg);
    bridge.send({ type: 'ack', command: msg.command, ...r });
  }
});

// ---- native messaging host (installer/host.ps1) ----
// 拡張はディスクに書けないので、「更新」の実体はローカルの host が走らせる update.ps1。
// MSI で入れていない (zip 展開) 端末には host が無く、sendNativeMessage が reject する。
const NATIVE_HOST = 'jp.ippoan.gh_actions_live';
async function nativeCall(cmd) {
  try { return await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd }); }
  catch (e) { return { ok: false, error: String(e?.message || e), noHost: true }; }
}
// 更新: host に update.ps1 を走らせ、ディスクの版が変わったら自分をリロードする
async function runUpdate() {
  const r = await nativeCall('update');
  if (r.ok && r.updated) {
    const dash = await chrome.tabs.query({ url: chrome.runtime.getURL(DASH) });
    await chrome.storage.local.set({ reopenDashboard: dash.length > 0, lastSelfUpdate: `${r.from} -> ${r.to}` });
    setTimeout(() => chrome.runtime.reload(), 300);
  }
  return r;
}

// ---- 設定 / 操作の共通ハンドラ (bridge / github.com / ダッシュボードから同じものを呼ぶ) ----
async function handleCommand(msg) {
  switch (msg.command) {
    case 'open-dashboard': return { ok: true, windowId: await openDashboard({ mode: msg.mode || 'popup' }) };
    case 'check-update':   await checkDiskVersion(); return { ok: true };
    case 'update':         return await runUpdate();
    case 'native-ping':    return await nativeCall('ping');
    case 'set-config': {
      const patch = {};
      if (Array.isArray(msg.repos)) patch.repos = msg.repos.map(String).filter(Boolean);
      if (typeof msg.notify === 'boolean') patch.notify = msg.notify;
      if (typeof msg.bridgeUrl === 'string') patch.bridgeUrl = msg.bridgeUrl.trim();
      await chrome.storage.local.set(patch);
      return { ok: true, applied: patch };
    }
    case 'get-config':
      return { ok: true, ...(await chrome.storage.local.get(['repos', 'notify', 'bridgeUrl'])), version: chrome.runtime.getManifest().version };
    default: return { ok: false, error: 'unknown command: ' + msg.command };
  }
}

// github.com のページからのメッセージ (externally_connectable)。
// Claude in Chrome は github.com のタブで JS を実行できるので、ここが「Claude から設定を入れる」入口になる。
// origin を厳密に見る (github.com 以外は manifest で弾かれるが二重に)。
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!sender.origin || sender.origin !== 'https://github.com') { sendResponse({ ok: false, error: 'origin' }); return; }
  handleCommand(msg || {}).then(sendResponse, e => sendResponse({ ok: false, error: String(e) }));
  return true;
});

// ---- 自動更新 (ディスク側は installer/update.ps1 が書き換える) ----
// unpacked 拡張は chrome.runtime.getURL('manifest.json') でディスク上の manifest が読める。
// 動いている版 (getManifest) と違えば update.ps1 が差し替えた後なので、自分をリロードする。
// ダッシュボードを開いていたらリロード後に開き直す (reload で拡張ページは一度落ちる)。
async function checkDiskVersion() {
  try {
    const r = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const onDisk = (await r.json()).version;
    const running = chrome.runtime.getManifest().version;
    if (!onDisk || onDisk === running) return;
    console.log('[bg] on-disk version', onDisk, '!= running', running, '-> reload');
    const dash = await chrome.tabs.query({ url: chrome.runtime.getURL(DASH) });
    await chrome.storage.local.set({ reopenDashboard: dash.length > 0, lastSelfUpdate: `${running} -> ${onDisk}` });
    chrome.runtime.reload();
  } catch (e) { console.warn('[bg] checkDiskVersion', e); }
}

chrome.runtime.onInstalled.addListener(async (d) => {
  chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.create('self-update-check', { periodInMinutes: 10 });
  await applySeedConfig((...a) => console.log('[bg]', ...a));
  bridge.ensure();
  // 再読込ボタン / self-update の後にダッシュボードを開き直す (reason は unpacked の reload だと 'update')
  const { reopenDashboard } = await chrome.storage.local.get('reopenDashboard');
  if (reopenDashboard) { await chrome.storage.local.remove('reopenDashboard'); openDashboard({ mode: 'popup' }); }
});
chrome.runtime.onStartup.addListener(async () => { await applySeedConfig(); bridge.ensure(); checkDiskVersion(); });
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name === 'bridge-keepalive') bridge.ensure();
  if (a.name === 'self-update-check') { await applySeedConfig(); checkDiskVersion(); }
});
applySeedConfig().then(() => bridge.ensure());
chrome.storage.onChanged.addListener(c => { if (c.bridgeUrl) bridge.connect(); });
bridge.ensure();

// default_popup を置いていないので onClicked が発火する
chrome.action.onClicked.addListener(() => openDashboard({ mode: 'popup' }));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background') return;

  // content script (alive-relay) から
  if (msg.type === 'alive-ready') {
    if (sender.tab?.id != null && aliveTabId == null) aliveTabId = sender.tab.id;
    if (aliveCfg?.url) aliveConnect(null);
    return;
  }
  if (msg.type === 'alive-status')  { aliveState = { ...msg, at: new Date().toISOString() }; relayToDashboard(msg); return; }
  if (msg.type === 'alive-message') { relayToDashboard(msg); return; }

  // ダッシュボードから: socket URL とトークンを渡して接続させる
  if (msg.type === 'alive-connect') {
    aliveConnect({ url: msg.url, tokens: msg.tokens }).then(sendResponse);
    return true;
  }
  if (msg.type === 'alive-state') { sendResponse({ ok: true, tabId: aliveTabId, ...aliveState }); return true; }

  if (msg.type === 'open-dashboard') {
    openDashboard({ mode: msg.mode }).then(id => sendResponse({ ok: true, windowId: id }));
    return true;
  }
  if (msg.type === 'command') {
    handleCommand(msg).then(sendResponse, e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'notify') {
    for (const ev of msg.events || []) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: `${ev.repo} — ${ev.workflow} #${ev.run}`,
        message: `${ev.from ? ev.from + ' → ' : ''}${ev.label}\n${ev.ref || ''}`
      });
    }
  }

  if (msg.type === 'log') console.log('[dashboard]', ...msg.args);
});
