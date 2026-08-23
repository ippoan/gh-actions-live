// alive socket の「繋がっているか / 繋ぎ直すか」だけを持つ状態機械。ダッシュボードから使う。
//
// 背景 (#25): 再接続は relay から `closed` / `error` が届いたときだけ起動していたので、
//   1. 握手が CONNECTING のまま固まる
//   2. 切断イベントが来た瞬間にダッシュボードが居なかった (reload 中など)
//   3. content script の多重注入で socket を持つ instance と話す instance が食い違う
// のどれかに入ると、誰も再接続せず connected:false, fails:0 のまま 20 分 poll 頼みになった。
//
// ここでは **こちらから connect を頼んだら必ず watchdog を張る**。N 秒以内に
// open / subscribed / ack が来なければ失敗扱いにして、relay に close を送ってから
// バックオフ付きで張り直す。boot 時は未接続なら無条件で close → connect。
//
// もう 1 つ (#28): **繋がった後**の見張り。socket が half-open (TCP が静かに死ぬ) になると
// readyState は OPEN のままで onclose も onerror も来ない。`ws.send()` も例外を投げないので
// 20 分ごとの boot → 購読し直しは「送れた = 生きている」と誤判定する。
// 生きている証拠になるのはフレームを受け取ったことだけなので、`onMessage()` で
// `lastMessageAt` を更新し、接続中なのに idleLimitMs を超えて何も来なければ reset('idle') する。
// 張り直しは close → connect なので、half-open でも「本当に繋がるか」を確かめられる。
//
// 依存 (connect / close / boot / タイマー) は全部注入するので Node の単体テストで回せる。
export function createAliveWatchdog({
  connect,                       // () => void | Promise   relay に connect を頼む (socket URL とトークンを渡す)
  close,                         // () => void | Promise   relay に close を頼む
  boot = () => {},               // () => void | Promise   ページを取り直してトークンを更新 (5 回に 1 回)
  handshakeMs = 20000,           // connect 後これ以内に open/subscribed/ack が来なければ失敗
  idleLimitMs = 10 * 60000,      // 接続中にこれだけ何も受け取らなければ死んだ扱いで張り直す (0 で無効)
  baseBackoff = 4000,
  maxBackoff = 5 * 60000,
  bootEvery = 5,
  setTimeout = globalThis.setTimeout.bind(globalThis),
  clearTimeout = globalThis.clearTimeout.bind(globalThis),
  now = () => Date.now(),
  log = () => {},
  onChange = () => {}
} = {}) {
  const st = {
    connected: false,
    fails: 0,                    // 連続失敗回数 (接続できたら 0 に戻る)
    backoff: baseBackoff,        // 次に待つ ms
    note: '',
    lastState: null, lastStateAt: null,
    lastConnectAt: null,
    lastMessageAt: null,         // 最後にフレーム (push / ack) を受け取った時刻
    idleResets: 0,               // idle 判定で張り直した回数
    watchdogArmed: false,
    idleArmed: false,
    reconnectPending: false,
    nextRetryAt: null
  };
  let watchTimer = null, reconnTimer = null, idleTimer = null;

  const changed = () => { try { onChange(st); } catch {} };
  const safe = (fn, label) => { try { const r = fn?.(); if (r?.catch) r.catch(e => log(label, String(e))); } catch (e) { log(label, String(e)); } };

  function disarm() { clearTimeout(watchTimer); watchTimer = null; st.watchdogArmed = false; }
  function clearIdle() { clearTimeout(idleTimer); idleTimer = null; st.idleArmed = false; }

  // 接続中のあいだだけ張る。最後の受信から idleLimitMs で発火し、まだ idle でなければ残り時間で張り直す
  function armIdle() {
    clearIdle();
    if (!idleLimitMs || !st.connected) return;
    const base = st.lastMessageAt ?? now();
    const wait = Math.max(1000, base + idleLimitMs - now());
    st.idleArmed = true;
    idleTimer = setTimeout(() => {
      idleTimer = null; st.idleArmed = false;
      if (!st.connected) return;
      const idle = now() - (st.lastMessageAt ?? now());
      if (idle < idleLimitMs) { armIdle(); return; }
      // OPEN のまま何も来ない = half-open の疑い。send では確かめられないので張り直して確認する
      st.idleResets++;
      log('alive idle:', `${Math.round(idle / 1000)}s 無受信 → 張り直し (#${st.idleResets})`);
      reset('idle');
      st.note = `無受信 ${Math.round(idle / 1000)}s → 再接続`;
      changed();
    }, wait);
  }
  function cancelReconnect() { clearTimeout(reconnTimer); reconnTimer = null; st.reconnectPending = false; st.nextRetryAt = null; }

  function arm() {
    clearTimeout(watchTimer);
    st.watchdogArmed = true;
    watchTimer = setTimeout(() => {
      watchTimer = null; st.watchdogArmed = false;
      if (st.connected) return;
      fail(`応答なし ${handshakeMs / 1000}s (watchdog)`);
    }, handshakeMs);
  }

  // connect を頼み、watchdog を張る
  function request(reason = 'request') {
    st.lastConnectAt = now();
    log('alive connect:', reason);
    arm();                       // connect が同期的に失敗 (onConnectError) しても fail() が disarm できるよう先に張る
    safe(connect, 'connect');
    changed();
  }

  // 失敗。既に再接続が予約済みなら二重に積まない (error と closed が連続で来ることがある)
  function fail(note) {
    st.connected = false;
    st.note = note;
    disarm(); clearIdle();
    if (reconnTimer) { changed(); return; }
    st.fails++;
    const wait = st.backoff;
    st.backoff = Math.min(st.backoff * 2, maxBackoff);
    st.reconnectPending = true;
    st.nextRetryAt = now() + wait;
    log('alive fail:', note, `retry in ${wait}ms (#${st.fails})`);
    reconnTimer = setTimeout(() => {
      reconnTimer = null; st.reconnectPending = false; st.nextRetryAt = null;
      safe(close, 'close');
      if (st.fails % bootEvery === 0) safe(boot, 'boot');   // boot が onBoot() → request() を呼ぶ
      else request(`retry #${st.fails}`);
    }, wait);
    changed();
  }

  // relay からの alive-status
  function onStatus(msg = {}) {
    // 置き換わった後の古い socket の onclose。今の接続とは無関係なので状態を触らない。
    // (張り直しの close → connect が成功した後に前の socket の close が届くと、
    //  connected:true を false で上書きして誰も再接続しないまま固まる)
    if (msg.state === 'closed' && msg.stale) { log('alive: 古い socket の close を無視', msg.code ?? ''); return; }
    st.lastState = msg.state; st.lastStateAt = now();
    if (msg.state === 'open' || msg.state === 'subscribed' || msg.state === 'ack') {
      st.connected = true; st.note = '';
      st.fails = 0; st.backoff = baseBackoff;
      // ack は alive からのフレームそのもの。open/subscribed は自分側の出来事だが、
      // 繋ぎ直した直後に idle 判定が走らないよう起点として同じく now を入れる
      st.lastMessageAt = now();
      disarm(); cancelReconnect(); armIdle();
    } else if (msg.state === 'closed' && msg.byUs) {
      // 自分 (watchdog / reset / 握手タイムアウト) が閉じた。続きの connect は呼び出し側が行う
      st.connected = false; clearIdle();
      if (!st.note) st.note = `切断 (${msg.byUs})`;
    } else if (msg.state === 'closed' || msg.state === 'error') {
      // code 無しの closed は background からの「タブが消えた」(#36)。reason (tab-closed / tab-gone) を note に出す
      fail(msg.state === 'closed' ? `切断 ${msg.code ?? msg.reason ?? ''}`.trim() : (msg.error || 'error'));
      return;
    } else if (msg.state === 'connecting') {
      st.connected = false;
      st.note = msg.sinceMs > 0 ? `接続中… ${Math.round(msg.sinceMs / 1000)}s` : '接続中…';
      if (!watchTimer && !reconnTimer) arm();   // relay 側が CONNECTING で固まっていても見張る
    }
    changed();
  }

  // relay からの alive-message (GitHub の push 本体)。**生きている唯一の証拠**なので
  // ここで idle を巻き戻す。alive-status の ack も onStatus 側で同じ扱い
  function onMessage() {
    st.lastMessageAt = now();
    if (st.connected) armIdle();
  }

  // connect の送信自体が失敗した (github.com のタブが無い / content script が応答しない 等)
  function onConnectError(error) { fail(String(error || 'タブに接続できない')); }

  // 強制的に張り直す (bridge の alive-reset / ユーザー操作)。バックオフもリセット
  function reset(reason = 'reset') {
    disarm(); cancelReconnect(); clearIdle();
    st.fails = 0; st.backoff = baseBackoff; st.connected = false; st.note = '';
    safe(close, 'close');
    request(reason);
  }

  // boot (ページ取り直し) の最後に呼ぶ。接続済みなら新しいトークンで購読し直すだけ。
  // 未接続なら無条件で close → connect (CONNECTING で固まった relay もここで叩き直す)
  function onBoot() {
    if (st.connected) { safe(connect, 'connect'); changed(); return; }
    disarm(); cancelReconnect();
    safe(close, 'close');
    request('boot');
  }

  // 接続済みなら購読し直し (トークン更新)。未接続で何も予約が無ければ張る。予約があれば任せる
  function ensure() {
    if (st.connected) { safe(connect, 'connect'); return; }
    if (!watchTimer && !reconnTimer) request('ensure');
  }

  function snapshot() {
    return { ...st, nowMs: now(),
             idleMs: st.lastMessageAt != null ? now() - st.lastMessageAt : null,
             idleLimitMs };
  }

  return { state: st, onStatus, onMessage, onConnectError, onBoot, ensure, reset, snapshot,
           get armed() { return !!watchTimer; }, get pending() { return !!reconnTimer; },
           get idlePending() { return !!idleTimer; } };
}
