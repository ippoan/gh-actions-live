import type { EngineInterface, ProcessRunInit, ProcessRunResult, Register, Timer, ToolCallResult } from 'claude-code'

import {
  headOfCommand,
  isPrClosedState,
  isPrCreateCommand,
  isSelfArchive,
  pullRefsOf,
  statusUrlOf,
  watchUrlOf,
} from './pr-watch.ts'

const DEFAULT_BRIDGE = 'ws://127.0.0.1:8799'
/** PR の state を見に行く間隔。merge / close から Monitor を止めるまでの最大の遅れ */
export const PR_POLL_MS = 60_000

type Watch = { pr: string; taskId: string | null; timer: Timer | null }

/** timer から先で使う engine の口。`$` は変数に持てない (plugin validate が拒否する) ので閉包で持つ */
type Host = {
  every: (ms: number, fn: () => void) => Timer
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  taskStop: (taskId: string) => Promise<ToolCallResult>
  log: (text: string) => void
}

function hostOf($: EngineInterface): Host {
  return {
    every: (ms, fn) => $.clock.every(ms, fn),
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
 * `ref` の /watch は bridge が閉じない。一方 `archive_session` は生きた background task を
 * 持つセッションを畳まない ("still has live work")。放っておくと Monitor が archive を塞ぐので、
 * PR が MERGED / CLOSED になったら TaskStop し、自分自身の archive の前にも止める。
 */
export const register: Register = (on, options) => {
  const bridge = typeof options.bridgeUrl === 'string' && options.bridgeUrl !== '' ? options.bridgeUrl : DEFAULT_BRIDGE
  // repo#ref → 見張り。同じセッションで同じ branch を二重に見張らない (pr-push.sh の再実行・PR の作り直し)
  const watches = new Map<string, Watch>()
  // timer は dispatch を越えて走るので、session.start の $ の閉包に載せる (diff mod の bind と同じ)
  let bound: Host | null = null

  const stopWatch = async (host: Host, key: string, why: string) => {
    const w = watches.get(key)
    if (w === undefined) return
    watches.delete(key)
    w.timer?.cancel()
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

  const pollUntilClosed = (host: Host, key: string, pr: string): Timer => {
    let busy = false
    return host.every(PR_POLL_MS, () => {
      if (busy) return
      busy = true
      void prStateOf(host, pr)
        .then(state => (state !== null && isPrClosedState(state) ? stopWatch(host, key, `が ${state}`) : undefined))
        .finally(() => {
          busy = false
        })
    })
  }

  on('session.start', ($, e, next) => {
    bound = hostOf($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!isSelfArchive(e.tool, e as { session_id?: unknown }) || watches.size === 0) return next(e)
    const host = hostOf($)
    await Promise.all([...watches.keys()].map(key => stopWatch(host, key, 'のセッションを archive する')))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isPrCreateCommand(e.command)) return next(e)

    const result = await next(e)
    if (result.deny !== undefined || result.isError) return result

    const notes: string[] = []
    for (const pr of pullRefsOf(result.text ?? '')) {
      const ref = (await headRefOf(hostOf($), pr.url)) ?? headOfCommand(e.command)
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
        const timer = taskId === null ? null : pollUntilClosed(bound ?? hostOf($), key, pr.url)
        watches.set(key, { pr: pr.url, taskId, timer })
        notes.push(
          `pr-bridge-watch: ${pr.url} の CI を bridge の /watch (repo=${pr.repo} ref=${ref}) に Monitor で繋いだ` +
            (taskId === null
              ? '。task ID が取れず自動では止められない — PR が閉じたら TaskStop すること (残すと archive_session が畳めない)。'
              : ` (task ${taskId})。PR が MERGED / CLOSED になるか、このセッションを archive するときに自動で止める。`) +
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
  return ghPrField(host, url, 'headRefName')
}

/** PR の state (OPEN / MERGED / CLOSED)。取れなければ null (次の周期でもう一度見る) */
async function prStateOf(host: Host, url: string): Promise<string | null> {
  return ghPrField(host, url, 'state')
}

async function ghPrField(host: Host, url: string, field: string): Promise<string | null> {
  try {
    const r = await host.run(['gh', 'pr', 'view', url, '--json', field, '--jq', `.${field}`], { timeoutMs: 15000 })
    const value = r.stdout.trim()
    return r.exitCode === 0 && value !== '' ? value : null
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
