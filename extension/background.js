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

  const win = await chrome.windows.create(opts);
  // 保険 (#32): reload 直後の service worker から作ったウィンドウは Windows の foreground lock で
  // 前面に来ないことがある (create の focused:true だけでは足りない)。もう一度前面要求を打つ。
  // state は popup 既定のときだけ 'normal' に戻す (fullscreen / maximized を潰さない)
  const focus = { focused: true, drawAttention: true };
  if (!opts.state) focus.state = 'normal';
  try { await chrome.windows.update(win.id, focus); } catch {}
  return win.id;
}

// ---- cloudflared access login の承認ページを開く (#40) ----
// `cloudflared access login <domain>` が出す URL をこちら側の Chrome で開き、人が「Approve」を
// 押せるようにするだけの導線。トークンを取りに行くのは Linux 側の cloudflared 自身なので、
// ブラウザは承認するだけでよく、Windows の Chrome で承認しても成立する。
//
// bridge は tailnet の 8799 で待ち受けていて認証が無い。そこへ到達できる者に
// 「任意の URL を開かせる」と capability の穴になるので、**開ける URL を 4 条件で絞る**:
// (1) https  (2) userinfo が無い  (3) ホストが accessLoginHosts に完全一致
// (4) パスが /cdn-cgi/access/cli ちょうど。
// (3) は **deny-by-default** — 未設定 / 空配列なら何も開かない。
// 「設定が無いから全部通す」は、設定を入れ忘れた環境が一番危険になる最悪の既定なので取らない。
const ACCESS_LOGIN_PATH = '/cdn-cgi/access/cli';

// 通れば { url }、弾けば { error }。error にクエリを載せない
// (Access の URL には token=<nonce> が乗っている。出すのはホスト名とパスまで)
function parseAccessLoginUrl(raw, hosts) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'url required' };
  let u;
  try { u = new URL(raw); } catch { return { error: 'invalid url' }; }
  if (u.protocol !== 'https:') return { error: `scheme not allowed: ${u.protocol} (https only)` };
  // userinfo は入口で落とす。https://dtako.ippoan.org@evil.example.com/... は
  // 文字列としては正規のホストに見えるのに、実際に開く先は evil.example.com になる
  // (なりすまし)。u.host に userinfo は入らないので、ホスト検査だけでは防げない。
  // 文言に username を含めない — そこに紛らわしいホスト名が入っている
  if (u.username !== '' || u.password !== '') return { error: 'credentials in url not allowed' };
  // 完全一致のみ。後方一致 (endsWith('.ippoan.org')) は evil-ippoan.org 型の取り違えを招くので採らない
  const allow = Array.isArray(hosts) ? hosts.map(h => String(h).trim().toLowerCase()).filter(Boolean) : [];
  if (!allow.length) return { error: 'accessLoginHosts not configured (deny by default)' };
  if (!allow.includes(u.host.toLowerCase())) return { error: `host not allowed: ${u.host}` };
  // new URL() は `..` を畳んでから pathname に入れる。その**正規化後**の値で完全一致を見る
  // (前方一致だと .../cdn-cgi/access/cli/../../admin のような書き方を通してしまう)
  if (u.pathname !== ACCESS_LOGIN_PATH) return { error: `path not allowed: ${u.host}${u.pathname}` };
  return { url: u.href };
}

