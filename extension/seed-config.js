// 自分のフォルダの config.json (インストーラーが書く) を設定に取り込む。
// unpacked 拡張は chrome.runtime.getURL('config.json') で自分のフォルダのファイルが読める。
// 内容のハッシュを覚えておき、変わったとき (= msiexec で渡し直したとき) だけ上書きする。
// 拡張を入れ直して chrome.storage が消えても、config.json が残っていれば設定が戻る。
export async function applySeedConfig(log = () => {}) {
  let text;
  try {
    const r = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' });
    if (!r.ok) return null;
    text = await r.text();
  } catch { return null; }           // 無ければ何もしない (zip 展開の手動導入など)
  let cfg; try { cfg = JSON.parse(text); } catch { log('config.json が JSON でない'); return null; }

  const hash = await sha256(text);
  const { configSeedHash } = await chrome.storage.local.get('configSeedHash');
  if (configSeedHash === hash) return null;

  const patch = { configSeedHash: hash };
  if (Array.isArray(cfg.repos)) patch.repos = cfg.repos.map(String).filter(Boolean);
  if (typeof cfg.bridgeUrl === 'string') patch.bridgeUrl = cfg.bridgeUrl.trim();
  if (typeof cfg.notify === 'boolean') patch.notify = cfg.notify;
  await chrome.storage.local.set(patch);
  log('config.json を取り込んだ', patch);
  return patch;
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
