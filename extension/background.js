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

// ---- Linux 側リレー ----
const bridge = createBridge({
  role: 'extension-bg',
  getUrl: async () => (await chrome.storage.local.get('bridgeUrl')).bridgeUrl || '',
  log: (...a) => console.log('[bg]', ...a),
  onCommand: async (msg) => {
    if (msg.command === 'open-dashboard') {
      const id = await openDashboard({ mode: msg.mode || 'popup' });
      bridge.send({ type: 'ack', command: 'open-dashboard', windowId: id });
    }
    if (msg.command === 'check-update') checkDiskVersion();
    // Linux 側から設定を流し込む: {command:'set-config', repos:[...], notify:bool, bridgeUrl:'...'}
    if (msg.command === 'set-config') {
      const patch = {};
      if (Array.isArray(msg.repos)) patch.repos = msg.repos.map(String).filter(Boolean);
      if (typeof msg.notify === 'boolean') patch.notify = msg.notify;
      if (typeof msg.bridgeUrl === 'string') patch.bridgeUrl = msg.bridgeUrl.trim();
      await chrome.storage.local.set(patch);
      bridge.send({ type: 'ack', command: 'set-config', applied: patch });
    }
    if (msg.command === 'get-config') {
      bridge.send({ type: 'config', ...(await chrome.storage.local.get(['repos', 'notify', 'bridgeUrl'])), version: chrome.runtime.getManifest().version });
    }
    // refresh / snapshot はダッシュボード側が処理する (run の状態はそちらにしか無い)
  }
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
  if (d.reason === 'update') {
    const { reopenDashboard } = await chrome.storage.local.get('reopenDashboard');
    if (reopenDashboard) { await chrome.storage.local.remove('reopenDashboard'); openDashboard({ mode: 'popup' }); }
  }
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

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.target !== 'background') return;

  if (msg.type === 'open-dashboard') {
    openDashboard({ mode: msg.mode }).then(id => sendResponse({ ok: true, windowId: id }));
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
