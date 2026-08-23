// このウィンドウが全部を持つ。
//   1. GitHub の Actions ページを cookie 付きで取得 = スナップショット (別 API を叩かない)
//   2. そこから alive の socket URL と署名済み購読トークンを抜く
//   3. socket を張って購読。push は「変わった」の合図として扱う
//   4. 合図が来たらその run の partial (約 10KB) だけ取り直して状態を確定
//   5. repo ごとの列 + run カードで描画
// ページが持つ run は畳まれていないので、同一 repo で並列に走る run が全部並ぶ。

import { createBridge } from './bridge-client.js';
import { applySeedConfig } from './seed-config.js';
import { createAliveWatchdog } from './alive-watchdog.js';

const GH = 'https://github.com';
const parser = new DOMParser();
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

const state = {
  repos: [],
  socketUrl: null,
  tokenByTopic: new Map(),   // topic -> 署名済み data-channel
  repoByTopic: new Map(),    // topic -> "owner/repo"
  runs: new Map(),           // "repo#checkSuiteId" -> run
  pending: new Map(),
  connected: false,          // alive watchdog から同期される (render / status 用)
  socketNote: '',
  lastMessageAt: null,       // alive から最後にフレームを受けた時刻 (ヘッダの「最終受信」)
  bridgeStatus: 'off', bridgeNote: '',
  lastLoadAt: null,
  // 初回スナップショットを取り終えた repo。ここに入るまで通知を出さない
  // (取り終える前は全 run が「初めて見た」= 新規扱いになり全件通知になる)
  bootstrapped: new Set()
};

const log = (...a) => { console.log('[live]', ...a); chrome.runtime.sendMessage({ target:'background', type:'log', args:a }).catch(()=>{}); };
const decodeChannel = v => { try { return JSON.parse(atob(v.split('--')[0])).c; } catch { return null; } };

/* ---------------- GitHub 読み取り ---------------- */

// 行 1 つ。aria-label に status / run番号 / workflow名 / title が全部入っている。
function parseRow(row) {
  const a = row.querySelector('a[aria-label]');
  if (!a) return null;
  const m = (a.getAttribute('aria-label') || '').match(/^([^:]*):\s*Run (\d+) of ([^.]+)\.\s*(.*)$/);
  if (!m) return null;

  const text = (row.textContent || '').replace(/\s+/g, ' ');
  const by = text.match(/(?:pushed|triggered|run|opened) by ([\w.\-\[\]]+)/i);
  const refEl = row.querySelector('a[href*="/tree/"], a[href*="/releases/tag/"], .Label');

  return {
    checkSuiteId: row.id.replace('check_suite_', ''),
    runId: (a.getAttribute('href') || '').split('/').pop(),
    href: GH + (a.getAttribute('href') || ''),
    status: m[1].trim(), run: m[2], workflow: m[3].trim(), title: m[4].trim(),
    ref: refEl ? refEl.textContent.trim().slice(0, 40) : '',
    by: by ? by[1] : '',
    at: row.querySelector('relative-time')?.getAttribute('datetime') || null
  };
}

// partial=true のときだけ XHR ヘッダを付ける。
// フルページに付けると GitHub が断片だけ返し、<head> にある
// link[rel="shared-web-socket"] が取れなくなる (行は断片に入るので
// run 一覧は出るのに socket だけ繋がらない、という出方をする)。
async function fetchDoc(path, { partial = false } = {}) {
  const headers = { 'Accept': 'text/html' };
  if (partial) headers['X-Requested-With'] = 'XMLHttpRequest';
  const r = await fetch(GH + path, { credentials: 'include', headers });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return parser.parseFromString(await r.text(), 'text/html');
}

function ingestChannels(doc, repo) {
  for (const el of doc.querySelectorAll('[data-channel]')) {
    const v = el.getAttribute('data-channel');
    const topic = decodeChannel(v);
    if (!topic) continue;
    if (!topic.startsWith('workflow_runs:') && !topic.startsWith('check_suites:')) continue;
    state.tokenByTopic.set(topic, v);   // 発行時刻 t が新しいものに毎回上書き
    state.repoByTopic.set(topic, repo);
  }
}

function apply(repo, r) {
  const key = `${repo}#${r.checkSuiteId}`;
  const prev = state.runs.get(key);
  state.runs.set(key, { repo, ...r, seenAt: new Date().toISOString() });
  if (prev && prev.status === r.status) return null;
  return { repo, from: prev?.status, label: r.status, workflow: r.workflow, run: r.run,
           ref: r.ref, title: r.title, href: r.href, runId: r.runId, by: r.by, t: new Date().toISOString() };
}

