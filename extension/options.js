const $ = id => document.getElementById(id);

// 入力欄は「ユーザーが編集していない間」だけ storage の値で同期する。
// 以前は 5 秒ごとに全部読み直していたので、repo を 1 行消しても保存を押す前に
// 巻き戻り、「消しても復活する」ように見えていた。
let dirty = false;

async function loadSettings() {
  const s = await chrome.storage.local.get(['repos', 'notify', 'bridgeUrl']);
  $('bridgeUrl').value = s.bridgeUrl || '';
  $('repos').value = (s.repos || []).join('\n');
  $('notify').checked = s.notify === true;   // 既定オフ
  dirty = false;
}

// 全 PC 共通の設定 (GitHub の private repo の config.json) を最後に読みに行った結果。
// 中身を変えるときはその repo を直す (ここで保存した値は、repo 側が次に変わると上書きされる)
async function loadRemote() {
  const { configRepo, remoteConfigStatus: st } = await chrome.storage.local.get(['configRepo', 'remoteConfigStatus']);
  const repo = st?.repo || configRepo || 'ippoan/gh-actions-live-config';
  const el = $('remote');
  el.textContent = '共通設定: ';
  const a = document.createElement('a');
  a.href = `https://github.com/${repo}/blob/HEAD/config.json`;
  a.target = '_blank';
  a.textContent = repo;
  el.append(a, st
    ? (st.ok ? ` — 取得 OK (${st.hash}, ${new Date(st.at).toLocaleString()})`
             : ` — 取得失敗: ${st.error} (${new Date(st.at).toLocaleString()})。github.com にログインしているか確認`)
    : ' — まだ読みに行っていない');
}

async function loadSamples() {
  const { rawSamples } = await chrome.storage.local.get('rawSamples');
  $('raw').textContent = (rawSamples || []).slice(0, 5).join('\n\n') || '(まだ無し)';
}

for (const id of ['repos', 'notify', 'bridgeUrl'])
  for (const ev of ['input', 'change'])
    $(id).addEventListener(ev, () => { dirty = true; });

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    repos: $('repos').value.split('\n').map(s => s.trim()).filter(Boolean),
    notify: $('notify').checked,
    bridgeUrl: $('bridgeUrl').value.trim()
  });
  dirty = false;
  $('save').textContent = '保存しました';
  setTimeout(() => ($('save').textContent = '保存'), 1200);
});

// 外から変わったとき (bridge の set-config / インストーラーの config.json) は取り込む。
// ただし編集中は触らない — ユーザーの入力が正。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.rawSamples) loadSamples();
  if (changes.remoteConfigStatus || changes.configRepo) loadRemote();
  if ((changes.repos || changes.notify || changes.bridgeUrl) && !dirty) loadSettings();
});

document.querySelectorAll('button[data-mode]').forEach(b =>
  b.addEventListener('click', () =>
    chrome.runtime.sendMessage({ target: 'background', type: 'open-dashboard', mode: b.dataset.mode })));

loadSettings();
loadRemote();
loadSamples();
setInterval(loadSamples, 5000);   // サンプル欄だけの保険。入力欄には触らない
