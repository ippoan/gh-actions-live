// このウィンドウが全部を持つ。
//   1. GitHub の Actions ページを cookie 付きで取得 = スナップショット (別 API を叩かない)
//   2. そこから alive の socket URL と署名済み購読トークンを抜く
//   3. socket を張って購読。push は「変わった」の合図として扱う
//   4. 合図が来たらその run の partial (約 10KB) だけ取り直して状態を確定
//   5. repo ごとの列 + run カードで描画
// ページが持つ run は畳まれていないので、同一 repo で並列に走る run が全部並ぶ。

import { createBridge } from './bridge-client.js';

const GH = 'https://github.com';
const parser = new DOMParser();
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

const state = {
  repos: [],
  socket: null, socketUrl: null, connecting: false,
  tokenByTopic: new Map(),   // topic -> 署名済み data-channel
  repoByTopic: new Map(),    // topic -> "owner/repo"
  runs: new Map(),           // "repo#checkSuiteId" -> run
  pending: new Map(),
  connected: false,
  socketNote: '',
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

function subscribeAll() {
  if (state.socket?.readyState !== WebSocket.OPEN) return;
  const subscribe = {};
  for (const v of state.tokenByTopic.values()) subscribe[v] = null;
  state.socket.send(JSON.stringify({ subscribe }));
  log(`subscribed ${Object.keys(subscribe).length} channels`);
}

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

function connect() {
  if (state.connecting) return;
  const s = state.socket;
  if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) { subscribeAll(); return; }
  if (!state.socketUrl) return;

  state.connecting = true;
  const ws = new WebSocket(state.socketUrl);
  state.socket = ws;

  ws.onopen = () => { state.connecting = false; state.connected = true; render(); subscribeAll(); };

  ws.onmessage = async e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.e === 'ack') return;

    // push の形は未文書。サンプルを残して後で絞り込めるようにする。
    const { rawSamples = [] } = await chrome.storage.local.get('rawSamples');
    chrome.storage.local.set({ rawSamples: [String(e.data).slice(0, 1000), ...rawSamples].slice(0, 50) });

    const topic = msg.ch ? (decodeChannel(msg.ch) || msg.ch) : null;
    const repo = topic ? state.repoByTopic.get(topic) : null;

    if (topic?.startsWith('check_suites:') && repo) {
      const id = topic.split(':')[1];
      debounce(topic, () => refreshRun(repo, id).then(announce).catch(err => log('refreshRun', String(err))));
    } else {
      // repo 単位の合図 (新規 run など) → ページごと読み直してトークンも更新
      for (const rp of repo ? [repo] : state.repos) {
        debounce('repo:' + rp, () => loadRepo(rp).then(evs => { announce(evs); subscribeAll(); })
          .catch(err => log('loadRepo', String(err))), 1200);
      }
    }
  };

  ws.onclose = ev => { state.connecting = false; state.connected = false; render(); log('closed', ev.code); setTimeout(boot, 4000); };
  ws.onerror  = () => { state.connecting = false; state.connected = false; render(); };
}

/* ---------------- 描画 ---------------- */

const cls = s =>
  /success/i.test(s)                                          ? 's-ok'  :
  /running|queued|progress|waiting|pending|request/i.test(s)  ? 's-run' :
  /fail|cancel|timed|error|action required/i.test(s)          ? 's-bad' : 's-idle';
const RANK = { 's-bad':0, 's-run':1, 's-idle':2, 's-ok':3 };

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
  $('meta').textContent = `${state.repos.length} repos · ${state.runs.size} runs · ${
    state.connected ? 'socket 接続中' : ('未接続' + (state.socketNote ? ` (${state.socketNote})` : ''))} · ${
    state.lastLoadAt ? new Date(state.lastLoadAt).toLocaleTimeString() : '—'}`;

  const byRepo = new Map(state.repos.map(r => [r, []]));
  for (const r of state.runs.values()) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo).push(r);
  }

  const html = [...byRepo.entries()].map(([repo, runs]) => {
    runs.sort((a, b) => (RANK[cls(a.status)] - RANK[cls(b.status)]) ||
                        String(b.at || '').localeCompare(String(a.at || '')));
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
      case 'refresh':  boot(); break;
      case 'snapshot': bridge.send({ type: 'snapshot', runs: snapshot() }); break;
      case 'open-dashboard':
        // 自分が開いている = もう開いている。前面に出すだけ background に頼む
        chrome.runtime.sendMessage({ target: 'background', type: 'open-dashboard', mode: msg.mode }).catch(() => {});
        break;
      default: log('unknown command', msg.command);
    }
  }
});
chrome.storage.onChanged.addListener(c => { if (c.bridgeUrl) bridge.connect(); });

/* ---------------- 起動 ---------------- */

async function boot() {
  const { repos = [] } = await chrome.storage.local.get('repos');
  state.repos = repos;
  if (!repos.length) { render(); return; }

  for (const repo of repos) {
    try { announce(await loadRepo(repo)); }
    catch (e) { log('loadRepo failed', repo, String(e)); }
  }
  render();
  connect();
  bridge.ensure();
}

$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('reload').addEventListener('click', () => boot());
chrome.storage.onChanged.addListener((c) => { if (c.repos) boot(); });

boot();
setInterval(render, 5000);                 // 相対時刻の更新
setInterval(() => { boot(); }, 20 * 60000); // 署名トークンは時限なので定期的に取り直す