// Actions ページ = スナップショット。全 run が畳まれずに入っている。
async function loadRepo(repo) {
  const doc = await fetchDoc(`/${repo}/actions`);
  const link = doc.querySelector('link[rel="shared-web-socket"]');
  if (link) { state.socketUrl = link.getAttribute('href'); state.socketNote = ''; }
  else {
    state.socketNote = 'socket URL 無し (未ログイン?)';
    log(`${repo}: link[rel=shared-web-socket] が無い — 未ログインか、断片だけが返っている`);
  }

  ingestChannels(doc, repo);

  const first = !state.bootstrapped.has(repo);
  const changed = [];
  for (const row of doc.querySelectorAll('.Box-row[id^="check_suite_"]')) {
    const r = parseRow(row);
    if (!r) continue;
    const ev = apply(repo, r);
    if (ev && !first) changed.push(ev);
  }
  state.bootstrapped.add(repo);
  state.lastLoadAt = new Date().toISOString();
  return changed;
}

// 1 run だけ軽く確定させる (約 10KB)
async function refreshRun(repo, checkSuiteId) {
  const doc = await fetchDoc(`/${repo}/actions/workflow-run/${checkSuiteId}`, { partial: true });
  const row = doc.querySelector('.Box-row[id^="check_suite_"]');
  if (!row) return [];
  ingestChannels(doc, repo);
  const r = parseRow(row);
  if (!r) return [];
  const ev = apply(repo, r);
  return ev ? [ev] : [];
}

/* ---------------- alive socket ---------------- */

function debounce(key, fn, ms = 700) {
  clearTimeout(state.pending.get(key));
  state.pending.set(key, setTimeout(fn, ms));
}

async function announce(events) {
  if (!events.length) return;
  render();
  bridge.send({ type: 'events', events });
  const { notify = false } = await chrome.storage.local.get('notify');   // 既定オフ
  const worth = events.filter(e =>
    /fail|cancel|timed|error|action required/i.test(e.label) ||
    // 新しく走り出したものだけ。初見で既に completed のものは過去分なので出さない。
    (!e.from && /running|queued|progress|waiting|pending/i.test(e.label)));
  if (notify && worth.length) chrome.runtime.sendMessage({ target:'background', type:'notify', events: worth }).catch(()=>{});
}

// alive の socket は **github.com のタブ** (content script) が持つ。
// 拡張ページから張ると Origin が chrome-extension:// になり 1006 で切られるため
// (v0.0.19 の DNR による Origin 書き換えでも直らなかった)。
// ここは socket URL と購読トークンを background に渡し、結果を受け取るだけ。
function connect() {
  if (!state.socketUrl) { alive.onConnectError('socket URL 無し'); return; }
  const tokens = [...state.tokenByTopic.values()];
  return chrome.runtime.sendMessage({ target: 'background', type: 'alive-connect', url: state.socketUrl, tokens })
    .then(r => { if (!r?.ok) alive.onConnectError(r?.error || 'タブに接続できない'); })
    .catch(e => alive.onConnectError(e));
}
// relay の socket を閉じさせる (watchdog の張り直し / alive-reset の前段)
function closeRelay() {
  return chrome.runtime.sendMessage({ target: 'background', type: 'alive-close', reason: 'dashboard' }).catch(() => {});
}

// 再接続の判断は全部ここ (#25)。connect を頼んだら必ず N 秒の watchdog を張り、
// open/subscribed/ack が来なければ close → バックオフ付きで張り直す。
const alive = createAliveWatchdog({
  connect, close: closeRelay, boot: () => boot(),
  handshakeMs: 20000,            // relay 自身の握手タイムアウト (15s) より長く。先に relay が error を返す
  // 繋がった後の見張り (#28)。alive は定期フレームを送ってこないことがあるので、
  // 「無受信 = 死んでいる」と決めつけず **張り直して確かめる** 用の閾値。
  // 20 分ごとの boot より短く、通常の push 間隔より十分長く取る
  idleLimitMs: 10 * 60000,
  log,
  onChange: (st) => {
    state.connected = st.connected; state.socketNote = st.note; state.lastMessageAt = st.lastMessageAt;
    render();
  }
});

