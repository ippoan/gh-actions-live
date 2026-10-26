// seed-config.js: インストーラーの config.json と GitHub の private repo の config.json を
// chrome.storage に取り込む。他の PC で設定が空のまま (0 repos / bridge 未設定) になるのを
// repo 側の正本で埋めるのが目的。変わったときだけ上書きする (手で入れた値を毎回潰さない)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySeedConfig, configPatch, DEFAULT_CONFIG_REPO } from '../extension/seed-config.js';

function setup({ local = null, remote = null, stored = {} } = {}) {
  const store = { ...stored };
  const fetched = [];
  globalThis.chrome = {
    runtime: { getURL: p => `chrome-extension://x/${p}` },
    storage: { local: {
      get: async keys => {
        const ks = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(ks.filter(k => k in store).map(k => [k, store[k]]));
      },
      set: async patch => { Object.assign(store, patch); },
    } },
  };
  globalThis.fetch = async (url, opts) => {
    fetched.push({ url, opts });
    const body = String(url).startsWith('chrome-extension://') ? local : remote;
    if (body == null) return { ok: false, status: 404, text: async () => '' };
    if (typeof body === 'number') return { ok: false, status: body, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  return { store, fetched };
}

test('repo の config.json を github.com の cookie 付きで取り込む', async () => {
  const { store, fetched } = setup({ remote: JSON.stringify({ repos: ['o/a', 'o/b'], bridgeUrl: ' ws://h:8799 ' }) });
  await applySeedConfig();
  const r = fetched.find(f => f.url.startsWith('https://github.com/'));
  assert.equal(r.url, `https://github.com/${DEFAULT_CONFIG_REPO}/raw/HEAD/config.json`);
  assert.equal(r.opts.credentials, 'include');
  assert.deepEqual(store.repos, ['o/a', 'o/b']);
  assert.equal(store.bridgeUrl, 'ws://h:8799');
  assert.equal(store.remoteConfigStatus.ok, true);
  assert.equal(store.remoteConfigStatus.repo, DEFAULT_CONFIG_REPO);
});

test('repo 側が変わっていなければ手で入れた値を潰さない', async () => {
  const text = JSON.stringify({ repos: ['o/a'] });
  const { store } = setup({ remote: text });
  await applySeedConfig();
  store.repos = ['o/hand'];
  await applySeedConfig();
  assert.deepEqual(store.repos, ['o/hand']);
});

test('repo 側が変わったら上書きする', async () => {
  const { store } = setup({ remote: JSON.stringify({ repos: ['o/a'] }) });
  await applySeedConfig();
  store.repos = ['o/hand'];
  const next = setup({ remote: JSON.stringify({ repos: ['o/b'] }), stored: store }).store;
  await applySeedConfig();
  assert.deepEqual(next.repos, ['o/b']);
});

test('取れないとき (未ログイン / repo 無し) は何も変えず理由を残す', async () => {
  const { store } = setup({ remote: 404, stored: { repos: ['o/keep'] } });
  assert.equal(await applySeedConfig(), null);
  assert.deepEqual(store.repos, ['o/keep']);
  assert.equal(store.remoteConfigStatus.ok, false);
  assert.match(store.remoteConfigStatus.error, /404/);
});

test('JSON でなければ取り込まず失敗として残す', async () => {
  const { store } = setup({ remote: '<html>login</html>' });
  await applySeedConfig();
  assert.equal(store.repos, undefined);
  assert.equal(store.remoteConfigStatus.ok, false);
});

test('インストーラーの config.json の後に repo を読む (両方変われば repo が勝つ)', async () => {
  const { store } = setup({ local: JSON.stringify({ repos: ['o/local'], notify: true }), remote: JSON.stringify({ repos: ['o/remote'] }) });
  await applySeedConfig();
  assert.deepEqual(store.repos, ['o/remote']);
  assert.equal(store.notify, true);
});

test('configRepo を差し替えるとそちらを読む', async () => {
  const { fetched } = setup({ stored: { configRepo: 'me/cfg' } });
  await applySeedConfig();
  assert.ok(fetched.some(f => f.url === 'https://github.com/me/cfg/raw/HEAD/config.json'));
});

test('configPatch: 知らないキー・形の違う値は捨てる', () => {
  assert.deepEqual(configPatch({ repos: ['o/a', ''], notify: 'yes', evil: 1, accessLoginHosts: [' A.example.com '],
                                 configRepo: 'https://evil/x' }),
                   { repos: ['o/a'], accessLoginHosts: ['a.example.com'] });
  assert.deepEqual(configPatch({ configRepo: 'me/cfg' }), { configRepo: 'me/cfg' });
});
