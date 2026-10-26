// 設定の外部ソースを chrome.storage に取り込む。2 か所あり、この順に読む:
//   1. 自分のフォルダの config.json (インストーラーが書く。その PC だけの値)
//   2. GitHub の private repo の config.json (全 PC 共通の正本。他の PC からも見える / 直せる)
// どちらも内容のハッシュを覚えておき、変わったときだけ上書きする。
// なので設定画面や bridge の set-config で入れた値は、ソース側が次に変わるまで残る。
// 拡張を入れ直して chrome.storage が消えても、ソースが残っていれば設定が戻る。

// repo 側の置き場。config.json / set-config の configRepo で差し替えられる
export const DEFAULT_CONFIG_REPO = 'ippoan/gh-actions-live-config';

export async function applySeedConfig(log = () => {}) {
  const local = await applyLocalConfig(log);
  const remote = await applyRepoConfig(log);
  return local || remote ? { ...local, ...remote } : null;
}

// unpacked 拡張は chrome.runtime.getURL('config.json') で自分のフォルダのファイルが読める
async function applyLocalConfig(log) {
  let text;
  try {
    const r = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' });
    if (!r.ok) return null;
    text = await r.text();
  } catch { return null; }           // 無ければ何もしない (zip 展開の手動導入など)
  return applyText(text, 'configSeedHash', 'config.json', log);
}

// github.com のログイン cookie で raw を取る (PAT 不要)。private repo の raw は
// raw.githubusercontent.com の ?token= 付き URL へリダイレクトされる (manifest の host_permissions に要る)。
// 取れた / 取れなかったは remoteConfigStatus に残す (get-config と設定画面で見える)
async function applyRepoConfig(log) {
  const { configRepo } = await chrome.storage.local.get('configRepo');
  const repo = configRepo || DEFAULT_CONFIG_REPO;
  const status = { repo, at: new Date().toISOString() };
  try {
    const r = await fetch(`https://github.com/${repo}/raw/HEAD/config.json`, { cache: 'no-store', credentials: 'include' });
    // 404 は「repo が無い」か「github.com に未ログイン (private が見えない)」
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    status.ok = true;
    status.hash = (await sha256(text)).slice(0, 12);
    const patch = await applyText(text, 'remoteConfigHash', repo, log);
    if (patch === false) { status.ok = false; status.error = 'JSON でない'; }
    await chrome.storage.local.set({ remoteConfigStatus: status });
    return patch || null;
  } catch (e) {
    status.ok = false;
    status.error = String(e?.message || e);
    await chrome.storage.local.set({ remoteConfigStatus: status });
    return null;
  }
}

// 変わっていなければ null、JSON でなければ false、取り込んだら patch
async function applyText(text, hashKey, source, log) {
  let cfg; try { cfg = JSON.parse(text); } catch { log(`${source} が JSON でない`); return false; }
  const hash = await sha256(text);
  const { [hashKey]: prev } = await chrome.storage.local.get(hashKey);
  if (prev === hash) return null;

  const patch = { [hashKey]: hash, ...configPatch(cfg) };
  await chrome.storage.local.set(patch);
  log(`${source} を取り込んだ`, patch);
  return patch;
}

// set-config と同じ形に揃える (知らないキーは捨てる)
export function configPatch(cfg) {
  const patch = {};
  if (Array.isArray(cfg.repos)) patch.repos = cfg.repos.map(String).filter(Boolean);
  if (typeof cfg.bridgeUrl === 'string') patch.bridgeUrl = cfg.bridgeUrl.trim();
  if (typeof cfg.notify === 'boolean') patch.notify = cfg.notify;
  if (Array.isArray(cfg.accessLoginHosts)) {
    patch.accessLoginHosts = cfg.accessLoginHosts.map(h => String(h).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof cfg.configRepo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(cfg.configRepo.trim())) {
    patch.configRepo = cfg.configRepo.trim();
  }
  return patch;
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
