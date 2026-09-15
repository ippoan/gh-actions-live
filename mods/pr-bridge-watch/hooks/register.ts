import type { EngineInterface, ProcessRunInit, ProcessRunResult, Register, ToolCallResult } from 'claude-code'

import {
  ARCHIVE_TOOL,
  archiveTargetOf,
  headOfCommand,
  isLiveWorkRefusal,
  isPrCreateCommand,
  isSelfArchive,
  isStopRequest,
  pullRefsOf,
  SEND_MESSAGE_TOOL,
  statusUrlOf,
  STOP_REQUEST,
  watchUrlOf,
} from './pr-watch.ts'

const DEFAULT_BRIDGE = 'ws://127.0.0.1:8799'
/** 停止要求を送ってから archive をやり直すまでの待ち */
export const STOP_REQUEST_WAIT_MS = 3000

/** gitDir: branch の実在を突合する git の共通ディレクトリ。取れなければ null (突合では止めない) */
type Watch = { pr: string; ref: string; gitDir: string | null; taskId: string | null }

/** engine の口。`$` は変数に持てない (plugin validate が拒否する) ので閉包で持つ */
type Host = {
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  taskStop: (taskId: string) => Promise<ToolCallResult>
  log: (text: string) => void
}

function hostOf($: EngineInterface): Host {
  return {
    run: (argv, init) => $.process.run(argv, init),
    taskStop: taskId => $.tool.call({ tool: 'TaskStop', task_id: taskId } as Parameters<typeof $.tool.call>[0]),
    log: text => $.ui.log(text),
  }
}

/**
 * PR を作る Bash (`gh pr create` / pr-push.sh) を包み、成功して PR の URL が出たら
 * その branch の CI を gh-actions-bridge の `ws /watch?repo=…&ref=…` に Monitor で繋ぐ。
 *
 * bridge は systemd --user の常駐 1 本 (CLAUDE.md)。ここでは起動も kill もしない。
 * 繋げなかったとき (bridge が落ちている / Monitor が拒否された) は、model への context に
 * 自分で張る Monitor の引数を書いて返す — 見張りが黙って欠けるより model に拾わせる。
 *
 * `ref` の /watch は bridge が閉じず、persistent な Monitor は `archive_session` を
 * 「still has live work」で断らせる。止めどきは次の 3 つ:
 * - Actions の通知 (task-notification) が来るたびに全部の見張りを突合し、local の branch が
 *   消えていたら TaskStop (PR は親が作る → 子の archive + worktree-janitor で branch が消える → 親の見張りが止まる)
 * - このセッション自身を archive する直前に全部止める
 * - 他のセッションの archive が live work で断られたら、相手へ停止要求を send_message して 1 回やり直す。
 *   受けた側は session.receive / prompt.submit で要求を飲み込み (turn を起こさない)、全部止める
 */
