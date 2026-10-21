// Actions ページの run 行 (`check_suite_…`) を 1 件ぶんの run に読む。ダッシュボードから使う。
// DOM API は `row` に生えている querySelector / getAttribute / textContent / id だけを使うので、
// Node の単体テスト (test/run-row.test.mjs) から偽の row で回せる。

export const GH = 'https://github.com';

// Actions ページ (run 一覧) のパス。
// GitHub はログイン中の Actions ページを React 版でしか返さなくなった (`?react=false` も無視される。
// 実測 2026-10-21)。run は `react-app.embeddedData` の JSON にあるので runsFromEmbedded で読む。
// 1 run の partial (`/actions/workflow-run/<checkSuiteId>`) は旧形式の行のままなので parseRow で読む
export const actionsPath = repo => `/${repo}/actions`;

// 署名済み data-channel (`<base64 JSON>--<署名>`) → topic (`check_suites:123` 等)
export const decodeChannel = v => { try { return JSON.parse(atob(v.split('--')[0])).c; } catch { return null; } };

// embeddedData の state → 旧 UI の aria-label と同じ文言。bridge (watch.rs) とダッシュボードは
// この文言を正規表現で見る (running/queued/fail/cancel…) ので、語彙を揃える
const CONCLUSION = { SUCCESS: 'completed successfully', FAILURE: 'failed' };
const STATUS = { IN_PROGRESS: 'currently running' };
const word = s => String(s || '').replace(/^WORKFLOW_RUN_(STATUS|CONCLUSION)_/, '').toLowerCase().replace(/_/g, ' ');
export function statusText({ status, conclusion } = {}) {
  const st = String(status || '').replace('WORKFLOW_RUN_STATUS_', '');
  if (st === 'COMPLETED' && conclusion) {
    const c = String(conclusion).replace('WORKFLOW_RUN_CONCLUSION_', '');
    return CONCLUSION[c] || word(c);
  }
  return STATUS[st] || word(st);
}

// React 版 Actions ページの JSON (`payload.allWorkflowRunsRoute`) の run 1 件 → parseRow と同じ形
export function parseEmbeddedRun(w) {
  const topic = decodeChannel(w?.aliveChannel || '');
  if (!topic?.startsWith('check_suites:')) return null;
  return {
    checkSuiteId: topic.split(':')[1],
    runId: String(w.id),
    href: w.runUrl?.startsWith('/') ? GH + w.runUrl : w.runUrl,
    status: statusText(w.state), run: String(w.runNumber), workflow: w.workflowName || w.name || '',
    title: w.title || '',
    ref: (w.branch?.title || '').trim().slice(0, 40),
    by: (w.description?.actorName || '').replace(/\[bot\]$/, ''),   // partial の行は `[bot]` を付けない
    at: w.createdAt?.timestamp || null,
    duration: w.timing?.kind === 'WORKFLOW_RUN_TIMING_KIND_DURATION' ? (w.timing.text || '') : ''
  };
}

// embeddedData の JSON 全体 → run と購読用 channel ([topic, 署名済み値])。
// repo 単位の `workflow_runs:<repoId>` と run ごとの `check_suites:<id>` が JSON 側にしか無い
export function runsFromEmbedded(data) {
  const route = data?.payload?.allWorkflowRunsRoute;
  if (!route) return null;
  const runs = [], channels = [];
  for (const v of [route.aliveChannel, ...(route.workflowRuns || []).map(w => w.aliveChannel)]) {
    const topic = v && decodeChannel(v);
    if (topic) channels.push([topic, v]);
  }
  for (const w of route.workflowRuns || []) {
    const r = parseEmbeddedRun(w);
    if (r) runs.push(r);
  }
  return { runs, channels };
}

// branch / タグへのリンク。行に ref を表す要素はこれが本命
const REF_LINK = 'a[href*="/tree/"], a[href*="/releases/tag/"]';

// 実行時間 (`24s` / `1m 5s`)。行のストップウォッチ (aria-label="Run duration") の隣の span。
// 狭い幅用と広い幅用で同じものが 2 つあるので最初の 1 つで足りる
const DURATION = '.octicon-stopwatch + span';

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
    at: row.querySelector('relative-time')?.getAttribute('datetime') || null,
    duration: (row.querySelector(DURATION)?.textContent || '').replace(/\s+/g, ' ').trim()
  };
}
