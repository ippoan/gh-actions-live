// 右側パネル (hooks/pane.tsx) が $.state に置く値の契約。types/ は /plugin-types の生成物 (commit しない) なのでここに置く
export type Watched = { repo: string; since: string }
export type Run = {
  workflow: string
  run: string
  status: string
  state: string
  title: string
  ref: string
  href: string
  at: string
  duration: string
}
export type RepoRuns = { repo: string; runs: Run[] }
export type View = { repos: RepoRuns[]; fetchedAt: number; error: string }
/** Release Wave の切り替え待ち 1 行 (ci-dashboard の release_wave_pending_state の unified。#83) */
export type Pending = {
  repo: string
  worker_name: string | null
  version_id: string
  tag: string | null
  uploaded_at: string
  source: string
  rollback_tag: string | null
  rollback_to: string | null
}
/** armed = 確定待ちの行の key、busy = 送信中の行の key、msg = 直近の Flip の結果 */
export type Wave = { rows: Pending[]; fetchedAt: number; error: string; armed: string; busy: string; msg: string }

declare module 'claude-code' {
  interface PluginState {
    'pr-bridge-watch': { watched: Shaped<Watched[]>; view: Shaped<View>; wave: Shaped<Wave> }
  }
}
