// Linux 側のリレー (bridge/ws-bridge.mjs) への WebSocket クライアント。
// background (service worker) と dashboard (ウィンドウ) の両方から使う。
//
// - 切れたら指数バックオフで張り直す (最大 30 秒)
// - サーバーの {"type":"ping"} には {"type":"pong"} を返す。MV3 の service worker は
//   WebSocket の往来が 30 秒以内にあれば生き続けるので、これが keepalive になる
// - {"type":"command", command:"..."} を受けたら onCommand に渡す
//
// 拡張ページ (chrome-extension://) は mixed content の制限対象外なので ws:// を張れる。
// WebSocket は host_permissions も不要。
export function createBridge({ role, getUrl, onCommand, onStatus, log = () => {} }) {
  let ws = null, timer = null, backoff = 1000, wantUrl = '', closedByUs = false;

  const status = (s, note = '') => { try { onStatus?.(s, note); } catch {} };

  function send(obj) {
    if (ws?.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(obj)); return true; } catch {} }
    return false;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }

  async function connect() {
    clearTimeout(timer);
    const url = (await getUrl()) || '';
    if (!url) { wantUrl = ''; if (ws) { closedByUs = true; ws.close(); ws = null; } status('off'); return; }
    if (ws && wantUrl === url && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (ws) { closedByUs = true; try { ws.close(); } catch {} }
    wantUrl = url;
    closedByUs = false;

    const u = new URL(url);
    u.searchParams.set('role', role);
    let sock;
    try { sock = new WebSocket(u.toString()); }
    catch (e) { status('error', String(e)); schedule(); return; }
    ws = sock;
    status('connecting');

    sock.onopen = () => { backoff = 1000; status('open'); log('bridge open', u.host); };
    sock.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'ping') { send({ type: 'pong', t: msg.t }); return; }
      if (msg.type === 'command') { try { onCommand?.(msg); } catch (err) { log('command failed', String(err)); } }
    };
    sock.onclose = (e) => {
      if (ws === sock) ws = null;
      status('closed', String(e.code));
      if (!closedByUs) schedule();
    };
    sock.onerror = () => { status('error'); };
  }

  return {
    send,
    connect,
    ensure: connect,
    get open() { return ws?.readyState === WebSocket.OPEN; },
    close() { closedByUs = true; clearTimeout(timer); try { ws?.close(); } catch {} ws = null; }
  };
}
