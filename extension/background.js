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

// ダッシュボードのタブが「生きている」か (ping に答えるか)。
// chrome.runtime.reload() の後に残ったタブはページが死んでいて答えない (#30)。
async function dashboardAlive(tabId) {
  try { return !!(await chrome.tabs.sendMessage(tabId, { target: 'dashboard', type: 'ping' }))?.ok; }
  catch { return false; }
}

async function openDashboard({ mode = 'popup' } = {}) {
  const url = chrome.runtime.getURL(DASH);

  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    // 保険 (#30): URL は一致するのに中身が死んでいるタブ (reload 後の空白) は
    // 新しいウィンドウを開かず、**同じウィンドウで読み込み直す**。空ウィンドウを増やさない
    if (!(await dashboardAlive(existing[0].id))) {
      try { await chrome.tabs.reload(existing[0].id); } catch {}
    }
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
// 最後に relay からフレーム (push / ack) が来た時刻。ダッシュボードが閉じていても
// 「socket が生きているか」を status で言えるようにする (#28)。relay の ping にも
// lastFrameAt / sinceLastFrameMs があるが、こちらは中継が届いているかの裏取り
let aliveLastMessageAt = null;

async function findGithubTab() {
  const tabs = await chrome.tabs.query({ url: 'https://github.com/*' });
  // content script が入っているタブを優先 (ping が返るもの)
  for (const t of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(t.id, { target: 'alive-relay', type: 'ping' });
      if (r?.ok) return t.id;
    } catch { /* content script 未注入 */ }
  }
  // メモリセーバーで discard されたタブは content script ごと消えている。生きているタブを優先
  return (tabs.find(t => !t.discarded) ?? tabs[0])?.id ?? null;
}

// タブの読み込み完了 (= manifest の content script 注入) を待つ
function waitTabComplete(id, ms = 15000) {
  return new Promise(res => {
    const done = (tid, info) => { if (tid === id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); res(true); } };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); res(false); }, ms);
  });
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
    await waitTabComplete(id);                       // content script の注入を待つ
  } else {
    let tab = null;
    try { tab = await chrome.tabs.get(id); } catch {}
    if (tab?.discarded) {
      // discard されたタブには script を入れられない。読み込み直して manifest の content script を待つ
      try { await chrome.tabs.reload(id); await waitTabComplete(id); } catch {}
    } else {
      // 既存タブに content script が無ければ入れる (拡張の更新直後など)。
      // alive-relay.js は先頭の __ghAliveRelay で二重実行を防ぐので、入っていても害は無い
      try { await chrome.scripting.executeScript({ target: { tabId: id }, files: ['alive-relay.js'] }); } catch {}
    }
  }
  aliveTabId = id;
  return id;
}

// relay の socket を閉じさせる。タブが無ければ何もしない (閉じるものが無い)
async function aliveClose(reason = 'background') {
  if (aliveTabId == null) return { ok: true, closed: false, note: 'no alive tab' };
  try {
    const r = await chrome.tabs.sendMessage(aliveTabId, { target: 'alive-relay', type: 'close', reason });
    return { ok: true, ...r };
  } catch (e) {
    aliveTabId = null;
    return { ok: false, error: String(e?.message || e) };
  }
}

