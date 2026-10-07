// Actions ページの run 行 (`check_suite_…`) を 1 件ぶんの run に読む。ダッシュボードから使う。
// DOM API は `row` に生えている querySelector / getAttribute / textContent / id だけを使うので、
// Node の単体テスト (test/run-row.test.mjs) から偽の row で回せる。

export const GH = 'https://github.com';

// Actions ページ (run 一覧) のパス。**`?react=false` を外さない** (#52)。
// ログイン中の GitHub は Actions ページを React 版で返すようになり、run は
// `react-app.embeddedData` の JSON に入って `.Box-row[id^="check_suite_"]` の行も
// run ごとの data-channel も消える (全 repo が「0 runs / 読み込み中…」のまま止まった)。
// React 版の reactToggle が指す旧 UI を明示で取る。このリクエスト限りで、
// ユーザーが github.com で見る Actions ページの表示は変わらない (実測 2026-10-08)
export const actionsPath = repo => `/${repo}/actions?react=false`;

// branch / タグへのリンク。行に ref を表す要素はこれが本命
const REF_LINK = 'a[href*="/tree/"], a[href*="/releases/tag/"]';

// 行 1 つ。aria-label に status / run番号 / workflow名 / title が全部入っている。
export function parseRow(row) {
  const a = row.querySelector('a[aria-label]');
  if (!a) return null;
  const m = (a.getAttribute('aria-label') || '').match(/^([^:]*):\s*Run (\d+) of ([^.]+)\.\s*(.*)$/);
  if (!m) return null;

  const text = (row.textContent || '').replace(/\s+/g, ' ');
  const by = text.match(/(?:pushed|triggered|run|opened) by ([\w.\-\[\]]+)/i);
  // ref はリンクを優先し、無い行だけ .Label に落とす。
  // querySelector のカンマ区切りは記述順ではなく **DOM 順で最初に一致した要素**を返すので、
  // 1 本にまとめると Bot が push した行では actor の「Bot」バッジ (.Label) が
  // branch のリンクより先に当たり、ref が `Bot` になる (bridge の /watch?ref=main に一致しない)
  const refEl = row.querySelector(REF_LINK) || row.querySelector('.Label');

  return {
    checkSuiteId: row.id.replace('check_suite_', ''),
    runId: (a.getAttribute('href') || '').split('/').pop(),
    href: GH + (a.getAttribute('href') || ''),
    status: m[1].trim(), run: m[2], workflow: m[3].trim(), title: m[4].trim(),
    ref: refEl ? refEl.textContent.trim().slice(0, 40) : '',
    by: by ? by[1] : '',
    at: row.querySelector('relative-time')?.getAttribute('datetime') || null
  };
}
