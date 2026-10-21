// run 行の読み取り (extension/run-row.js) の単体テスト。DOM は使わず偽の row で回す。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRow, GH, actionsPath, statusText, parseEmbeddedRun, runsFromEmbedded } from '../extension/run-row.js';

const el = (textContent, attrs = {}) => ({ textContent, getAttribute: name => attrs[name] ?? null });

// querySelector(selector) を selector 文字列ごとの返り値で答える偽の row。
// 表に無い selector には null を返す (= その要素が行に無い)
function fakeRow({ id = 'check_suite_111', text = '', select = {} } = {}) {
  return { id, textContent: text, querySelector: sel => select[sel] ?? null };
}

const RUN_LINK = el('', {
  'aria-label': 'completed successfully: Run 328 of Build and Deploy Firmware. fix(log): something (#229)',
  href: '/ippoan/alc-app-s3/actions/runs/999'
});
const REF_LINK = 'a[href*="/tree/"], a[href*="/releases/tag/"]';

test('branch のリンクと Bot の .Label が両方ある行 → ref は branch 名', () => {
  // 実 DOM では Bot バッジが branch リンクより前に出る。修正前の
  // querySelector('a[href*="/tree/"], a[href*="/releases/tag/"], .Label') は DOM 順で最初の一致 =
  // .Label を返すので、ここは `Bot` になっていた (ippoan/alc-app-s3#135 の #328)
  const bot = el('Bot');
  const row = fakeRow({
    text: 'Build and Deploy Firmware #328: Commit abc pushed by github-actions [Bot] main',
    select: {
      'a[aria-label]': RUN_LINK,
      'a[href*="/tree/"], a[href*="/releases/tag/"], .Label': bot,
      [REF_LINK]: el('  main  ', { href: '/ippoan/alc-app-s3/tree/main' }),
      '.Label': bot,
      'relative-time': el('', { datetime: '2026-09-11T06:00:00Z' })
    }
  });
  const r = parseRow(row);
  assert.equal(r.ref, 'main');
  assert.equal(r.checkSuiteId, '111');
  assert.equal(r.runId, '999');
  assert.equal(r.href, GH + '/ippoan/alc-app-s3/actions/runs/999');
  assert.equal(r.status, 'completed successfully');
  assert.equal(r.run, '328');
  assert.equal(r.workflow, 'Build and Deploy Firmware');
  assert.equal(r.title, 'fix(log): something (#229)');
  assert.equal(r.at, '2026-09-11T06:00:00Z');
});

test('タグのリンクだけの行 → ref はタグ名', () => {
  const row = fakeRow({
    select: {
      'a[aria-label]': RUN_LINK,
      [REF_LINK]: el('v0.0.162', { href: '/ippoan/gh-actions-live/releases/tag/v0.0.162' })
    }
  });
  assert.equal(parseRow(row).ref, 'v0.0.162');
});

test('リンクが無く .Label だけの行 → ref は .Label の文字列 (従来どおり)', () => {
  const row = fakeRow({
    select: { 'a[aria-label]': RUN_LINK, '.Label': el(' fix/226-3-ring-skip-psram-probe-word ') }
  });
  assert.equal(parseRow(row).ref, 'fix/226-3-ring-skip-psram-probe-word');
});

test('ref は 40 文字で切り詰める', () => {
  const long = 'fix/' + 'x'.repeat(60);
  const row = fakeRow({
    select: { 'a[aria-label]': RUN_LINK, [REF_LINK]: el(long, { href: '/o/r/tree/' + long }) }
  });
  assert.equal(parseRow(row).ref, long.slice(0, 40));
  assert.equal(parseRow(row).ref.length, 40);
});

test('ref になる要素が何も無い行 → 空文字', () => {
  const row = fakeRow({ select: { 'a[aria-label]': RUN_LINK } });
  assert.equal(parseRow(row).ref, '');
});

test('run のリンクが無い / aria-label の形が違う行 → null', () => {
  assert.equal(parseRow(fakeRow()), null);
  assert.equal(parseRow(fakeRow({ select: { 'a[aria-label]': el('', { 'aria-label': 'something else' }) } })), null);
});

test('ストップウォッチ隣の span → duration (空白は詰める)、無い行は空文字', () => {
  const row = fakeRow({
    select: { 'a[aria-label]': RUN_LINK, '.octicon-stopwatch + span': el('\n        1m   5s\n      ') }
  });
  assert.equal(parseRow(row).duration, '1m 5s');
  assert.equal(parseRow(fakeRow({ select: { 'a[aria-label]': RUN_LINK } })).duration, '');
});

