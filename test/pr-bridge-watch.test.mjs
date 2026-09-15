// Claude Mod (mods/pr-bridge-watch) の単体テスト。
// 判定 (pr-watch.ts) はそのまま、register.ts は偽の `on` / `$` / `next` で包み方を検証する。
// .ts は Node 24 の type stripping で直接 import する (import type は消える)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { headOfCommand, isPrClosedState, isPrCreateCommand, isSelfArchive, pullRefsOf, statusUrlOf, watchUrlOf } from '../mods/pr-bridge-watch/hooks/pr-watch.ts';
import { PR_POLL_MS, register } from '../mods/pr-bridge-watch/hooks/register.ts';

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

test('PR の state と自分自身の archive の判定', () => {
  assert.equal(isPrClosedState('MERGED'), true);
  assert.equal(isPrClosedState('CLOSED'), true);
  assert.equal(isPrClosedState('OPEN'), false);
  assert.equal(isSelfArchive('mcp__ccd_session_mgmt__archive_session', { session_id: 'self' }), true);
  assert.equal(isSelfArchive('mcp__ccd_session_mgmt__archive_session', { session_id: 'abc' }), false);
  assert.equal(isSelfArchive('Bash', { session_id: 'self' }), false);
});

test('/watch と状態の URL', () => {
  assert.equal(watchUrlOf('ws://127.0.0.1:8799/', 'o/r', 'claude/x-1'), 'ws://127.0.0.1:8799/watch?repo=o%2Fr&ref=claude%2Fx-1');
  assert.equal(statusUrlOf('ws://127.0.0.1:8799'), 'http://127.0.0.1:8799/');
  assert.equal(statusUrlOf('wss://b.example/'), 'https://b.example/');
});

// register を偽の engine で回す
function harness({ options = {}, bridgeOk = true, headRef = 'feat-a', prState = 'OPEN', monitor = () => ({ result: { taskId: 't1' }, text: 'started' }), taskStop = () => ({ result: {}, text: 'stopped' }) } = {}) {
  const hooks = { bash: null, any: null, start: null };
  register((event, matcher, h) => {
    if (event === 'session.start') hooks.start = matcher;
    else if (typeof matcher === 'function') hooks.any = matcher;
    else { assert.deepEqual(matcher, { tool: 'Bash' }); hooks.bash = h; }
  }, options);
  const calls = { monitor: [], fetch: [], run: [], stop: [], log: [] };
  const timers = [];
  const state = { prState };
  const $ = {
    process: { run: async (argv) => {
      calls.run.push(argv);
      if (argv.includes('state')) return { exitCode: 0, stdout: `${state.prState}\n`, stderr: '' };
      return headRef === null ? { exitCode: 1, stdout: '', stderr: 'x' } : { exitCode: 0, stdout: `${headRef}\n`, stderr: '' };
    } },
    http: { fetch: async (url) => { calls.fetch.push(url); if (bridgeOk === 'throw') throw new Error('refused'); return { ok: bridgeOk, status: bridgeOk ? 200 : 503, text: '' }; } },
    tool: { call: async (input) => {
      if (input.tool === 'TaskStop') { calls.stop.push(input.task_id); return taskStop(input); }
      calls.monitor.push(input); return monitor(input);
    } },
    clock: { every: (ms, fn) => { const t = { ms, fn, cancelled: false, cancel() { t.cancelled = true; } }; timers.push(t); return t; } },
    ui: { log: (text) => calls.log.push(text) },
  };
  const run = (command, out) => hooks.bash($, { tool: 'Bash', tool_use_id: 'u1', command }, async () => out);
  const archive = (session_id) => hooks.any($, { tool: 'mcp__ccd_session_mgmt__archive_session', tool_use_id: 'u2', session_id }, async () => ({ result: {}, text: 'archived' }));
  // 生きている timer を 1 周期ぶん進め、poll の後始末 (TaskStop) まで待つ
  const tick = async () => { for (const t of timers.filter(t => !t.cancelled)) t.fn(); for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  return { run, archive, tick, calls, timers, state, hooks };
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
  assert.match(r.context.join('\n'), /Monitor で繋いだ \(task t1\)。PR が MERGED \/ CLOSED になるか/);
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
  assert.deepEqual(calls, { monitor: [], fetch: [], run: [], stop: [], log: [] });
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

test('PR が OPEN の間は止めず、MERGED になったら TaskStop して timer も止める', async () => {
  const { run, tick, calls, timers, state } = harness();
  await run('gh pr create --fill', PR_OUT);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, PR_POLL_MS);
  await tick();
  assert.deepEqual(calls.stop, []);
  state.prState = 'MERGED';
  await tick();
  assert.deepEqual(calls.stop, ['t1']);
  assert.equal(timers[0].cancelled, true);
  assert.match(calls.log[0], /pull\/46 が MERGED → Monitor \(task t1\) を止めた/);
  await tick();
  assert.deepEqual(calls.stop, ['t1']);
});

test('止めた branch に PR を作り直したら、また張る', async () => {
  const { run, tick, calls, state } = harness({ prState: 'CLOSED' });
  await run('gh pr create --fill', PR_OUT);
  await tick();
  await run('gh pr create --fill', PR_OUT);
  assert.equal(calls.monitor.length, 2);
});

test('自分自身の archive の前に全部の Monitor を止め、archive はそのまま通す', async () => {
  const { run, archive, calls, timers } = harness();
  await run('gh pr create --fill', PR_OUT);
  const r = await archive('self');
  assert.equal(r.text, 'archived');
  assert.deepEqual(calls.stop, ['t1']);
  assert.equal(timers[0].cancelled, true);
  assert.match(calls.log[0], /のセッションを archive する → Monitor \(task t1\) を止めた/);
});

test('他のセッションの archive・見張りが無いときは何もしない', async () => {
  const a = harness();
  await a.run('gh pr create --fill', PR_OUT);
  assert.equal((await a.archive('other-session')).text, 'archived');
  assert.deepEqual(a.calls.stop, []);
  const b = harness();
  assert.equal((await b.archive('self')).text, 'archived');
  assert.deepEqual(b.calls.stop, []);
});

test('TaskStop が拒否されても archive は止めず、止められなかったと log に残す', async () => {
  const { run, archive, calls } = harness({ taskStop: () => ({ deny: 'no such task' }) });
  await run('gh pr create --fill', PR_OUT);
  assert.equal((await archive('self')).text, 'archived');
  assert.match(calls.log[0], /止められなかった \(no such task\)/);
});

test('task ID が取れなければ poll せず、自分で TaskStop するよう context に書く', async () => {
  const { run, timers } = harness({ monitor: () => ({ result: {}, text: 'ok' }) });
  const r = await run('gh pr create --fill', PR_OUT);
  assert.equal(timers.length, 0);
  assert.match(r.context[0], /自動では止められない/);
});