// content script からのイベントは background 経由で届く
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'dashboard') return;

  if (msg.type === 'alive-status') { alive.onStatus(msg); return; }
  // background からの強制再接続 (bridge / github.com 経由の alive-reset)
  if (msg.type === 'alive-reset') { alive.reset(msg.reason || 'alive-reset'); return; }

  if (msg.type === 'alive-message') {
    alive.onMessage(msg);            // 受信したことが socket が生きている唯一の証拠 (#28)
    state.lastMessageAt = alive.state.lastMessageAt;
    let m; try { m = JSON.parse(msg.data); } catch { return; }
    chrome.storage.local.get('rawSamples').then(({ rawSamples = [] }) =>
      chrome.storage.local.set({ rawSamples: [String(msg.data).slice(0, 1000), ...rawSamples].slice(0, 50) }));

    const topic = m.ch ? (decodeChannel(m.ch) || m.ch) : null;
    const repo = topic ? state.repoByTopic.get(topic) : null;
    if (topic?.startsWith('check_suites:') && repo) {
      const id = topic.split(':')[1];
      debounce(topic, () => refreshRun(repo, id).then(announce).catch(err => log('refreshRun', String(err))));
    } else {
      for (const rp of repo ? [repo] : state.repos) {
        debounce('repo:' + rp, () => loadRepo(rp).then(evs => { announce(evs); alive.ensure(); })
          .catch(err => log('loadRepo', String(err))), 1200);
      }
    }
  }
});

/* ---------------- 描画 ---------------- */

const cls = s =>
  /success/i.test(s)                                          ? 's-ok'  :
  /running|queued|progress|waiting|pending|request/i.test(s)  ? 's-run' :
  /fail|cancel|timed|error|action required/i.test(s)          ? 's-bad' : 's-idle';
// 並び: 実行中だけ上に寄せ、あとは新しい順。
// 以前は失敗も上に固定していたが、36 分前の failed が直近の success より上に来て
// 「ソートされていない」ように見えた。失敗は赤い帯で十分目立つので時系列に戻す。
const RANK = s => (s === 's-run' ? 0 : 1);

function ago(t) {
  if (!t) return '';
  const d = (Date.now() - new Date(t)) / 1000;
  if (d < 60) return `${Math.max(0, d|0)}秒前`;
  if (d < 3600) return `${d/60|0}分前`;
  if (d < 86400) return `${d/3600|0}時間前`;
  return `${d/86400|0}日前`;
}

function card(r) {
  return `<a class="card ${cls(r.status)}" href="${esc(r.href)}" target="_blank" rel="noopener">
    <span class="dot"></span>
    <div class="ttl" title="${esc(r.title)}">${esc(r.title) || '<span style="opacity:.6">(no title)</span>'}</div>
    <div class="when">${esc(r.status)}<br>${ago(r.at)}</div>
    <div class="meta">${esc(r.workflow)} <b>#${esc(r.run)}</b>${
      r.ref ? `<span class="tag">${esc(r.ref)}</span>` : ''}${r.by ? ` · ${esc(r.by)}` : ''}</div>
  </a>`;
}

function render() {
  $('live').className = 'live ' + (state.connected ? 'on' : 'off');
  // 「接続中」だけでは half-open を見抜けない (#28)。最後にフレームを受けた時刻を必ず併記する
  const recv = state.lastMessageAt != null
    ? `最終受信 ${new Date(state.lastMessageAt).toLocaleTimeString()} (${ago(state.lastMessageAt)})`
    : '最終受信 —';
  $('meta').textContent = `${state.repos.length} repos · ${state.runs.size} runs · ${
    state.connected ? 'socket 接続中' : ('未接続' + (state.socketNote ? ` (${state.socketNote})` : ''))} · ${
    recv} · ${state.lastLoadAt ? new Date(state.lastLoadAt).toLocaleTimeString() : '—'}`;

  const byRepo = new Map(state.repos.map(r => [r, []]));
  for (const r of state.runs.values()) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo).push(r);
  }

  const html = [...byRepo.entries()].map(([repo, runs]) => {
    runs.sort((a, b) => (RANK(cls(a.status)) - RANK(cls(b.status))) ||
                        String(b.at || b.seenAt || '').localeCompare(String(a.at || a.seenAt || '')));
    const active = runs.filter(r => cls(r.status) === 's-run').length;
    const bad    = runs.filter(r => cls(r.status) === 's-bad').length;
    return `<section>
      <h2>${esc(repo)}<span class="count">${
        bad ? `<span style="color:var(--bad)">✕ ${bad}</span> · ` : ''}${
        active ? `<span style="color:var(--run)">● ${active} 実行中</span> · ` : ''}${runs.length} runs</span></h2>
      <div class="cards">${runs.slice(0, 30).map(card).join('') ||
        '<div class="card s-idle"><span class="dot"></span><div class="ttl" style="opacity:.6">読み込み中…</div></div>'}</div>
    </section>`;
  }).join('');

  $('grid').innerHTML = html || '<div class="empty">設定で repo を追加してください。</div>';
}