test('Actions ページは素の /actions — ?react=false は GitHub に無視される (#52、2026-10-21)', () => {
  assert.equal(actionsPath('ippoan/gh-actions-live'), '/ippoan/gh-actions-live/actions');
});

// 署名済み data-channel の形 (`<base64 JSON>--<署名>`)
const ch = c => Buffer.from(JSON.stringify({ c, t: 1792554104 })).toString('base64') + '--sig';

// React 版 Actions ページの embeddedData にある run 1 件 (2026-10-21 の実物から必要な欄だけ)
const RUN = {
  name: 'CI', runNumber: 93, id: '39361283062', workflowName: 'CI',
  runUrl: 'https://github.com/ippoan/gh-actions-live/actions/runs/39361283062',
  title: 'feat(extension): ダッシュボードのカードに run の実行時間を出す (#55)',
  state: { status: 'WORKFLOW_RUN_STATUS_COMPLETED', conclusion: 'WORKFLOW_RUN_CONCLUSION_SUCCESS' },
  createdAt: { timestamp: '2026-10-20T02:52:42Z', isCurrentYear: true },
  branch: { name: 'refs/heads/main', url: '/ippoan/gh-actions-live/tree/refs/heads/main', title: 'main' },
  timing: { kind: 'WORKFLOW_RUN_TIMING_KIND_DURATION', text: '27s' },
  aliveChannel: ch('check_suites:106662649040'),
  description: { action: 'pushed', actorName: 'ippoan-ci-bot[bot]', actorType: 'WORKFLOW_RUN_ACTOR_TYPE_BOT' }
};

test('embeddedData の run → parseRow と同じ形', () => {
  assert.deepEqual(parseEmbeddedRun(RUN), {
    checkSuiteId: '106662649040', runId: '39361283062',
    href: 'https://github.com/ippoan/gh-actions-live/actions/runs/39361283062',
    status: 'completed successfully', run: '93', workflow: 'CI',
    title: 'feat(extension): ダッシュボードのカードに run の実行時間を出す (#55)',
    ref: 'main', by: 'ippoan-ci-bot', at: '2026-10-20T02:52:42Z', duration: '27s'
  });
});

test('実行中・branch 無しの run → duration と ref は空', () => {
  const r = parseEmbeddedRun({ ...RUN, branch: undefined,
    state: { status: 'WORKFLOW_RUN_STATUS_IN_PROGRESS' },
    timing: { kind: 'WORKFLOW_RUN_TIMING_KIND_IN_PROGRESS', text: 'In progress' } });
  assert.equal(r.status, 'currently running');
  assert.equal(r.duration, '');
  assert.equal(r.ref, '');
});

test('state → 旧 UI の aria-label と同じ文言 (bridge の正規表現が見る語彙)', () => {
  const s = (status, conclusion) => statusText({ status: 'WORKFLOW_RUN_STATUS_' + status,
    conclusion: conclusion && 'WORKFLOW_RUN_CONCLUSION_' + conclusion });
  assert.equal(s('COMPLETED', 'SUCCESS'), 'completed successfully');
  assert.equal(s('COMPLETED', 'FAILURE'), 'failed');
  assert.equal(s('COMPLETED', 'SKIPPED'), 'skipped');
  assert.equal(s('COMPLETED', 'CANCELLED'), 'cancelled');
  assert.equal(s('COMPLETED', 'TIMED_OUT'), 'timed out');
  assert.equal(s('COMPLETED', 'ACTION_REQUIRED'), 'action required');
  assert.equal(s('IN_PROGRESS'), 'currently running');
  assert.equal(s('QUEUED'), 'queued');
  assert.equal(s('WAITING'), 'waiting');
});

test('embeddedData 全体 → run と購読 channel (repo の workflow_runs と run の check_suites)', () => {
  const route = ch('workflow_runs:1342560199');
  const got = runsFromEmbedded({ payload: { allWorkflowRunsRoute: { aliveChannel: route, workflowRuns: [RUN, { ...RUN, aliveChannel: 'broken' }] } } });
  assert.equal(got.runs.length, 1);
  assert.deepEqual(got.channels, [['workflow_runs:1342560199', route], ['check_suites:106662649040', RUN.aliveChannel]]);
  assert.equal(runsFromEmbedded({ payload: {} }), null);
});
