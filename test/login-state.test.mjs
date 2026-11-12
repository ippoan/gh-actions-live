// ログイン状態の判定 (extension/login-state.js) の単体テスト。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loginOf, loginVerdict, createLoginTracker } from '../extension/login-state.js';

// meta[name=user-login] だけ持つ偽の document。content === undefined なら meta 自体が無い
const fakeDoc = content => ({
  querySelector: sel => (sel === 'meta[name=user-login]' && content !== undefined ? { content } : null)
});

test('loginOf: meta に名前があればその名前', () => {
  assert.equal(loginOf(fakeDoc('octocat')), 'octocat');
});

test('loginOf: content が空なら null (未ログインの GitHub の HTML)', () => {
  assert.equal(loginOf(fakeDoc('')), null);
});

test('loginOf: meta が無ければ null', () => {
  assert.equal(loginOf(fakeDoc(undefined)), null);
});

test('loginVerdict: 全 repo が 404 で user-login が空 → 未ログイン', () => {
  assert.deepEqual(loginVerdict([fakeDoc(''), fakeDoc(''), fakeDoc('')]), { loggedIn: false, user: null });
});

test('loginVerdict: 1 つでも名前があればログイン済み', () => {
  assert.deepEqual(loginVerdict([fakeDoc(''), fakeDoc('octocat'), fakeDoc(undefined)]), { loggedIn: true, user: 'octocat' });
});

test('loginVerdict: 判定に入った doc が 0 件なら判定しない (null)', () => {
  assert.equal(loginVerdict([]), null);
});

test('tracker: 初回は必ず返し、同じ値は null、変化で返す', () => {
  const t = createLoginTracker();
  assert.equal(t.last(), null);
  assert.deepEqual(t.observe('octocat'), { loggedIn: true, user: 'octocat' });
  assert.equal(t.observe('octocat'), null);
  assert.deepEqual(t.observe(null), { loggedIn: false, user: null });
  assert.equal(t.observe(null), null);
  assert.deepEqual(t.last(), { loggedIn: false, user: null });
  assert.deepEqual(t.observe('octocat'), { loggedIn: true, user: 'octocat' });
});

test('tracker: 初回が未ログインでも返す', () => {
  const t = createLoginTracker();
  assert.deepEqual(t.observe(null), { loggedIn: false, user: null });
});
