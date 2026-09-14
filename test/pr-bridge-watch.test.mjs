// Claude Mod (mods/pr-bridge-watch) の単体テスト。
// 判定 (pr-watch.ts) はそのまま、register.ts は偽の `on` / `$` / `next` で包み方を検証する。
// .ts は Node 24 の type stripping で直接 import する (import type は消える)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { headOfCommand, isPrCreateCommand, pullRefsOf, statusUrlOf, watchUrlOf } from '../mods/pr-bridge-watch/hooks/pr-watch.ts';
import { register } from '../mods/pr-bridge-watch/hooks/register.ts';

test('PR を作る command だけ拾う', () => {
  assert.equal(isPrCreateCommand('gh pr create --title t --body b'), true);
  assert.equal(isPrCreateCommand('cd x && gh  pr   create --fill'), true);
  assert.equal(isPrCreateCommand('bash ~/claude260730/claude-skills/pr-push/scripts/pr-push.sh "t" "b"'), true);
  assert.equal(isPrCreateCommand('gh pr view 45'), false);
  assert.equal(isPrCreateCommand('gh pr checks'), false);
});

test('出力から PR の URL を重複なしで拾う', () => {
  const text = 'PR: https://github.com/ippoan/gh-actions-live/pull/46\nhttps://github.com/ippoan/gh-actions-live/pull/46';
  assert.deepEqual(pullRefsOf(text), [{ repo: 'ippoan/gh-actions-live', number: 46, url: 'https://github.com/ippoan/gh-actions-live/pull/46' }]);
  assert.deepEqual(pullRefsOf('https://github.com/o/r/issues/3'), []);
});

test('--head / -H を拾う', () => {
  assert.equal(headOfCommand('gh pr create --head feat-a --title t'), 'feat-a');
  assert.equal(headOfCommand('gh pr create -H "feat-b"'), 'feat-b');
  assert.equal(headOfCommand('gh pr create --head=feat-c'), 'feat-c');
  assert.equal(headOfCommand('gh pr create --fill'), null);
});

test('/watch と状態の URL', () => {
  assert.equal(watchUrlOf('ws://127.0.0.1:8799/', 'o/r', 'claude/x-1'), 'ws://127.0.0.1:8799/watch?repo=o%2Fr&ref=claude%2Fx-1');
  assert.equal(statusUrlOf('ws://127.0.0.1:8799'), 'http://127.0.0.1:8799/');
  assert.equal(statusUrlOf('wss://b.example/'), 'https://b.example/');
});

// register を偽の engine で回す
function harness({ options = {}, bridgeOk = true, headRef = 'feat-a', monitor = () => ({ result: { taskId: 't1' }, text: 'started' }) } = {}) {
  let hook;
  register((event, matcher, h) => {
    assert.equal(event, 'tool.call');
    assert.deepEqual(matcher, { tool: 'Bash' });
    hook = h;
  }, options);
  const calls = { monitor: [], fetch: [], run: [] };
  const $ = {
    process: { run: async (argv) => { calls.run.push(argv); return headRef === null ? { exitCode: 1, stdout: '', stderr: 'x' } : { exitCode: 0, stdout: `${headRef}\n`, stderr: '' }; } },
    http: { fetch: async (url) => { calls.fetch.push(url); if (bridgeOk === 'throw') throw new Error('refused'); return { ok: bridgeOk, status: bridgeOk ? 200 : 503, text: '' }; } },
    tool: { call: async (input) => { calls.monitor.push(input); return monitor(input); } },
  };
  const run = (command, out) => hook($, { tool: 'Bash', tool_use_id: 'u1', command }, async () => out);
  return { run, calls };
}

const PR_OUT = { result: {}, text: 'https://github.com/ippoan/gh-actions-live/pull/46' };

