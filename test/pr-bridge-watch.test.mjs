// Claude Mod (mods/pr-bridge-watch) の単体テスト。
// 判定 (pr-watch.ts) はそのまま、register.ts は偽の `on` / `$` / `next` で包み方を検証する。
// .ts は Node 24 の type stripping で直接 import する (import type は消える)。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveTargetOf, headOfCommand, isAutoModeNoVerdict, isDesktopEntrypoint, isLiveWorkRefusal, isPrCreateCommand, isSelfArchive, isStopRequest,
  pullRefsOf, statusUrlOf, STOP_REQUEST, watchUrlOf,
} from '../mods/pr-bridge-watch/hooks/pr-watch.ts';
import { register, STOP_REQUEST_WAIT_MS } from '../mods/pr-bridge-watch/hooks/register.ts';

const ARCHIVE = 'mcp__ccd_session_mgmt__archive_session';
const SEND = 'mcp__ccd_session_mgmt__send_message';
const REFUSED = { isError: true, result: undefined, text: 'Session abc was not archived: it still has live work (an agent run, a Remote Control client, a queued message or a background task).' };
// auto mode の分類器が hook 発の Monitor に返す拒否の全文 (ippoan/gh-actions-live#50 で実測した文面)
const NO_VERDICT = 'The server-side auto mode classifier gave no verdict for Monitor: the request that produced this action did not ask for one. Issue the action again once, as-is; if it is denied again, continue with other tasks that don\'t require it and tell the user that auto mode could not evaluate it. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.';

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

test('archive の判定 (自分 / 他のセッション / live work の拒否) と停止要求', () => {
  assert.equal(isSelfArchive(ARCHIVE, { session_id: 'self' }), true);
  assert.equal(isSelfArchive(ARCHIVE, { session_id: 'abc' }), false);
  assert.equal(isSelfArchive('Bash', { session_id: 'self' }), false);
  assert.equal(archiveTargetOf(ARCHIVE, { session_id: 'abc' }), 'abc');
  assert.equal(archiveTargetOf(ARCHIVE, { session_id: 'self' }), null);
  assert.equal(archiveTargetOf('Bash', { session_id: 'abc' }), null);
  assert.equal(isLiveWorkRefusal(REFUSED.text), true);
  assert.equal(isLiveWorkRefusal('Session abc was not archived: it is pinned or in use.'), false);
  assert.equal(isStopRequest(`From 親: ${STOP_REQUEST}`), true);
  assert.equal(isStopRequest('Monitor を止めて'), false);
});

test('/watch と状態の URL', () => {
  assert.equal(watchUrlOf('ws://127.0.0.1:8799/', 'o/r', 'claude/x-1'), 'ws://127.0.0.1:8799/watch?repo=o%2Fr&ref=claude%2Fx-1');
  assert.equal(statusUrlOf('ws://127.0.0.1:8799'), 'http://127.0.0.1:8799/');
  assert.equal(statusUrlOf('wss://b.example/'), 'https://b.example/');
});

test('auto mode の無判定と desktop の判定', () => {
  assert.equal(isAutoModeNoVerdict(NO_VERDICT), true);
  assert.equal(isAutoModeNoVerdict('The auto mode classifier denied Monitor: it is not safe.'), false);
  assert.equal(isAutoModeNoVerdict('The user gave no verdict.'), false);
  assert.equal(isAutoModeNoVerdict('not allowed'), false);
  assert.equal(isAutoModeNoVerdict(''), false);
  assert.equal(isDesktopEntrypoint('claude-desktop'), true);
  assert.equal(isDesktopEntrypoint('cli'), false);
  assert.equal(isDesktopEntrypoint(undefined), false);
});

