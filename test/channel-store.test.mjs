// repo ごとの購読トークン管理 (extension/channel-store.js) の単体テスト。
// dashboard.js の ingestChannels の置き換えロジックを切り出した純粋関数 (Refs ippoan/alc-app-s3#135)
import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceRepoChannels, mergeRepoChannels, dropReposNotIn, allTokens, repoForTopic } from '../extension/channel-store.js';

test('replaceRepoChannels: repo の分を作り直すので古いトピックは消える', () => {
  const store = new Map();
  replaceRepoChannels(store, 'o/r1', [['check_suites:1', 'tok-1'], ['check_suites:2', 'tok-2']]);
  assert.deepEqual([...allTokens(store).keys()].sort(), ['check_suites:1', 'check_suites:2']);
  // run 2 が終わって Actions ページから消えた。run 3 が新しく出た
  replaceRepoChannels(store, 'o/r1', [['check_suites:1', 'tok-1'], ['check_suites:3', 'tok-3']]);
  assert.deepEqual([...allTokens(store).keys()].sort(), ['check_suites:1', 'check_suites:3']);
});

test('replaceRepoChannels: 別 repo の分は残る', () => {
  const store = new Map();
  replaceRepoChannels(store, 'o/r1', [['check_suites:1', 'tok-1']]);
  replaceRepoChannels(store, 'o/r2', [['check_suites:9', 'tok-9']]);
  replaceRepoChannels(store, 'o/r1', [['check_suites:2', 'tok-2']]);   // r1 だけ作り直す
  assert.deepEqual([...allTokens(store).keys()].sort(), ['check_suites:2', 'check_suites:9']);
  assert.equal(repoForTopic(store, 'check_suites:9'), 'o/r2');
  assert.equal(repoForTopic(store, 'check_suites:1'), null);           // r1 から消えた
});

test('dropReposNotIn: 一覧から外れた repo の分が捨てられる', () => {
  const store = new Map();
  replaceRepoChannels(store, 'o/r1', [['check_suites:1', 'tok-1']]);
  replaceRepoChannels(store, 'o/r2', [['check_suites:2', 'tok-2']]);
  replaceRepoChannels(store, 'o/r3', [['check_suites:3', 'tok-3']]);
  dropReposNotIn(store, ['o/r1', 'o/r3']);   // set-config で o/r2 を外した
  assert.deepEqual([...allTokens(store).keys()].sort(), ['check_suites:1', 'check_suites:3']);
  assert.equal(repoForTopic(store, 'check_suites:2'), null);
});

test('mergeRepoChannels: 既存の分は消さずに足すだけ (partial 読み込み用)', () => {
  const store = new Map();
  replaceRepoChannels(store, 'o/r1', [['check_suites:1', 'tok-1'], ['check_suites:2', 'tok-2']]);
  mergeRepoChannels(store, 'o/r1', [['check_suites:2', 'tok-2-new'], ['check_suites:3', 'tok-3']]);
  const merged = allTokens(store);
  assert.deepEqual([...merged.keys()].sort(), ['check_suites:1', 'check_suites:2', 'check_suites:3']);
  assert.equal(merged.get('check_suites:2'), 'tok-2-new');   // 上書きされる
});

test('allTokens: repo をまたいでも topic が重複しなければそのまま合わさる', () => {
  const store = new Map();
  replaceRepoChannels(store, 'o/r1', [['check_suites:1', 'tok-1']]);
  replaceRepoChannels(store, 'o/r2', [['check_suites:2', 'tok-2']]);
  assert.equal(allTokens(store).size, 2);
});

test('repoForTopic: 未知の topic は null', () => {
  const store = new Map();
  replaceRepoChannels(store, 'o/r1', [['check_suites:1', 'tok-1']]);
  assert.equal(repoForTopic(store, 'check_suites:999'), null);
});