test('PR 作成に成功したら branch の /watch に Monitor を張り、context で知らせる', async () => {
  const { run, calls } = harness();
  const r = await run('gh pr create --fill', PR_OUT);
  assert.equal(calls.monitor.length, 1);
  assert.deepEqual(calls.monitor[0].ws, { url: 'ws://127.0.0.1:8799/watch?repo=ippoan%2Fgh-actions-live&ref=feat-a' });
  assert.equal(calls.monitor[0].tool, 'Monitor');
  assert.equal(calls.monitor[0].persistent, true);
  assert.equal(r.text, PR_OUT.text);
  assert.match(r.context.join('\n'), /Monitor で繋いだ \(task t1\)/);
});

test('同じ branch は二度張らない', async () => {
  const { run, calls } = harness();
  await run('gh pr create --fill', PR_OUT);
  const r = await run('bash pr-push.sh t b', PR_OUT);
  assert.equal(calls.monitor.length, 1);
  assert.equal(r.context, undefined);
});

test('PR 作成以外の Bash は素通し (engine に何も頼まない)', async () => {
  const { run, calls } = harness();
  const out = { result: {}, text: 'https://github.com/o/r/pull/1' };
  assert.equal(await run('gh pr view 1', out), out);
  assert.deepEqual(calls, { monitor: [], fetch: [], run: [] });
});

test('失敗した PR 作成・deny は触らない', async () => {
  const { run, calls } = harness();
  const err = { isError: true, result: 'boom', text: 'https://github.com/o/r/pull/1 already exists' };
  assert.equal(await run('gh pr create', err), err);
  const deny = { deny: 'no' };
  assert.equal(await run('gh pr create', deny), deny);
  assert.equal(calls.monitor.length, 0);
});

test('bridge が落ちていたら Monitor を張らず、自分で張る引数を context に書く', async () => {
  for (const bridgeOk of [false, 'throw']) {
    const { run, calls } = harness({ bridgeOk });
    const r = await run('gh pr create --fill', PR_OUT);
    assert.equal(calls.monitor.length, 0);
    assert.match(r.context[0], /bridge .* に届かない/);
    assert.match(r.context[0], /Monitor\(\{ ws: \{ url: "ws:\/\/127\.0\.0\.1:8799\/watch\?repo=ippoan%2Fgh-actions-live&ref=feat-a" \}/);
  }
});

test('Monitor が拒否・失敗したら context に張り方を残し、次の PR 作成で再挑戦できる', async () => {
  let n = 0;
  const { run, calls } = harness({ monitor: () => { n++; if (n === 1) return { deny: 'not allowed' }; if (n === 2) throw new Error('x'); return { result: {}, text: 'ok' }; } });
  assert.match((await run('gh pr create', PR_OUT)).context[0], /張れなかった \(not allowed\)/);
  assert.match((await run('gh pr create', PR_OUT)).context[0], /起動に失敗/);
  assert.match((await run('gh pr create', PR_OUT)).context[0], /Monitor で繋いだ/);
  assert.equal(calls.monitor.length, 3);
});

test('gh pr view が失敗したら command の --head に落ち、それも無ければ繋がない', async () => {
  const a = harness({ headRef: null });
  await a.run('gh pr create --head feat-z', PR_OUT);
  assert.match(a.calls.monitor[0].ws.url, /ref=feat-z$/);
  const b = harness({ headRef: null });
  const r = await b.run('gh pr create --fill', PR_OUT);
  assert.equal(b.calls.monitor.length, 0);
  assert.match(r.context[0], /branch が分からず/);
});

test('options.bridgeUrl で bridge を差し替えられる', async () => {
  const { run, calls } = harness({ options: { bridgeUrl: 'ws://100.64.0.1:8799' } });
  await run('gh pr create --fill', PR_OUT);
  assert.equal(calls.fetch[0], 'http://100.64.0.1:8799/');
  assert.match(calls.monitor[0].ws.url, /^ws:\/\/100\.64\.0\.1:8799\/watch\?/);
});
