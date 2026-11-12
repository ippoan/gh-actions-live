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

declare module 'claude-code' {
  interface PluginState {
    'pr-bridge-watch': { watched: Shaped<Watched[]>; view: Shaped<View> }
  }
}
