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
//
// 二重注入の防止: manifest の content_scripts に加えて background が
// chrome.scripting.executeScript で入れ直すことがある (拡張更新直後など)。
// 同じ isolated world に 2 つ目が入ると、ダッシュボードが話す instance と
// socket を持つ instance が食い違う (#25 の 3)。先頭でグローバルの印を見て 2 回目は何もしない。
(() => {
  if (globalThis.__ghAliveRelay) return;
  const relay = globalThis.__ghAliveRelay = { instance: Math.random().toString(36).slice(2, 8), loadedAt: Date.now() };

  // 握手 (CONNECTING) がこれ以上続いたら諦めて閉じ、error として報告する。
  // onopen も onclose も来ないまま固まると誰も再接続しないため (#25 の 1)。
  const HANDSHAKE_MS = 15000;

  let ws = null;
  let wantUrl = '';
  let tokens = [];
  let connectingSince = 0;
  let handshakeTimer = null;
  // 最後に **フレームを受け取った** 時刻 (ack も push も込み)。socket ごとにリセットする。
  // readyState が OPEN でも half-open (TCP が静かに死ぬ) だと send は通るのに何も返ってこない。
  // 「生きているか」を言えるのはこれだけなので、diag と ack の報告に載せてダッシュボード側の
  // idle watchdog の材料にする (#28)
  let lastFrameAt = 0;
  let frames = 0;

  function post(msg) { try { chrome.runtime.sendMessage({ target: 'background', instance: relay.instance, ...msg }); } catch {} }

  function subscribe() {
    if (ws?.readyState !== WebSocket.OPEN || !tokens.length) return;
    const subscribe = {};
    for (const t of tokens) subscribe[t] = null;
    ws.send(JSON.stringify({ subscribe }));
    post({ type: 'alive-status', state: 'subscribed', count: tokens.length });
  }

  // 自分で閉じる。onclose には byUs を付けて報告し、ダッシュボード側が
  // 「切断 = 失敗」としてバックオフを積まないようにする。
  function closeSocket(reason) {
    clearTimeout(handshakeTimer); handshakeTimer = null;
    const sock = ws;
    ws = null;
    if (!sock) return false;
    sock.__byUs = reason || 'close';
    try { sock.close(); } catch {}
    return true;
  }

  function connect(url, newTokens) {
    if (Array.isArray(newTokens) && newTokens.length) tokens = newTokens;
    if (url) wantUrl = url;
    if (!wantUrl) { post({ type: 'alive-status', state: 'error', error: 'no socket url' }); return; }

    if (ws?.readyState === WebSocket.OPEN) { subscribe(); return; }
    if (ws?.readyState === WebSocket.CONNECTING) {
      // 黙って return しない。今の状態を返してダッシュボードの watchdog に判断させる
      post({ type: 'alive-status', state: 'connecting', readyState: ws.readyState, sinceMs: Date.now() - connectingSince });
      return;
    }
    // CLOSING / CLOSED の残骸があれば捨てる
    closeSocket('stale');

    let sock;
    try { sock = new WebSocket(wantUrl); }
    catch (e) { post({ type: 'alive-status', state: 'error', error: String(e) }); return; }
    ws = sock;
    connectingSince = Date.now();
    lastFrameAt = 0; frames = 0;
    post({ type: 'alive-status', state: 'connecting', readyState: sock.readyState, sinceMs: 0 });

    clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (ws !== sock || sock.readyState !== WebSocket.CONNECTING) return;
      post({ type: 'alive-status', state: 'error', error: `handshake timeout ${HANDSHAKE_MS / 1000}s` });
      closeSocket('handshake-timeout');
    }, HANDSHAKE_MS);

    sock.onopen = () => {
      clearTimeout(handshakeTimer); handshakeTimer = null;
      post({ type: 'alive-status', state: 'open' });
      subscribe();
    };
    sock.onmessage = (e) => {
      const text = String(e.data);
      lastFrameAt = Date.now(); frames++;
      if (text.includes('"ack"')) { post({ type: 'alive-status', state: 'ack', sample: text.slice(0, 200), lastFrameAt, frames }); return; }
      post({ type: 'alive-message', data: text.slice(0, 4000), lastFrameAt, frames });
    };
    sock.onclose = (e) => {
      // 既に **別の socket に置き換わった後**に届いた後片付け。close() を頼んでから
      // onclose が来るまでは数秒あり、その間に張り直しが成功していることがある (実機で 2.2s)。
      // これを「今の状態」として報告すると、ダッシュボードが接続済みを未接続で上書きして
      // OPEN のまま固まる (#28 の実機検証で発生)。stale を付けて区別する
      const stale = ws !== sock && ws != null;
      if (ws === sock) { ws = null; clearTimeout(handshakeTimer); handshakeTimer = null; }
      post({ type: 'alive-status', state: 'closed', code: e.code, reason: e.reason, byUs: sock.__byUs || null, stale });
    };
    sock.onerror = () => { if (ws === sock) post({ type: 'alive-status', state: 'error' }); };
  }

  function diag() {
    return {
      ok: true,
      instance: relay.instance,
      readyState: ws?.readyState ?? null,
      tokens: tokens.length,
      hasUrl: !!wantUrl,
      connectingMs: ws?.readyState === WebSocket.CONNECTING ? Date.now() - connectingSince : null,
      lastFrameAt: lastFrameAt || null,
      sinceLastFrameMs: lastFrameAt ? Date.now() - lastFrameAt : null,
      frames,
      handshakeTimer: !!handshakeTimer,
      href: location.href
    };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.target !== 'alive-relay') return;
    if (msg.type === 'connect') { connect(msg.url, msg.tokens); sendResponse(diag()); }
    else if (msg.type === 'ping') sendResponse(diag());
    else if (msg.type === 'close') { const had = closeSocket(msg.reason || 'close'); sendResponse({ ...diag(), closed: had }); }
    else sendResponse({ ok: false, error: 'unknown type: ' + msg.type });
    return true;
  });

  // 読み込まれたことを知らせる。background が socket URL とトークンを送ってくる。
  post({ type: 'alive-ready', href: location.href });
})();