// 人が今すぐ Approve を押せる状態にするのが目的なので、既存ウィンドウを使い回さず
// 毎回**前面の**ウィンドウで開く (openDashboard は自分のページ専用なので流用しない)。
async function openApprovalWindow(url) {
  const win = await chrome.windows.create({ url, type: 'popup', width: 980, height: 800, focused: true });
  // #32 と同じ保険: create の focused:true だけでは Windows の foreground lock で前面に来ないことがある
  try { await chrome.windows.update(win.id, { focused: true, drawAttention: true, state: 'normal' }); } catch {}
  const tab = (win.tabs || [])[0];
  if (tab) { try { await chrome.tabs.update(tab.id, { active: true }); } catch {} }
  return win.id;
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

// alive タブが消えた / content script ごと居なくなった (#36)。
// content script はタブと一緒に死ぬので自分では `closed` を post できない。ここで代わりに
// ダッシュボードへ `closed` を送る (byUs 無し・stale 無し → watchdog が fail → バックオフ → connect →
// ensureAliveTab が pinned タブを開き直す)。送らないと idle watchdog (10 分) まで connected:true のまま push が止まる
function aliveTabGone(reason, extra = {}) {
  const tabId = aliveTabId;
  aliveTabId = null;
  aliveState = { state: reason, tabId, ...extra, at: new Date().toISOString() };
  console.log('[bg] alive tab gone:', reason, tabId, extra);
  relayToDashboard({ type: 'alive-status', state: 'closed', code: null, reason, tabId });
}

chrome.tabs.onRemoved.addListener(id => { if (id === aliveTabId) aliveTabGone('tab-closed'); });

// alive タブが github.com 以外へ遷移した / メモリセーバーで discard された。
// github.com 内の SPA 遷移 (pushState) でも onUpdated に url は来るが content script は残っているので、
// **本当に居なくなったか ping で確かめてから** 送る
async function onAliveTabUpdated(id, info = {}) {
  if (id !== aliveTabId) return false;
  const left = typeof info.url === 'string' && !info.url.startsWith('https://github.com/');
  if (!left && !info.discarded) return false;
  try {
    const r = await chrome.tabs.sendMessage(id, { target: 'alive-relay', type: 'ping' });
    if (r?.ok && id === aliveTabId) return false;     // まだ居る (SPA 遷移など)
  } catch { /* content script 無し */ }
  if (id !== aliveTabId) return false;                // ping 待ちの間に onRemoved 等で処理済み
  aliveTabGone('tab-gone', { url: info.url, discarded: !!info.discarded });
  return true;
}
chrome.tabs.onUpdated.addListener(onAliveTabUpdated);

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
// ---- 拡張の再起動は全部ここを通す (#30 / #32) ----
// chrome.runtime.reload() は拡張のページを殺すが **ウィンドウ/タブは閉じない**。
// 残ったタブは chrome-extension://invalid/ 相当の空白になり、URL が一致しなくなるので
// onInstalled の reopenDashboard → openDashboard() は新しい popup を開く = 空ウィンドウが残る (#30)。
// かといって先に tabs.remove で閉じると、復活が新規ウィンドウになり、reload 直後の
// service worker からでは Windows の foreground lock で前面に出ない (#32、v0.0.25 で実測)。
// → ダッシュボードのタブは **閉じずに about:blank に差し替える** (拡張ページは同じく死ぬ)。
// ウィンドウは位置も z 順もそのまま生き残り、reload 後に onInstalled が **そのタブに**
// ダッシュボードを読み込み直す (reopenTabId)。Chrome 最後の 1 枚でも Chrome が落ちない。
// 経路 (再読込ボタン / update / 10 分ごとの self-update) は全部これを使う。
async function reloadSelf({ reopen, note, delayMs = 300 } = {}) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: chrome.runtime.getURL(DASH) }); } catch {}
  const reopenDashboard = reopen ?? tabs.length > 0;
  // 複数開いていれば先頭に読み込み直す。残りは about:blank のまま (新規ウィンドウは作らない)
  const reopenTabId = tabs.length ? tabs[0].id : null;
  const patch = { reopenDashboard, reopenTabId };
  if (note) patch.lastSelfUpdate = note;
  try { await chrome.storage.local.set(patch); } catch {}
  // タブが既に無い / 差し替えられない場合も **必ず reload まで進む**
  for (const t of tabs) {
    try { await chrome.tabs.update(t.id, { url: 'about:blank' }); } catch {}
  }
  // 呼び元 (bridge の ack / ダッシュボードの応答) が返るだけの猶予
  if (delayMs) await new Promise(res => setTimeout(res, delayMs));
  chrome.runtime.reload();
  return { blanked: tabs.length, reopenDashboard, reopenTabId };
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
    case 'access-login': {
      // cloudflared access login が出した承認 URL を開く。allowlist を通らなければ**開かない**
      const { accessLoginHosts } = await chrome.storage.local.get('accessLoginHosts');
      const parsed = parseAccessLoginUrl(msg.url, accessLoginHosts);
      if (parsed.error) return { ok: false, error: parsed.error };
      return { ok: true, windowId: await openApprovalWindow(parsed.url) };
    }
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
      // access-login で開いてよいホスト (完全一致 / deny-by-default)。[] を入れれば無効化できる
      if (Array.isArray(msg.accessLoginHosts)) {
        patch.accessLoginHosts = msg.accessLoginHosts.map(h => String(h).trim().toLowerCase()).filter(Boolean);
      }
      await chrome.storage.local.set(patch);
      return { ok: true, applied: patch };
    }
    case 'get-config':
      return { ok: true, ...(await chrome.storage.local.get(['repos', 'notify', 'bridgeUrl', 'accessLoginHosts'])), version: chrome.runtime.getManifest().version };
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
    // reloadSelf が about:blank に差し替えたタブに、**同じウィンドウのまま**読み込み直す (#32)。
    // 前面要求も打つ (reload 直後は foreground lock で前面に来にくい → drawAttention も)。
    // タブが消えていた (ユーザーが閉じた等) ときだけ新しく開く
    if (reopenTabId != null) {
      try {
        const t = await chrome.tabs.update(reopenTabId, { url: chrome.runtime.getURL(DASH), active: true });
        if (t) {
          try { await chrome.windows.update(t.windowId, { focused: true, drawAttention: true }); } catch {}
          return;
        }
      } catch (e) { console.warn('[bg] reopenTabId', reopenTabId, 'gone -> openDashboard', e?.message || e); }
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
