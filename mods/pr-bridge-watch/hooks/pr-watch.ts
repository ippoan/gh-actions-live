// 純粋な判定だけを置く (engine の `$` に触らない)。node --test から直接 import する。

/** PR を作る Bash か。`gh pr create` 直打ちと claude-skills の pr-push.sh */
export function isPrCreateCommand(command: string): boolean {
  return /\bgh\s+pr\s+create\b/.test(command) || /\bpr-push(\.sh)?\b/.test(command)
}

export type PullRef = { repo: string; number: number; url: string }

/** 出力に出た PR の URL (重複は 1 つに畳む) */
export function pullRefsOf(text: string): PullRef[] {
  const seen = new Map<string, PullRef>()
  for (const m of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) {
    const url = m[0]
    if (!seen.has(url)) seen.set(url, { repo: m[1]!, number: Number(m[2]), url })
  }
  return [...seen.values()]
}

/** `--head X` / `-H X` / `--head=X` を command から拾う (gh pr view が失敗したときの保険) */
export function headOfCommand(command: string): string | null {
  const m = command.match(/(?:--head|-H)(?:=|\s+)(["']?)([^\s"']+)\1/)
  return m ? m[2]! : null
}

/**
 * bridge の /watch URL。`ws://127.0.0.1:8799` → `ws://127.0.0.1:8799/watch?repo=…&ref=…`。
 * ref の 40 文字切りは bridge 側がやる (watch.rs) のでここでは切らない
 */
export function watchUrlOf(bridge: string, repo: string, ref: string): string {
  const base = bridge.replace(/\/+$/, '')
  return `${base}/watch?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`
}

/** bridge の状態 (`GET /`) を叩く http URL */
export function statusUrlOf(bridge: string): string {
  return bridge.replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '') + '/'
}

/** `gh pr view --json state` の値で、見張りを畳んでよい (もう CI を待たない) か */
export function isPrClosedState(state: string): boolean {
  return state === 'MERGED' || state === 'CLOSED'
}

export const ARCHIVE_TOOL = 'mcp__ccd_session_mgmt__archive_session'

/** `archive_session` がこのセッション自身を畳む呼び出しか */
export function isSelfArchive(tool: string, input: { session_id?: unknown }): boolean {
  return tool === ARCHIVE_TOOL && input.session_id === 'self'
}
