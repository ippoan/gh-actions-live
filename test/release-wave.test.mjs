// 右側パネルの Release Wave 切り替え待ち (mods/pr-bridge-watch/hooks/release-wave.ts、#83) の単体テスト。
// engine の `$` は使わず、偽の Host (tool の一覧 / 呼び出し / prompt.submit) で回す。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLIP_REQUESTED, FOLLOW_READS, NO_CONNECTOR, flipArgsOf, flipKeyOf, flipPending, flipPromptOf, flipToolOf, followUp, isFlippable, isPaneOpen, labelOf,
  loadPending, pendingRowsOf, shortId, stateToolOf,
} from '../mods/pr-bridge-watch/hooks/release-wave.ts';

const STATE = 'mcp__72d6cc20-9f30-46e2-ac4f-cf3736a87a7f__release_wave_pending_state';
const FLIP = 'mcp__72d6cc20-9f30-46e2-ac4f-cf3736a87a7f__release_wave_pending_flip';
const TOOLS = [
  { name: 'Bash', mcp: false },
  { name: 'mcp__72d6cc20-9f30-46e2-ac4f-cf3736a87a7f__release_wave_pending_flip_all', mcp: true },
  { name: FLIP, mcp: true },
  { name: STATE, mcp: true },
];

// ci-dashboard の release_wave_pending_state が返す形 (unified / pending / traffic) のうち unified だけ使う
const ALC = {
  repo: 'yhonda-ohishi-alc/alc-app', worker_name: null, version_id: '0123456789abcdef', tag: 'v0.0.522',
  uploaded_at: '2026-11-13T05:00:00Z', preview_url: null, source: 'traffic', rollback_to: 'fedcba9876543210', rollback_tag: 'v0.0.521',
};
const MONO = { ...ALC, repo: 'ippoan/alc-workers', worker_name: 'alc-vein-worker', tag: null, source: 'pending', rollback_to: null, rollback_tag: null };
const STATE_TEXT = JSON.stringify({ unified: [ALC, MONO], pending: [], traffic: [] }, null, 2);

function host({ tools = TOOLS, call = () => ({ text: STATE_TEXT }) } = {}) {
  const calls = { call: [], submit: [] };
  return {
    calls,
    list: async () => (tools instanceof Error ? Promise.reject(tools) : tools),
    call: async (tool, input) => { calls.call.push({ tool, input }); return call(tool, input); },
    submit: async (text) => { calls.submit.push(text); },
  };
}

test('ci-dashboard の connector のツール名を末尾で探し、flip の名前は同じ connector から作る', () => {
  assert.equal(stateToolOf(TOOLS), STATE);
  assert.equal(flipToolOf(STATE), FLIP);
  assert.equal(stateToolOf([{ name: 'Bash', mcp: false }]), null);
  // 組み込みのツールに同じ末尾が来ても拾わない
  assert.equal(stateToolOf([{ name: 'x__release_wave_pending_state', mcp: false }]), null);
});

test('pending_state の unified を行にする (null と空文字は null に揃える)', () => {
  const rows = pendingRowsOf(STATE_TEXT);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    repo: 'yhonda-ohishi-alc/alc-app', worker_name: null, version_id: '0123456789abcdef', tag: 'v0.0.522',
    uploaded_at: '2026-11-13T05:00:00Z', source: 'traffic', rollback_tag: 'v0.0.521', rollback_to: 'fedcba9876543210',
  });
  assert.equal(rows[1].worker_name, 'alc-vein-worker');
  assert.equal(rows[1].tag, null);
  assert.deepEqual(pendingRowsOf(JSON.stringify({ unified: [{ repo: '' }, null, { repo: 'o/r', tag: '' }] })).map(r => [r.repo, r.tag]), [['o/r', null]]);
});

test('pending_state が読めない / error を返したら理由つきで throw', () => {
  assert.throws(() => pendingRowsOf('not json'), /JSON でない/);
  assert.throws(() => pendingRowsOf(JSON.stringify({ code: 'KV_NOT_CONFIGURED', error: 'COMPAT_KV is not bound' })), /KV_NOT_CONFIGURED: COMPAT_KV is not bound/);
  assert.throws(() => pendingRowsOf('{}'), /unified が無い/);
});

test('行の key・見出し・引数は ci-dashboard の Flip と同じ形', () => {
  const [alc, mono] = pendingRowsOf(STATE_TEXT);
  assert.equal(flipKeyOf(alc), 'yhonda-ohishi-alc/alc-app::::0123456789abcdef');
  assert.equal(flipKeyOf(mono), 'ippoan/alc-workers::alc-vein-worker::0123456789abcdef');
  assert.equal(labelOf(alc), 'yhonda-ohishi-alc/alc-app');
  assert.equal(labelOf(mono), 'ippoan/alc-workers / alc-vein-worker');
  // 単一 worker の repo は worker_name を送らない (ci-dashboard のビューも undefined にする)
  assert.deepEqual(flipArgsOf(alc), { repo: 'yhonda-ohishi-alc/alc-app' });
  assert.deepEqual(flipArgsOf(mono), { repo: 'ippoan/alc-workers', worker_name: 'alc-vein-worker' });
  assert.equal(isFlippable(alc), true);
  assert.equal(isFlippable(mono), false);
  assert.equal(shortId('0123456789abcdef'), '01234567');
  assert.equal(shortId(null), '—');
});

test('読み: connector の pending_state を引数なしで呼び、行を返す', async () => {
  const h = host();
  const r = await loadPending(h);
  assert.equal(r.error, '');
  assert.equal(r.rows.length, 2);
  assert.deepEqual(h.calls.call, [{ tool: STATE, input: {} }]);
});