// register を偽の engine で回す。entrypoint は CLAUDE_CODE_ENTRYPOINT の値 ('throw' なら env が読めない)。branches は local に在る branch 名の集合 (git show-ref の代わり)
function harness({
  options = {}, entrypoint = 'cli', bridgeOk = true, headRef = 'feat-a', branches = ['feat-a'], gitDir = '/repo/.git',
  monitor = () => ({ result: { taskId: 't1' }, text: 'started' }),
  taskStop = () => ({ result: {}, text: 'stopped' }),
  archive = () => ({ result: {}, text: 'archived' }),
  send = () => ({ result: {}, text: 'delivered' }),
} = {}) {
  const hooks = {};
  register((event, matcher, h) => {
    if (event === 'tool.call' && typeof matcher === 'object') { assert.deepEqual(matcher, { tool: 'Bash' }); hooks.bash = h; }
    else hooks[event] = matcher;
  }, options);
  const calls = { monitor: [], fetch: [], run: [], stop: [], log: [], archive: [], send: [], sleep: [], env: [] };
  const local = new Set(branches);
  const $ = {
    process: { run: async (argv) => {
      calls.run.push(argv);
      if (argv[0] === 'gh') return headRef === null ? { exitCode: 1, stdout: '', stderr: 'x' } : { exitCode: 0, stdout: `${headRef}\n`, stderr: '' };
      if (argv.includes('--git-common-dir')) return gitDir === null ? { exitCode: 128, stdout: '', stderr: 'not a git repository' } : { exitCode: 0, stdout: `${gitDir}\n`, stderr: '' };
      if (argv.includes('show-ref')) return { exitCode: local.has(argv.at(-1).replace('refs/heads/', '')) ? 0 : 1, stdout: '', stderr: '' };
      throw new Error(`unexpected ${argv}`);
    } },
    env: { get: async (name) => { calls.env.push(name); if (entrypoint === 'throw') throw new Error('no env'); return entrypoint; } },
    http: { fetch: async (url) => { calls.fetch.push(url); if (bridgeOk === 'throw') throw new Error('refused'); return { ok: bridgeOk, status: bridgeOk ? 200 : 503, text: '' }; } },
    tool: { call: async (input) => {
      if (input.tool === 'TaskStop') { calls.stop.push(input.task_id); return taskStop(input); }
      if (input.tool === ARCHIVE) { calls.archive.push(input); return archive(input); }
      if (input.tool === SEND) { calls.send.push(input); return send(input); }
      calls.monitor.push(input); return monitor(input);
    } },
    clock: { sleep: async (ms) => { calls.sleep.push(ms); } },
    ui: { log: (text) => calls.log.push(text) },
  };
  const run = (command, out) => hooks.bash($, { tool: 'Bash', tool_use_id: 'u1', command }, async () => out);
  const archiveCall = (session_id, first = { result: {}, text: 'archived' }) =>
    hooks['tool.call']($, { tool: ARCHIVE, tool_use_id: 'u2', session_id, reason: 'PR merged' }, Object.assign(async () => first, { signal: undefined }));
  const prompt = (text, kind = 'task-notification') =>
    hooks['prompt.submit']($, { text, wait: false, origin: { kind } }, async (e) => ({ text: e.text }));
  const notify = () => prompt('o/r CI #1: queued → completed successfully [feat-a]');
  const receive = (text) => hooks['session.receive']($, { text, origin: { kind: 'peer-send-message' } }, async (e) => ({ text: e.text }));
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  return { run, archiveCall, prompt, notify, receive, settle, calls, local };
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
  assert.match(r.context.join('\n'), /Monitor で繋いだ \(task t1\)。local の branch が消えたら次の Actions 通知で/);
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
  assert.equal(calls.monitor.length + calls.fetch.length + calls.run.length + calls.env.length, 0);
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
  assert.match((await run('gh pr create', PR_OUT)).context[0], /task ID が取れず自動では止められない/);
  assert.equal(calls.monitor.length, 3);
});

