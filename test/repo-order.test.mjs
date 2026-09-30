// repo セクションの並び (extension/repo-order.js) の単体テスト。
import test from 'node:test';
import assert from 'node:assert/strict';
import { sortReposByRecent } from '../extension/repo-order.js';

const names = entries => sortReposByRecent(entries).map(([repo]) => repo);

test('最新の run を持つ repo が先頭に来る (repo の中の最大時刻で比べる)', () => {
  assert.deepEqual(names([
    ['a', [{ at: '2026-09-30T01:00:00Z' }]],
    ['b', [{ at: '2026-09-30T00:00:00Z' }, { at: '2026-09-30T03:00:00Z' }]],
    ['c', [{ at: '2026-09-30T02:00:00Z' }]],
  ]), ['b', 'c', 'a']);
});

test('at が無い run は seenAt で比べる', () => {
  assert.deepEqual(names([
    ['a', [{ at: '2026-09-30T01:00:00Z' }]],
    ['b', [{ at: null, seenAt: '2026-09-30T02:00:00Z' }]],
  ]), ['b', 'a']);
});

test('run 0 件の repo は末尾 (設定の順を保つ)', () => {
  assert.deepEqual(names([
    ['empty1', []],
    ['a', [{ at: '2026-09-30T01:00:00Z' }]],
    ['empty2', []],
    ['b', [{ at: '2026-09-30T02:00:00Z' }]],
  ]), ['b', 'a', 'empty1', 'empty2']);
});

test('同時刻・どちらも時刻が無いときは設定の順を保つ (安定ソート)', () => {
  const t = '2026-09-30T01:00:00Z';
  assert.deepEqual(names([
    ['x', [{ at: t }]], ['y', [{ at: t }]], ['z', [{ at: t }]],
    ['n1', [{}]], ['n2', [{}]],
  ]), ['x', 'y', 'z', 'n1', 'n2']);
});

test('設定に無い repo (末尾に足されたもの) も run があれば時刻順に入る', () => {
  assert.deepEqual(names([
    ['configured', [{ at: '2026-09-30T01:00:00Z' }]],
    ['loading', []],
    ['extra', [{ at: '2026-09-30T05:00:00Z' }]],
  ]), ['extra', 'configured', 'loading']);
});

test('入力の配列は書き換えない', () => {
  const entries = [['a', []], ['b', [{ at: '2026-09-30T01:00:00Z' }]]];
  sortReposByRecent(entries);
  assert.deepEqual(entries.map(([r]) => r), ['a', 'b']);
});
