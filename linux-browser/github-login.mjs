#!/usr/bin/env node
// #62: 常駐の headless Chromium (CDP 127.0.0.1:9223) に GitHub のログインを入れ直す。
// パスワードは標準入力から受ける (端末なら github-login.sh が伏せ字で聞く。Windows からは
//   Get-Clipboard | ssh <user>@<host> <clone>/linux-browser/github-login.sh
// で流し込める)。2FA は GitHub Mobile を選び、アプリに出す数字を表示して承認を待つ。値はどこにも書かない。
// --check: ログイン済みなら名前を出して 0、未ログインなら 2 で終わる (パスワードは読まない)
const CHECK = process.argv[2] === '--check';
// ユーザー名は引数か GITHUB_USER (github-login.sh が ~/.config/gh-actions-live/browser.env から読む)
const USER = (!CHECK && process.argv[2]) || process.env.GITHUB_USER || '';
const CDP = 'http://127.0.0.1:9223';

const pass = CHECK ? '' : await new Promise(ok => { let b = ''; process.stdin.on('data', c => b += c); process.stdin.on('end', () => ok(b.replace(/\r?\n$/, ''))); });

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
const done = code => { ws.close(); process.exit(code); };

if (await login()) { console.log(`既にログイン済み: ${await login()}`); done(0); }
if (CHECK) done(2);
if (!USER) { console.error('GitHub のユーザー名が無い (引数か ~/.config/gh-actions-live/browser.env の GITHUB_USER)'); done(1); }
if (!pass) { console.error('パスワードが空'); done(1); }

await call('Page.navigate', { url: 'https://github.com/login' });
await sleep(2500);
const r = await ev(`(() => {
  const set = (s, v) => { const e = document.querySelector(s); if (!e) return false; e.focus(); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); return true; };
  if (!set('#login_field', ${JSON.stringify(USER)}) || !set('#password', ${JSON.stringify(pass)})) return 'ログイン画面の欄が見つからない: ' + location.href;
  const b = document.querySelector('input[type=submit][name=commit]');
  b ? b.click() : document.querySelector('#password').form.requestSubmit();
  return 'ok';
})()`);
if (r !== 'ok') { console.error(r); done(1); }
await sleep(3000);

let url = await ev('location.href');
if (url.includes('/sessions/two-factor') && !url.includes('/mobile')) {
  await ev(`[...document.querySelectorAll('a')].find(a => a.getAttribute('href') === '/sessions/two-factor/mobile')?.click()`);
  await sleep(3000);
  url = await ev('location.href');
}
if (url.includes('/sessions/two-factor/mobile')) {
  // 数字は JS で後から描かれるので、出るまで最大 10 秒読み直す
  let digits = '';
  for (let i = 0; i < 20 && !digits; i++) {
    digits = await ev(`(document.querySelector('main, .auth-form')?.innerText.match(/\\b(\\d{2,3})\\b/) || [])[1] || ''`);
    if (!digits) await sleep(500);
  }
  console.log(digits
    ? `GitHub Mobile に承認依頼を送った。アプリで ${digits} を選んで承認してください。待っています…`
    : 'GitHub Mobile に承認依頼を送った。アプリで承認してください (数字を聞かれない形の依頼)。待っています…');
}
for (let i = 0; i < 90; i++) {
  const who = await login();
  if (who) { console.log(`ログイン済み: ${who}`); done(0); }
  await sleep(2000);
}
console.error(`時間切れ。今の画面: ${await ev('location.href')}`);
done(1);