test('auto mode の分類器が無判定で断ったら、自分で張れとは言わず 1 行の事実だけ返す', async () => {
  for (const monitor of [() => ({ deny: NO_VERDICT }), () => ({ isError: true, text: NO_VERDICT }), () => { throw new Error(NO_VERDICT); }]) {
    const { run, calls } = harness({ monitor });
    const r = await run('gh pr create --fill', PR_OUT);
    assert.equal(calls.monitor.length, 1);
    assert.equal(r.text, PR_OUT.text);
    assert.deepEqual(r.context, ['pr-bridge-watch: auto mode では hook から Monitor を張れない (分類器が判定を返さない)。https://github.com/ippoan/gh-actions-live/pull/46 の CI は PR の監視か gh pr checks で確認する']);
    assert.doesNotMatch(r.context[0], /Monitor\(\{|gave no verdict|Issue the action again|\n/);
    assert.deepEqual(calls.stop, []);
  }
});

test('無判定以外の拒否 (利用者が断った等) は従来どおり、自分で張る引数を返す', async () => {
  const { run } = harness({ monitor: () => ({ isError: true, text: "The user doesn't want to proceed with this tool use." }) });
  const r = await run('gh pr create --fill', PR_OUT);
  assert.equal(r.context[0], 'pr-bridge-watch: Monitor を張れなかった (The user doesn\'t want to proceed with this tool use.)。自分で Monitor({ ws: { url: "ws://127.0.0.1:8799/watch?repo=ippoan%2Fgh-actions-live&ref=feat-a" }, description: "ippoan/gh-actions-live PR #46 CI [feat-a]", persistent: true, timeout_ms: 3600000 })');
});

test('Claude desktop では Monitor を張ろうとせず (bridge も gh も叩かない)、1 行だけ返す', async () => {
  const { run, calls } = harness({ entrypoint: 'claude-desktop' });
  const r = await run('gh pr create --fill', PR_OUT);
  assert.deepEqual(calls.env, ['CLAUDE_CODE_ENTRYPOINT']);
  assert.equal(calls.monitor.length + calls.fetch.length + calls.run.length, 0);
  assert.equal(r.text, PR_OUT.text);
  assert.deepEqual(r.context, ['pr-bridge-watch: Claude desktop では app が PR の CI を監視するので bridge に Monitor を張らない (https://github.com/ippoan/gh-actions-live/pull/46)']);
  assert.doesNotMatch(r.context[0], /Monitor\(\{|\n/);
});

test('desktop でも PR の URL が出ていなければ何も足さない', async () => {
  const { run, calls } = harness({ entrypoint: 'claude-desktop' });
  const out = { result: {}, text: 'no pull request' };
  assert.equal(await run('gh pr create --fill', out), out);
  assert.equal(calls.env.length, 0);
});

test('entrypoint が無い / 読めないときは従来どおり張る', async () => {
  for (const entrypoint of [undefined, 'throw']) {
    const { run, calls } = harness({ entrypoint });
    const r = await run('gh pr create --fill', PR_OUT);
    assert.equal(calls.monitor.length, 1);
    assert.match(r.context[0], /Monitor で繋いだ \(task t1\)/);
  }
});

test('gh pr view が失敗したら command の --head に落ち、それも無ければ繋がない', async () => {
  const a = harness({ headRef: null, branches: ['feat-z'] });
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

test('Actions 通知のたびに突合し、local の branch が残っている間は止めず、消えたら止める', async () => {
  const { run, notify, settle, calls, local } = harness();
  await run('gh pr create --fill', PR_OUT);
  const r = await notify();
  assert.equal(r.text, 'o/r CI #1: queued → completed successfully [feat-a]');
  await settle();
  assert.deepEqual(calls.stop, []);
  local.delete('feat-a');
  await notify();
  await settle();
  assert.deepEqual(calls.stop, ['t1']);
  assert.match(calls.log[0], /pull\/46 の branch feat-a が local に無い → Monitor \(task t1\) を止めた/);
  await notify();
  await settle();
  assert.deepEqual(calls.stop, ['t1']);
});

test('突合は task-notification のときだけ・見張りがあるときだけ git を叩く', async () => {
  const idle = harness();
  await idle.notify();
  await idle.settle();
  assert.equal(idle.calls.run.length, 0);

  const { run, prompt, settle, calls, local } = harness();
  await run('gh pr create --fill', PR_OUT);
  local.delete('feat-a');
  await prompt('ユーザーの入力', 'composer');
  await settle();
  assert.deepEqual(calls.stop, []);
});

test('local に branch が無い PR (別 clone で作った等) は突合で止めず、そう書く', async () => {
  const { run, notify, settle, calls } = harness({ branches: [] });
  const r = await run('gh pr create --fill', PR_OUT);
  assert.match(r.context[0], /local に branch feat-a が見つからず突合では止まらない/);
  await notify();
  await settle();
  assert.deepEqual(calls.stop, []);
});

test('止めた branch に PR を作り直したら、また張る', async () => {
  const { run, notify, settle, calls, local } = harness();
  await run('gh pr create --fill', PR_OUT);
  local.delete('feat-a');
  await notify();
  await settle();
  local.add('feat-a');
  await run('gh pr create --fill', PR_OUT);
  assert.equal(calls.monitor.length, 2);
});

test('自分自身の archive の前に全部の Monitor を止め、archive はそのまま通す', async () => {
  const { run, archiveCall, calls } = harness();
  await run('gh pr create --fill', PR_OUT);
  const r = await archiveCall('self');
  assert.equal(r.text, 'archived');
  assert.deepEqual(calls.stop, ['t1']);
  assert.match(calls.log[0], /のセッションを archive する → Monitor \(task t1\) を止めた/);
});

test('TaskStop が拒否されても自分の archive は止めず、止められなかったと log に残す', async () => {
  const { run, archiveCall, calls } = harness({ taskStop: () => ({ deny: 'no such task' }) });
  await run('gh pr create --fill', PR_OUT);
  assert.equal((await archiveCall('self')).text, 'archived');
  assert.match(calls.log[0], /止められなかった \(no such task\)/);
});

test('他のセッションの archive が通れば何もしない', async () => {
  const { archiveCall, calls } = harness();
  assert.equal((await archiveCall('abc')).text, 'archived');
  assert.equal(calls.send.length + calls.archive.length, 0);
});

test('他のセッションの archive が live work で断られたら、停止要求を送って 1 回やり直す', async () => {
  const { archiveCall, calls } = harness();
  const r = await archiveCall('abc', REFUSED);
  assert.deepEqual(calls.send, [{ tool: SEND, session_id: 'abc', message: STOP_REQUEST }]);
  assert.deepEqual(calls.sleep, [STOP_REQUEST_WAIT_MS]);
  assert.deepEqual(calls.archive, [{ tool: ARCHIVE, session_id: 'abc', reason: 'PR merged' }]);
  assert.equal(r.text, 'archived');
  assert.match(r.context[0], /やり直して畳めた/);
});

test('やり直しても断られたら、その結果に書き添えて返す', async () => {
  const { archiveCall } = harness({ archive: () => REFUSED });
  const r = await archiveCall('abc', REFUSED);
  assert.equal(r.isError, true);
  assert.match(r.context[0], /まだ畳めない/);
});

test('pinned 等の live work 以外の拒否・send_message の失敗ではやり直さない', async () => {
  const pinned = { isError: true, text: 'Session abc was not archived: it is pinned.' };
  const a = harness();
  assert.equal(await a.archiveCall('abc', pinned), pinned);
  assert.equal(a.calls.send.length, 0);
  const b = harness({ send: () => ({ isError: true, text: 'cannot deliver' }) });
  assert.equal(await b.archiveCall('abc', REFUSED), REFUSED);
  assert.equal(b.calls.archive.length, 0);
});

test('停止要求を session.receive で受けたら全部止め、turn を起こさず飲み込む', async () => {
  const { run, receive, calls } = harness();
  await run('gh pr create --fill', PR_OUT);
  const r = await receive(STOP_REQUEST);
  assert.match(r.consumed, /停止要求/);
  assert.deepEqual(calls.stop, ['t1']);
  assert.deepEqual(await receive('ふつうのメッセージ'), { text: 'ふつうのメッセージ' });
});

test('停止要求が prompt.submit に来ても全部止めて drop する (見張りが無くても飲み込む)', async () => {
  const h = harness();
  await h.run('gh pr create --fill', PR_OUT);
  const r = await h.prompt(`From 親: ${STOP_REQUEST}`, 'peer');
  assert.match(r.drop, /停止要求/);
  assert.deepEqual(h.calls.stop, ['t1']);
  const empty = harness();
  assert.match((await empty.prompt(STOP_REQUEST, 'peer')).drop, /停止要求/);
});
