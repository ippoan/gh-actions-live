import type { EngineInterface, Register } from 'claude-code'

import { headOfCommand, isPrCreateCommand, pullRefsOf, statusUrlOf, watchUrlOf } from './pr-watch.ts'

const DEFAULT_BRIDGE = 'ws://127.0.0.1:8799'

/**
 * PR を作る Bash (`gh pr create` / pr-push.sh) を包み、成功して PR の URL が出たら
 * その branch の CI を gh-actions-bridge の `ws /watch?repo=…&ref=…` に Monitor で繋ぐ。
 *
 * bridge は systemd --user の常駐 1 本 (CLAUDE.md)。ここでは起動も kill もしない。
 * 繋げなかったとき (bridge が落ちている / Monitor が拒否された) は、model への context に
 * 自分で張る Monitor の引数を書いて返す — 見張りが黙って欠けるより model に拾わせる。
 */
export const register: Register = (on, options) => {
  const bridge = typeof options.bridgeUrl === 'string' && options.bridgeUrl !== '' ? options.bridgeUrl : DEFAULT_BRIDGE
  // 同じセッションで同じ branch を二重に見張らない (pr-push.sh の再実行・PR の作り直し)
  const watching = new Set<string>()

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isPrCreateCommand(e.command)) return next(e)

    const result = await next(e)
    if (result.deny !== undefined || result.isError) return result

    const notes: string[] = []
    for (const pr of pullRefsOf(result.text ?? '')) {
      const ref = (await headRefOf($, pr.url)) ?? headOfCommand(e.command)
      if (ref === null) {
        notes.push(`pr-bridge-watch: ${pr.url} の branch が分からず bridge に繋いでいない`)
        continue
      }
      const key = `${pr.repo}#${ref}`
      if (watching.has(key)) continue

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
        watching.add(key)
        const taskId = (started.result as { taskId?: unknown } | undefined)?.taskId
        notes.push(
          `pr-bridge-watch: ${pr.url} の CI を bridge の /watch (repo=${pr.repo} ref=${ref}) に Monitor で繋いだ` +
            (typeof taskId === 'string' ? ` (task ${taskId})。` : '。') +
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
async function headRefOf($: EngineInterface, url: string): Promise<string | null> {
  try {
    const r = await $.process.run(['gh', 'pr', 'view', url, '--json', 'headRefName', '--jq', '.headRefName'], {
      timeoutMs: 15000,
    })
    const ref = r.stdout.trim()
    return r.exitCode === 0 && ref !== '' ? ref : null
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