// relay に ping して readyState / tokens を聞く (診断用)
async function alivePing() {
  if (aliveTabId == null) return null;
  try { return await chrome.tabs.sendMessage(aliveTabId, { target: 'alive-relay', type: 'ping' }); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

// alive まわりの診断。status コマンドと dashboard の alive-state で返す (#25)
async function aliveDiag() {
  const relay = await alivePing();
  let tab = null;
  if (aliveTabId != null) { try { const t = await chrome.tabs.get(aliveTabId); tab = { id: t.id, url: t.url, discarded: !!t.discarded, status: t.status }; } catch {} }
  return {
    tabId: aliveTabId, tab,
    state: aliveState,                                 // 最後に relay から届いた alive-status
    lastMessageAt: aliveLastMessageAt,                 // 最後にフレームを受け取った時刻 (ISO)
    idleMs: aliveLastMessageAt ? Date.now() - Date.parse(aliveLastMessageAt) : null,
    cfg: aliveCfg ? { hasUrl: !!aliveCfg.url, tokens: aliveCfg.tokens?.length ?? 0 } : null,
    relay                                              // relay の ping 結果 (readyState: 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED)
  };
}

const isDashboardOpen = async () => (await chrome.tabs.query({ url: chrome.runtime.getURL(DASH) })).length > 0;

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

// content script からのイベントをダッシュボードへ中継する。
// relay からの msg には target:'background' が付いているので、**target は spread の後で** 上書きする。
// 逆 (`{ target:'dashboard', ...msg }`) だと target:'background' のまま届き、ダッシュボードは
// 全部捨てる → alive-status も alive-message (push) も一度も届かず connected:false のまま (#25 の真因)
function relayToDashboard(msg) { chrome.runtime.sendMessage({ ...msg, target: 'dashboard' }).catch(() => {}); }

// ---- Linux 側リレー ----
const bridge = createBridge({
  role: 'extension-bg',
  getUrl: async () => (await chrome.storage.local.get('bridgeUrl')).bridgeUrl || '',
  log: (...a) => console.log('[bg]', ...a),
  onCommand: async (msg) => {
    const r = await handleCommand(msg, 'bridge');
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
// ---- 拡張の再起動は全部ここを通す (#30) ----
// chrome.runtime.reload() は拡張のページを殺すが **ウィンドウ/タブは閉じない**。
// 残ったタブは chrome-extension://invalid/ 相当の空白になり、URL が一致しなくなるので
// onInstalled の reopenDashboard → openDashboard() は新しい popup を開く = 空ウィンドウが残る。
// 先に自分でダッシュボードのタブを閉じてから reload する。
// 経路 (再読込ボタン / update / 10 分ごとの self-update) は全部これを使う。
async function reloadSelf({ reopen, note, delayMs = 300 } = {}) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: chrome.runtime.getURL(DASH) }); } catch {}
  const reopenDashboard = reopen ?? tabs.length > 0;
  const patch = { reopenDashboard };
  if (note) patch.lastSelfUpdate = note;
  // ダッシュボードが Chrome の最後の 1 枚のときに remove すると Chrome ごと終わってしまう。
  // その時だけ about:blank に差し替え (拡張ページは同じく死ぬ)、reload 後は
  // **そのタブに**ダッシュボードを読み込み直す (新しいウィンドウを開かない)
  let all = [];
  try { all = await chrome.tabs.query({}); } catch {}
  const lastTabs = tabs.length > 0 && all.length > 0 && all.length <= tabs.length;
  if (lastTabs) patch.reopenTabId = tabs[0].id;
  try { await chrome.storage.local.set(patch); } catch {}
  // タブが既に無い / 閉じられない場合も **必ず reload まで進む**
  for (const t of tabs) {
    try {
      if (lastTabs) await chrome.tabs.update(t.id, { url: 'about:blank' });
      else          await chrome.tabs.remove(t.id);
    } catch {}
  }
  // 呼び元 (bridge の ack / ダッシュボードの応答) が返るだけの猶予
  if (delayMs) await new Promise(res => setTimeout(res, delayMs));
  chrome.runtime.reload();
  return { closed: lastTabs ? 0 : tabs.length, blanked: lastTabs ? tabs.length : 0, reopenDashboard };
}

// 更新: host に update.ps1 を走らせ、ディスクの版が変わったら自分をリロードする
async function runUpdate() {
  const r = await nativeCall('update');
  // reload の完了は待たない (待つと ack が返せない)。閉じる → reload の順は reloadSelf が守る
  if (r.ok && r.updated) reloadSelf({ note: `${r.from} -> ${r.to}` });
  return r;
}

// ---- 設定 / 操作の共通ハンドラ (bridge / github.com / ダッシュボードから同じものを呼ぶ) ----
// via: 'bridge' | 'external' (github.com タブ) | 'dashboard'
async function handleCommand(msg, via = 'external') {
  switch (msg.command) {
    case 'open-dashboard': return { ok: true, windowId: await openDashboard({ mode: msg.mode || 'popup' }) };
    case 'status':
      // ダッシュボードが開いていればそちらも {type:'status'} を返す。こちらは background 視点
      return { ok: true, version: chrome.runtime.getManifest().version, dashboardOpen: await isDashboardOpen(), alive: await aliveDiag() };
    case 'alive-reset': {
      // 強制再接続 (#25)。経路 (bridge / github.com / ダッシュボード) によらずここが受け口。
      // ダッシュボードが開いていれば、トークンを持つそちらに close → connect させる
      // (ダッシュボードは bridge から同じコマンドを直接受けても何もしない。二重に張り直さないため)。
      // 閉じていれば relay の socket を閉じて開き直す (boot が connect する)。
      if (await isDashboardOpen()) {
        relayToDashboard({ type: 'alive-reset', reason: `alive-reset via ${via}` });
        return { ok: true, delegated: 'dashboard', via };
      }
      const closed = await aliveClose('alive-reset');
      await openDashboard({ mode: msg.mode || 'popup' });
      return { ok: true, closed, reopened: true, via };
    }
    case 'reload':
      // 拡張ごと再起動 (ダッシュボードの「再読込」ボタン / bridge から)。
      // ダッシュボードは自分で runtime.reload() しない — 空ウィンドウが残るため (#30)。
      // ack を返してから reload させたいので await しない。開き直すかどうかは
      // reloadSelf が「今ダッシュボードが開いているか」で決める (msg.reopen で上書き可)
      reloadSelf({ reopen: typeof msg.reopen === 'boolean' ? msg.reopen : undefined });
      return { ok: true, reloading: true, via };
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
  handleCommand(msg || {}, 'external').then(sendResponse, e => sendResponse({ ok: false, error: String(e) }));
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
    await reloadSelf({ note: `${running} -> ${onDisk}` });
  } catch (e) { console.warn('[bg] checkDiskVersion', e); }
}

// 保険 2 (#30): reload で死んだ拡張ページのタブ (chrome-extension://invalid/) の掃除。
// reloadSelf が先に閉じているので通常は 0 件。旧版から上げた直後や、reload を
// 別経路 (chrome://extensions の ↻) で踏んだときだけ残る。
// 自分が reload した直後 (reopenDashboard が立っていた) にだけ走らせる —
// invalid には拡張 ID が残らないので、他拡張の残骸と区別が付かないため。
async function closeDeadExtensionTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'chrome-extension://invalid/*' }); } catch { return 0; }
  for (const t of tabs) { try { await chrome.tabs.remove(t.id); } catch {} }
  if (tabs.length) console.log('[bg] closed dead extension tabs', tabs.length);
  return tabs.length;
}