test('読み: connector が無ければ「繋がっていません」と止める印 (throw しない)', async () => {
  const h = host({ tools: [{ name: 'Bash', mcp: false }] });
  assert.deepEqual(await loadPending(h), { rows: [], error: NO_CONNECTOR, noConnector: true });
  assert.equal(NO_CONNECTOR, 'ci-dashboard の connector が繋がっていません');
  assert.deepEqual(h.calls.call, []);
  // connector があれば止める印は付かない
  assert.equal((await loadPending(host())).noConnector, undefined);
});

test('読み: 拒否・失敗・一覧が読めないは行なしで理由だけ (止めない)', async () => {
  assert.match((await loadPending(host({ call: () => ({ deny: 'ask rule' }) }))).error, /呼べない: ask rule/);
  assert.match((await loadPending(host({ call: () => ({ isError: true, text: 'boom' }) }))).error, /失敗: boom/);
  assert.match((await loadPending(host({ call: () => { throw new Error('aborted'); } }))).error, /aborted/);
  assert.match((await loadPending(host({ tools: new Error('nope') }))).error, /一覧が読めない/);
  assert.match((await loadPending(host({ call: () => ({ text: '{"code":"X","error":"y"}' }) }))).error, /X: y/);
});

test('Flip: 確定の後は flip のツールを repo (と worker_name) で 1 回呼ぶ', async () => {
  const h = host({ call: () => ({ text: '{"ok":true}' }) });
  const [alc] = pendingRowsOf(STATE_TEXT);
  const r = await flipPending(h, alc);
  assert.deepEqual(h.calls.call, [{ tool: FLIP, input: { repo: 'yhonda-ohishi-alc/alc-app' } }]);
  assert.deepEqual(h.calls.submit, []);
  // 成否は断言しない: 依頼したことだけ言い、結果は次の読み (followUp) で出す
  assert.deepEqual(r, { msg: `Flip yhonda-ohishi-alc/alc-app v0.0.522: ${FLIP_REQUESTED}`, sent: true });
  assert.equal(FLIP_REQUESTED, '切り替えを依頼しました (GitHub Actions で実行)');
});

test('Flip: 設定で ask にしてあり mod から呼べなければ、モデルに同じ引数で頼む (許可カードで止まる)', async () => {
  const h = host({ call: () => ({ deny: 'needs approval' }) });
  const [alc] = pendingRowsOf(STATE_TEXT);
  const r = await flipPending(h, alc);
  assert.equal(h.calls.call.length, 1);
  assert.deepEqual(h.calls.submit, [flipPromptOf(FLIP, alc)]);
  assert.match(h.calls.submit[0], new RegExp(`${FLIP} を \\{"repo":"yhonda-ohishi-alc/alc-app"\\} で 1 回だけ呼び`));
  assert.match(r.msg, /会話に回しました \(許可カードで確定\)/);
  assert.equal(r.sent, true);
});

test('Flip: 失敗・connector 無しは結果の 1 行で返し、モデルには頼まない', async () => {
  const [alc] = pendingRowsOf(STATE_TEXT);
  const failed = host({ call: () => ({ isError: true, text: '{"ok":false,"error":"no pending"}' }) });
  const f = await flipPending(failed, alc);
  assert.match(f.msg, /失敗 .*no pending/);
  assert.equal(f.sent, false);
  assert.deepEqual(failed.calls.submit, []);
  const none = host({ tools: [] });
  assert.deepEqual(await flipPending(none, alc), { msg: `Flip yhonda-ohishi-alc/alc-app v0.0.522: ${NO_CONNECTOR}`, sent: false });
  assert.deepEqual(none.calls.call, []);
  const thrown = host({ call: () => { throw new Error('aborted'); } });
  assert.match((await flipPending(thrown, alc)).msg, /失敗 Error: aborted/);
});

test('Flip の後: 次の読みで行が消えていれば「消えました」、残っていれば「まだ残っています」', () => {
  const [alc, mono] = pendingRowsOf(STATE_TEXT);
  const sent = [{ key: flipKeyOf(alc), label: 'yhonda-ohishi-alc/alc-app v0.0.522', reads: 0 }];
  // 残っている → 追い続ける (reads を 1 増やす)
  const still = followUp(sent, [alc, mono]);
  assert.deepEqual(still.sent, [{ ...sent[0], reads: 1 }]);
  assert.match(still.msg, /^yhonda-ohishi-alc\/alc-app v0\.0\.522: まだ切り替え待ちに残っています/);
  // 消えた → 追うのをやめる
  const gone = followUp(still.sent, [mono]);
  assert.deepEqual(gone, { sent: [], msg: 'yhonda-ohishi-alc/alc-app v0.0.522: 切り替え待ちから消えました' });
  // 何も追っていなければ msg は null (直前の表示を残す)
  assert.deepEqual(followUp([], [alc]), { sent: [], msg: null });
  // FOLLOW_READS 回読んでも残っていたら追うのをやめる (表示は最後の 1 回だけ)
  const last = followUp([{ ...sent[0], reads: FOLLOW_READS - 1 }], [alc]);
  assert.deepEqual(last.sent, []);
  assert.match(last.msg, /まだ切り替え待ちに残っています/);
});

test('パネルが開いているか: id があり、surface が置いている (待ちの pane は開いていない扱い)', () => {
  assert.equal(isPaneOpen([{ id: 'actions-pane', isPlaced: true }], 'actions-pane'), true);
  assert.equal(isPaneOpen([{ id: 'actions-pane', isPlaced: false }], 'actions-pane'), false);
  assert.equal(isPaneOpen([{ id: 'other', isPlaced: true }], 'actions-pane'), false);
  assert.equal(isPaneOpen([], 'actions-pane'), false);
});
