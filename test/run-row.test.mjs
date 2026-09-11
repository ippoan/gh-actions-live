// run 行の読み取り (extension/run-row.js) の単体テスト。DOM は使わず偽の row で回す。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRow, GH } from '../extension/run-row.js';

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
