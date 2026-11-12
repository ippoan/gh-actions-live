#!/usr/bin/env node
// #62: 常駐の Chromium (CDP 127.0.0.1:9223) のプロファイルで「デベロッパー モード」をオンにする。chromium.sh が起動直後に呼ぶ。
//
// --load-extension で読んだ拡張は、chrome.runtime.reload() で読み直すと「パッケージ化されていない拡張」(UNPACKED) として
// 入り直す。デベロッパー モードがオフのプロファイルでは、そこで disable_reasons = DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION
// (1<<24) が付いて無効化され、service worker もダッシュボードも消えて bridge に戻らない
// (2026-11-12 実測: reload 後に chrome.developerPrivate.getExtensionsInfo が state DISABLED / unsupportedDeveloperExtension: true)。
// 起動時は --load-extension の分だけ例外扱いで有効になるので、壊れるのは reload したときだけ。
// コマンドラインのフラグでは変えられないので、chrome://extensions のページの chrome.developerPrivate で設定する
// (設定画面のトグルと同じ口。値は Preferences の extensions.ui.developer_mode に残る)。
// 既に無効化されていたら有効に戻す (この時点で直る)。
const CDP = 'http://127.0.0.1:9223';
const EXT_ID = 'oaadakmclelmnaieokjbhldfacfckaaj';   // chromium.sh の EXT_ID と同じ (manifest.json の key から決まる)

const ver = await (await fetch(`${CDP}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((ok, ng) => { ws.onopen = ok; ws.onerror = () => ng(new Error('CDP に繋がらない')); });
let n = 0;
const call = (method, params = {}, sessionId) => new Promise((ok, ng) => {
  const i = ++n;
  const h = e => { const m = JSON.parse(e.data); if (m.id === i) { ws.removeEventListener('message', h); m.error ? ng(new Error(m.error.message)) : ok(m.result); } };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});

const { targetId } = await call('Target.createTarget', { url: 'chrome://extensions' });
let code = 1;
try {
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  // chrome.developerPrivate が使えるようになるまで待つ
  const expr = `new Promise((ok, ng) => {
    const dp = chrome.developerPrivate, id = ${JSON.stringify(EXT_ID)};
    const err = () => chrome.runtime.lastError && chrome.runtime.lastError.message;
    dp.updateProfileConfiguration({ inDeveloperMode: true }, () => {
      if (err()) return ng(new Error(err()));
      dp.getExtensionInfo(id, info => {
        if (err() || !info) return ok('developer_mode=on / 拡張が見つからない: ' + (err() || id));
        if (info.state === 'ENABLED') return ok('developer_mode=on / 拡張 ENABLED');
        chrome.management.setEnabled(id, true, () => ok('developer_mode=on / 拡張 ' + info.state + ' -> 有効に戻した' + (err() ? ' (失敗: ' + err() + ')' : '')));
      });
    });
  })`;
  for (let i = 0; i < 20; i++) {
    const r = await call('Runtime.evaluate', { expression: `typeof chrome?.developerPrivate?.updateProfileConfiguration`, returnByValue: true }, sessionId);
    if (r.result?.value === 'function') break;
    await new Promise(r => setTimeout(r, 250));
  }
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  console.log(`[gh-actions-browser] ${r.result.value}`);
  code = 0;
} catch (e) {
  console.error(`[gh-actions-browser] デベロッパー モードをオンにできなかった (reload すると拡張が無効化される): ${e.message}`);
} finally {
  await call('Target.closeTarget', { targetId }).catch(() => {});
  ws.close();
}
process.exit(code);
