#!/usr/bin/env node
// #62: 常駐の headless Chromium (CDP 127.0.0.1:9223) の GitHub を、このブラウザだけサインアウトする。
// 他の端末 (Windows の Chrome 等) のセッションには触らない。
const CDP = 'http://127.0.0.1:9223';
const list = await (await fetch(`${CDP}/json/list`)).json();
const t = list.find(t => t.type === 'page' && t.url.startsWith('https://github.com')) || list.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
if (!t) { console.error('github.com のタブが無い'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((ok, ng) => { ws.onopen = ok; ws.onerror = () => ng(new Error('CDP に繋がらない')); });
let n = 0;
const call = (method, params = {}) => new Promise((ok, ng) => {
  const i = ++n;
  const h = e => { const m = JSON.parse(e.data); if (m.id === i) { ws.removeEventListener('message', h); m.error ? ng(new Error(m.error.message)) : ok(m.result); } };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async expr => (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const login = () => ev(`document.querySelector('meta[name=user-login]')?.content || ''`);

await call('Page.navigate', { url: 'https://github.com/' });
await sleep(2500);
if (!(await login())) { console.log('既にサインアウト済み'); ws.close(); process.exit(0); }
await call('Page.navigate', { url: 'https://github.com/logout' });
await sleep(2500);
// /logout の確認画面の「Sign out」(このブラウザだけ) を押す
const r = await ev(`(() => {
  const b = [...document.querySelectorAll('form[action="/logout"] [type=submit], form[action="/logout"] button')][0];
  if (!b) return 'サインアウトのボタンが見つからない: ' + location.href;
  b.click(); return 'ok';
})()`);
if (r !== 'ok') { console.error(r); ws.close(); process.exit(1); }
await sleep(3000);
await call('Page.navigate', { url: 'https://github.com/' });
await sleep(2500);
const who = await login();
console.log(who ? `まだログイン中: ${who}` : 'サインアウトした (このブラウザだけ)');
ws.close();
process.exit(who ? 1 : 0);