export const register: Register = (on, options) => {
  const bridge = typeof options.bridgeUrl === 'string' && options.bridgeUrl !== '' ? options.bridgeUrl : DEFAULT_BRIDGE
  // repo#ref → 見張り。同じセッションで同じ branch を二重に見張らない (pr-push.sh の再実行・PR の作り直し)
  const watches = new Map<string, Watch>()
  let reconciling = false

  const stopWatch = async (host: Host, key: string, why: string) => {
    const w = watches.get(key)
    if (w === undefined) return
    watches.delete(key)
    if (w.taskId === null) return
    try {
      const r = await host.taskStop(w.taskId)
      const failed = r.deny ?? (r.isError ? r.text : undefined)
      host.log(
        failed === undefined
          ? `pr-bridge-watch: ${w.pr} ${why} → Monitor (task ${w.taskId}) を止めた`
          : `pr-bridge-watch: ${w.pr} ${why} → Monitor (task ${w.taskId}) を止められなかった (${failed})`,
      )
    } catch (err) {
      host.log(`pr-bridge-watch: ${w.pr} ${why} → Monitor (task ${w.taskId}) を止められなかった (${String(err)})`)
    }
  }

  const stopAll = (host: Host, why: string) => Promise.all([...watches.keys()].map(key => stopWatch(host, key, why)))

  /** 全部の見張りを local の branch と突合し、消えた branch の Monitor を止める */
  const reconcile = async (host: Host) => {
    if (reconciling) return
    reconciling = true
    try {
      for (const [key, w] of [...watches]) {
        if (w.gitDir === null) continue
        if ((await branchExists(host, w.gitDir, w.ref)) === false) await stopWatch(host, key, `の branch ${w.ref} が local に無い`)
      }
    } finally {
      reconciling = false
    }
  }

  // Actions の通知 (Monitor の event) が来たら突合する。通知そのものは素通し
  on('prompt.submit', async ($, e, next) => {
    if (isStopRequest(e.text)) {
      await stopAll(hostOf($), 'のセッションに archive の停止要求が来た')
      return { drop: 'pr-bridge-watch: archive の停止要求を受けて Monitor を止めた' }
    }
    if (e.origin.kind === 'task-notification' && watches.size > 0) void reconcile(hostOf($))
    return next(e)
  })

  // 他のセッションの send_message は queue に入る前にここを通る。停止要求なら turn を起こさずに飲み込む
  on('session.receive', async ($, e, next) => {
    if (!isStopRequest(e.text)) return next(e)
    await stopAll(hostOf($), 'のセッションに archive の停止要求が来た')
    return { consumed: 'pr-bridge-watch: archive の停止要求を受けて Monitor を止めた' }
  })

  on('tool.call', async ($, e, next) => {
    const input = e as { session_id?: unknown; reason?: unknown }
    if (isSelfArchive(e.tool, input)) {
      if (watches.size > 0) await stopAll(hostOf($), 'のセッションを archive する')
      return next(e)
    }
    const target = archiveTargetOf(e.tool, input)
    if (target === null) return next(e)

    const result = await next(e)
    if (!result.isError || !isLiveWorkRefusal(result.text ?? String(result.result ?? ''))) return result
    try {
      // ccd の MCP tool は /plugin-types を打った環境によって型に載らないので unknown 経由
      const sent = await $.tool.call({ tool: SEND_MESSAGE_TOOL, session_id: target, message: STOP_REQUEST } as unknown as Parameters<
        typeof $.tool.call
      >[0])
      if (sent.deny !== undefined || sent.isError) return result
      await $.clock.sleep(STOP_REQUEST_WAIT_MS, { signal: next.signal })
      const retried = await $.tool.call({
        tool: ARCHIVE_TOOL,
        session_id: target,
        ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
      } as unknown as Parameters<typeof $.tool.call>[0])
      const note = retried.isError
        ? 'pr-bridge-watch: live work で断られたので相手に Monitor の停止要求を送り 1 回やり直したが、まだ畳めない'
        : 'pr-bridge-watch: live work で断られたので相手に Monitor の停止要求を送り、やり直して畳めた'
      return { ...retried, context: [...(retried.context ?? []), note] } as ToolCallResult
    } catch {
      return result
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isPrCreateCommand(e.command)) return next(e)

    const result = await next(e)
    if (result.deny !== undefined || result.isError) return result

    const host = hostOf($)
    const notes: string[] = []
    for (const pr of pullRefsOf(result.text ?? '')) {
      const ref = (await headRefOf(host, pr.url)) ?? headOfCommand(e.command)
      if (ref === null) {
        notes.push(`pr-bridge-watch: ${pr.url} の branch が分からず bridge に繋いでいない`)
        continue
      }
      const key = `${pr.repo}#${ref}`
      if (watches.has(key)) continue

      const url = watchUrlOf(bridge, pr.repo, ref)
      const description = `${pr.repo} PR #${pr.number} CI [${ref}]`
      const manual = `Monitor({ ws: { url: "${url}" }, description: "${description}", persistent: true, timeout_ms: 3600000 })`

      if (!(await isBridgeUp($, bridge))) {
        notes.push(`pr-bridge-watch: bridge (${statusUrlOf(bridge)}) に届かない。systemctl --user status gh-actions-bridge を確認し、戻ったら ${manual}`)
        continue
      }
      try {
        const started = await $.tool.call({
          tool: 'Monitor',
          description,
          ws: { url },
          persistent: true,
          timeout_ms: 3600000,
        } as Parameters<typeof $.tool.call>[0])
        if (started.deny !== undefined || started.isError) {
          notes.push(`pr-bridge-watch: Monitor を張れなかった (${started.deny ?? started.text})。自分で ${manual}`)
          continue
        }
        const id = (started.result as { taskId?: unknown } | undefined)?.taskId
        const taskId = typeof id === 'string' ? id : null
        const gitDir = await gitDirWithBranch(host, ref)
        watches.set(key, { pr: pr.url, ref, gitDir, taskId })
        const stops =
          taskId === null
            ? '。task ID が取れず自動では止められない — 要らなくなったら TaskStop すること (残すと archive_session が畳めない)。'
            : gitDir === null
              ? ` (task ${taskId})。local に branch ${ref} が見つからず突合では止まらない — 要らなくなったら TaskStop すること (archive 時は自動で止める)。`
              : ` (task ${taskId})。local の branch が消えたら次の Actions 通知で、archive のときはその前に自動で止める。`
        notes.push(
          `pr-bridge-watch: ${pr.url} の CI を bridge の /watch (repo=${pr.repo} ref=${ref}) に Monitor で繋いだ${stops}` +
            'gh run list で polling しない。通知が来なければ拡張の watch 対象 repos (get-config) を確認',
        )
      } catch (err) {
        notes.push(`pr-bridge-watch: Monitor の起動に失敗 (${String(err)})。自分で ${manual}`)
      }
    }
    if (notes.length === 0) return result
    return { ...result, context: [...(result.context ?? []), ...notes] }
  })
}

/** PR の head branch。gh が無い / 失敗したら null (呼び出し側が command の --head に落ちる) */
async function headRefOf(host: Host, url: string): Promise<string | null> {
  try {
    const r = await host.run(['gh', 'pr', 'view', url, '--json', 'headRefName', '--jq', '.headRefName'], { timeoutMs: 15000 })
    const value = r.stdout.trim()
    return r.exitCode === 0 && value !== '' ? value : null
  } catch {
    return null
  }
}

/** セッションの cwd の git 共通ディレクトリ (worktree でも main clone の .git)。そこに branch が在るときだけ返す */
async function gitDirWithBranch(host: Host, ref: string): Promise<string | null> {
  try {
    const r = await host.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 15000 })
    const gitDir = r.stdout.trim()
    if (r.exitCode !== 0 || gitDir === '') return null
    return (await branchExists(host, gitDir, ref)) === true ? gitDir : null
  } catch {
    return null
  }
}

/** true: 在る / false: 無い (branch か git dir ごと消えた) / null: git を走らせられなかった (止めない) */
async function branchExists(host: Host, gitDir: string, ref: string): Promise<boolean | null> {
  try {
    const r = await host.run(['git', `--git-dir=${gitDir}`, 'show-ref', '--verify', '--quiet', `refs/heads/${ref}`], {
      timeoutMs: 15000,
    })
    return r.exitCode === 0
  } catch {
    return null
  }
}

async function isBridgeUp($: EngineInterface, bridge: string): Promise<boolean> {
  try {
    return (await $.http.fetch(statusUrlOf(bridge))).ok
  } catch {
    return false
  }
}
