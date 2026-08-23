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
  if ((changes.repos || changes.notify || changes.bridgeUrl) && !dirty) loadSettings();
});

document.querySelectorAll('button[data-mode]').forEach(b =>
  b.addEventListener('click', () =>
    chrome.runtime.sendMessage({ target: 'background', type: 'open-dashboard', mode: b.dataset.mode })));

loadSettings();
loadSamples();
setInterval(loadSamples, 5000);   // サンプル欄だけの保険。入力欄には触らない