/* ---------------- Linux 側リレー ---------------- */

const snapshot = () => [...state.runs.values()].map(r => ({
  repo: r.repo, workflow: r.workflow, run: r.run, status: r.status, ref: r.ref,
  title: r.title, href: r.href, runId: r.runId, by: r.by, at: r.at
}));

const bridge = createBridge({
  role: 'extension',
  getUrl: async () => (await chrome.storage.local.get('bridgeUrl')).bridgeUrl || '',
  log,
  onStatus: (st, note) => {
    state.bridgeStatus = st; state.bridgeNote = note || '';
    const el = $('bridge');
    if (el) {
      el.textContent = 'bridge: ' + ({ open: '接続中', connecting: '接続中…', closed: '切断', error: 'エラー', off: '未設定' }[st] || st);
      el.style.color = st === 'open' ? 'var(--ok)' : (st === 'off' ? 'var(--dim)' : 'var(--bad)');
    }
    if (st === 'open') {
      bridge.send({ type: 'hello', role: 'extension', repos: state.repos, version: chrome.runtime.getManifest().version });
      bridge.send({ type: 'snapshot', runs: snapshot() });
    }
  },
  onCommand: (msg) => {
    switch (msg.command) {
      case 'refresh':  boot(); checkLatest(); break;
      case 'check-update': checkLatest(); break;
      case 'set-config': {
        const patch = {};
        if (Array.isArray(msg.repos)) patch.repos = msg.repos.map(String).filter(Boolean);
        if (typeof msg.notify === 'boolean') patch.notify = msg.notify;
        if (typeof msg.bridgeUrl === 'string') patch.bridgeUrl = msg.bridgeUrl.trim();
        chrome.storage.local.set(patch).then(() => { bridge.send({ type: 'ack', command: 'set-config', applied: patch }); boot(); });
        break;
      }
      case 'snapshot': bridge.send({ type: 'snapshot', runs: snapshot() }); break;
      case 'status': sendStatus(); break;
      case 'alive-reset':
        // background が受け口 (同じコマンドを受けて、こちらへ {type:'alive-reset'} を転送してくる)。
        // ここでも reset すると二重に close → connect になるので何もしない
        break;
      case 'open-dashboard':
        // 自分が開いている = もう開いている。前面に出すだけ background に頼む
        chrome.runtime.sendMessage({ target: 'background', type: 'open-dashboard', mode: msg.mode }).catch(() => {});
        break;
      default: log('unknown command', msg.command);
    }
  }
});
chrome.storage.onChanged.addListener(c => { if (c.bridgeUrl) bridge.connect(); });

// 診断用。alive socket の状態を Linux 側から見る。
// ダッシュボード側 (watchdog) だけでなく background の aliveState と relay の ping
// (readyState / tokens) も載せ、「CONNECTING で固まっている」のか「socket が無い」のかを区別できるようにする (#25)
async function sendStatus() {
  const bg = await chrome.runtime.sendMessage({ target: 'background', type: 'alive-state' }).catch(e => ({ ok: false, error: String(e) }));
  const w = alive.snapshot();
  bridge.send({ type: 'status',
    version: chrome.runtime.getManifest().version,
    alive: { connected: w.connected, hasSocketUrl: !!state.socketUrl,
             subscribedTopics: state.tokenByTopic.size, note: w.note,
             fails: w.fails, backoffMs: w.backoff,
             lastState: w.lastState, lastStateAt: w.lastStateAt ? new Date(w.lastStateAt).toISOString() : null,
             lastConnectAt: w.lastConnectAt ? new Date(w.lastConnectAt).toISOString() : null,
             // 「繋がっている」の実体。idleMs が idleLimitMs に近いまま伸びるなら half-open (#28)
             lastMessageAt: w.lastMessageAt != null ? new Date(w.lastMessageAt).toISOString() : null,
             idleMs: w.idleMs, idleLimitMs: w.idleLimitMs, idleResets: w.idleResets,
             watchdogArmed: w.watchdogArmed, idleArmed: w.idleArmed, reconnectPending: w.reconnectPending,
             nextRetryAt: w.nextRetryAt ? new Date(w.nextRetryAt).toISOString() : null,
             background: bg },
    repos: state.repos, runs: state.runs.size, lastLoadAt: state.lastLoadAt,
    bridge: state.bridgeStatus });
}

