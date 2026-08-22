// Service worker: ウィンドウの開閉・通知・Linux 側リレーからのコマンド受け口。
// WebSocket と描画の本体はダッシュボードのウィンドウ側が持つ (開いている限り死なない)。
//
// ここでもリレーに 1 本張っておくのは、ダッシュボードが閉じているときでも
// Linux から「ウィンドウを開け」を受けられるようにするため。MV3 の service worker は
// 短命だが、WebSocket の往来 (リレーの 20 秒 ping と pong) が続く限り生き続ける。
// 念のため chrome.alarms (最小 30 秒) でも再接続を蹴る。
import { createBridge } from './bridge-client.js';

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
    // refresh / snapshot はダッシュボード側が処理する (run の状態はそちらにしか無い)
  }
});

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 }); bridge.ensure(); });
chrome.runtime.onStartup.addListener(() => bridge.ensure());
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'bridge-keepalive') bridge.ensure(); });
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