chrome.runtime.onInstalled.addListener(async (d) => {
  chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.create('self-update-check', { periodInMinutes: 10 });
  await applySeedConfig((...a) => console.log('[bg]', ...a));
  bridge.ensure();
  // 再読込ボタン / self-update の後にダッシュボードを開き直す (reason は unpacked の reload だと 'update')
  const { reopenDashboard, reopenTabId } = await chrome.storage.local.get(['reopenDashboard', 'reopenTabId']);
  if (reopenDashboard) {
    await chrome.storage.local.remove(['reopenDashboard', 'reopenTabId']);
    await closeDeadExtensionTabs();     // 旧版が残した空ウィンドウの掃除 (#30)
    // 閉じずに about:blank にしたタブ (Chrome 最後の 1 枚) があれば、そこに読み込み直す
    if (reopenTabId != null) {
      try {
        const t = await chrome.tabs.update(reopenTabId, { url: chrome.runtime.getURL(DASH), active: true });
        if (t) { try { await chrome.windows.update(t.windowId, { focused: true }); } catch {} return; }
      } catch {}
    }
    openDashboard({ mode: 'popup' });
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background') return;

  // content script (alive-relay) から
  if (msg.type === 'alive-ready') {
    if (sender.tab?.id != null && aliveTabId == null) aliveTabId = sender.tab.id;
    if (aliveCfg?.url) aliveConnect(null);
    return;
  }
  if (msg.type === 'alive-status')  {
    aliveState = { ...msg, at: new Date().toISOString() };
    if (msg.state === 'ack') aliveLastMessageAt = aliveState.at;    // ack も alive からのフレーム
    relayToDashboard(msg); return;
  }
  if (msg.type === 'alive-message') { aliveLastMessageAt = new Date().toISOString(); relayToDashboard(msg); return; }

  // ダッシュボードから: socket URL とトークンを渡して接続させる
  if (msg.type === 'alive-connect') {
    aliveConnect({ url: msg.url, tokens: msg.tokens }).then(sendResponse);
    return true;
  }
  if (msg.type === 'alive-close') { aliveClose(msg.reason || 'dashboard').then(sendResponse); return true; }
  if (msg.type === 'alive-state') { aliveDiag().then(d => sendResponse({ ok: true, ...d })); return true; }

  if (msg.type === 'open-dashboard') {
    openDashboard({ mode: msg.mode }).then(id => sendResponse({ ok: true, windowId: id }));
    return true;
  }
  if (msg.type === 'command') {
    handleCommand(msg, 'dashboard').then(sendResponse, e => sendResponse({ ok: false, error: String(e) }));
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