/* ---------------- 版の表示 (自動更新は update.ps1 + background が行う) ---------------- */

async function checkLatest() {
  const running = chrome.runtime.getManifest().version;
  const el = $('ver');
  try {
    const r = await fetch('https://github.com/ippoan/gh-actions-live/releases/latest/download/update.xml', { cache: 'no-store' });
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const latest = xml.querySelector('updatecheck')?.getAttribute('version');
    const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i]||0) !== (y[i]||0)) return (x[i]||0) - (y[i]||0); } return 0; };
    const btn = $('update');
    if (latest && cmp(latest, running) > 0) {
      el.textContent = `v${running} → v${latest} あり`; el.style.color = 'var(--run)';
      el.title = '新版が Release に出ています。「更新」を押すと native host が update.ps1 を実行し、拡張が自分でリロードします (MSI で入れた端末のみ。zip 展開なら展開し直し)。';
      btn.style.display = ''; btn.textContent = `v${latest} に更新`; btn.disabled = false;
    } else { el.textContent = `v${running}`; el.style.color = 'var(--dim)'; btn.style.display = 'none'; }
  } catch { el.textContent = `v${running}`; }
}

/* ---------------- 起動 ---------------- */

async function boot() {
  await applySeedConfig(log);   // インストーラーが書いた config.json があれば取り込む
  const { repos = [] } = await chrome.storage.local.get('repos');
  state.repos = repos;
  // repo が空でもリレーには繋ぐ (Linux 側から set-config できるように)。
  // 以前はここで return していて、repo 未設定だと bridge が「—」のまま動かなかった。
  bridge.ensure();
  if (!repos.length) { render(); return; }

  for (const repo of repos) {
    try { announce(await loadRepo(repo)); }
    catch (e) { log('loadRepo failed', repo, String(e)); }
  }
  render();
  alive.onBoot();    // 未接続なら無条件で close → connect (CONNECTING で固まった relay もここで叩き直す)
  bridge.ensure();
}

$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('update').addEventListener('click', async () => {
  const btn = $('update'); btn.disabled = true; btn.textContent = '更新中…';
  const r = await chrome.runtime.sendMessage({ target: 'background', type: 'command', command: 'update' }).catch(e => ({ ok: false, error: String(e) }));
  if (r?.ok && r.updated) { btn.textContent = `v${r.to} に更新 → リロード中…`; return; }   // background が reload する
  btn.disabled = false;
  if (r?.noHost) {
    btn.textContent = '更新 (MSI 未導入)';
    alert('native host が見つかりません。MSI で入れた端末でのみボタン更新が使えます。\nzip 展開で入れている場合は、新しい zip を同じフォルダに展開して拡張カードの ↻ を押してください。');
  } else if (r?.ok) {
    btn.textContent = '更新'; alert('ディスク上は最新でした (' + (r.to || '?') + ')。');
  } else {
    btn.textContent = '更新 (失敗)'; alert('更新に失敗: ' + (r?.error || r?.output || '不明'));
  }
});
// 再読込 = 拡張ごと再起動する (ページ内の再取得ではなく)。chrome.runtime.reload() で
// background も含めて立ち上げ直し、ディスク上に新版があればそれも拾う。
// reopenDashboard を立てておくと background の onInstalled がこのウィンドウを開き直す。
$('reload').addEventListener('click', async () => {
  $('reload').disabled = true; $('reload').textContent = '再起動中…';
  await chrome.storage.local.set({ reopenDashboard: true });
  chrome.runtime.reload();
});
chrome.storage.onChanged.addListener((c) => { if (c.repos) boot(); });

boot();
checkLatest();
setInterval(checkLatest, 5 * 60000);   // 30 分だと新版が出てもボタンがなかなか出ない (実機)
setInterval(render, 5000);                 // 相対時刻の更新
setInterval(() => { boot(); }, 20 * 60000); // 署名トークンは時限なので定期的に取り直す
