const $ = id => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get(['repos', 'notify', 'rawSamples']);
  $('repos').value = (s.repos || []).join('\n');
  $('notify').checked = s.notify === true;   // 既定オフ
  $('raw').textContent = (s.rawSamples || []).slice(0, 5).join('\n\n') || '(まだ無し)';
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    repos: $('repos').value.split('\n').map(s => s.trim()).filter(Boolean),
    notify: $('notify').checked
  });
  $('save').textContent = '保存しました';
  setTimeout(() => ($('save').textContent = '保存'), 1200);
});

document.querySelectorAll('button[data-mode]').forEach(b =>
  b.addEventListener('click', () =>
    chrome.runtime.sendMessage({ target: 'background', type: 'open-dashboard', mode: b.dataset.mode })));

load();
setInterval(load, 5000);
