// github.com のタブで動く content script。alive.github.com の WebSocket を **ここで** 張る。
//
// なぜタブなのか: 拡張ページ (chrome-extension://) から張ると Origin がそれになり、
// alive は握手直後に 1006 で切る。declarativeNetRequest の modifyHeaders でも
// websocket 握手の Origin は変えられなかった (v0.0.19 で実測)。
// github.com のタブから張れば Origin は https://github.com になり、そのまま通る
// (このページで手動で試して ack を受けたのが最初の確認)。
//
// 役割は socket を持つことだけ。ページ取得 (スナップショット) と描画は
// これまでどおりダッシュボード側が行い、購読トークンはここへ渡される。

let ws = null;
let wantUrl = '';
let tokens = [];

function post(msg) { try { chrome.runtime.sendMessage({ target: 'background', ...msg }); } catch {} }

function subscribe() {
  if (ws?.readyState !== WebSocket.OPEN || !tokens.length) return;
  const subscribe = {};
  for (const t of tokens) subscribe[t] = null;
  ws.send(JSON.stringify({ subscribe }));
  post({ type: 'alive-status', state: 'subscribed', count: tokens.length });
}

function connect(url, newTokens) {
  if (Array.isArray(newTokens) && newTokens.length) tokens = newTokens;
  if (url) wantUrl = url;
  if (!wantUrl) return;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    subscribe();
    return;
  }
  let sock;
  try { sock = new WebSocket(wantUrl); }
  catch (e) { post({ type: 'alive-status', state: 'error', error: String(e) }); return; }
  ws = sock;
  post({ type: 'alive-status', state: 'connecting' });

  sock.onopen = () => { post({ type: 'alive-status', state: 'open' }); subscribe(); };
  sock.onmessage = (e) => {
    const text = String(e.data);
    if (text.includes('"ack"')) { post({ type: 'alive-status', state: 'ack', sample: text.slice(0, 200) }); return; }
    post({ type: 'alive-message', data: text.slice(0, 4000) });
  };
  sock.onclose = (e) => {
    if (ws === sock) ws = null;
    post({ type: 'alive-status', state: 'closed', code: e.code, reason: e.reason });
  };
  sock.onerror = () => post({ type: 'alive-status', state: 'error' });
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.target !== 'alive-relay') return;
  if (msg.type === 'connect') { connect(msg.url, msg.tokens); sendResponse({ ok: true }); }
  if (msg.type === 'ping') sendResponse({ ok: true, readyState: ws?.readyState ?? null, tokens: tokens.length });
  if (msg.type === 'close') { try { ws?.close(); } catch {} ws = null; sendResponse({ ok: true }); }
  return true;
});

// 読み込まれたことを知らせる。background が socket URL とトークンを送ってくる。
post({ type: 'alive-ready', href: location.href });
