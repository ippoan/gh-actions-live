import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { RepoRuns, View, Watched } from '../state'
import { ago, dataUriOf, elapsed, isPrCreateCommand, jst, mcpUrlOf, pullRefsOf, repoOfRemoteUrl, sinceOf } from './pr-watch.ts'

const DEFAULT_BRIDGE = 'ws://127.0.0.1:8799'
const PANE = 'actions-pane'
const TITLE = 'GitHub Actions'
const POLL_MS = 5000

const watched = atom({ plugin: 'pr-bridge-watch', key: 'watched' } as const, [] as Watched[], { shape: 'watched-1' })
const view = atom({ plugin: 'pr-bridge-watch', key: 'view' } as const, { repos: [], fetchedAt: 0, error: '' } as View, {
  shape: 'view-1',
})

/**
 * PR を作った repo の GitHub Actions の run を、Code タブの右側パネルに 5 秒ごとに出す (#62)。
 * データは bridge の `POST /mcp` に `resources/read` (`gh-actions-live://dashboard?repo=&since=`) を投げて読む。
 * GitHub の API は叩かない。見た目と ago / elapsed は bridge/widget/dashboard.html と揃える。
 * パネルは PR を作ったときと `/actions-pane` のときだけ開く
 */
export const register: Register = (on, options) => {
  const bridge = typeof options.bridgeUrl === 'string' && options.bridgeUrl !== '' ? options.bridgeUrl : DEFAULT_BRIDGE
  const mcp = mcpUrlOf(bridge)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'actions-pane', description: 'GitHub Actions のパネルを開く (引数に owner/repo で追加)' })
    $.clock.every(POLL_MS, async () => {
      const list = await read($, watched)
      if (list.length === 0) return
      const repos: RepoRuns[] = []
      let error = ''
      for (const w of list) {
        try {
          const r = await $.http.fetch(mcp, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: dataUriOf(w.repo, w.since) } }),
          })
          const text = JSON.parse(r.text)?.result?.contents?.[0]?.text
          const d = typeof text === 'string' ? JSON.parse(text) : null
          for (const g of d?.repos ?? []) repos.push({ repo: g.repo, runs: g.runs ?? [] })
        } catch (err) {
          error = `bridge に届かない: ${String(err)}`
        }
      }
      const fetchedAt = await $.clock.now()
      await update($, view, () => ({ repos, fetchedAt, error }))
    })
    return next(e)
  })

  on('command.run', { command: 'actions-pane' }, async ($, e) => {
    const arg = String((e as { args?: unknown }).args ?? '').trim()
    // 引数なしなら、セッションの cwd の git remote (origin) から repo を引く
    let repo: string | null = arg
    if (arg === '') {
      try {
        const r = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 15000 })
        repo = r.exitCode === 0 ? repoOfRemoteUrl(r.stdout) : null
      } catch {
        repo = null
      }
    }
    if (repo !== null && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
      const since = sinceOf(await $.clock.now())
      const add = repo
      await update($, watched, list => [...list.filter(w => w.repo !== add), { repo: add, since }])
    }
    await $.ui.open({ id: PANE, title: TITLE })
    if (repo) return { text: `${repo} をパネルに足した` }
    return { text: 'パネルを開いた (/actions-pane owner/repo で足せる)' }
  })

  // PR を作ったら、その repo をその時刻からパネルに出す (gh pr create と pr-push.sh)
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isPrCreateCommand(e.command)) return next(e)
    const result = await next(e)
    if (result.deny !== undefined || result.isError) return result
    const repos = [...new Set(pullRefsOf(result.text ?? '').map(pr => pr.repo))]
    if (repos.length === 0) return result
    const since = sinceOf(await $.clock.now())
    await update($, watched, list => [...list.filter(w => !repos.includes(w.repo)), ...repos.map(repo => ({ repo, since }))])
    void $.ui.open({ id: PANE, title: TITLE })
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const v = await read($, view)
    const list = await read($, watched)
    // 「今」は最後に取りに行った時刻 (render の中で時計を読まない)
    const now = v.fetchedAt
    if (list.length === 0) return <Text dimColor>PR を出すと、その repo の CI がここに出る (/actions-pane owner/repo でも足せる)</Text>
    return (
      <Box flexDirection="column">
        <Text dimColor>更新 {v.fetchedAt ? jst(v.fetchedAt) : '—'}</Text>
        {v.error !== '' && <Text color="red">{v.error}</Text>}
        {v.repos.map(g => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{g.repo}</Text>
            {g.runs.length === 0 && <Text dimColor>まだ run が無い</Text>}
            {g.runs.map(r => (
              <Box flexDirection="column">
                <Text>
                  <Text color={r.state === 'bad' ? 'error' : r.state === 'run' ? 'warning' : r.state === 'ok' ? 'success' : 'inactive'}>●</Text>{' '}
                  <Link href={r.href}>{`${r.workflow} #${r.run}`}</Link>
                  {r.ref ? <Text dimColor>{` ${r.ref}`}</Text> : ''}
                </Text>
                <Text dimColor>
                  {'   '}
                  {r.status}
                  {r.state === 'run' ? (r.at ? ` · ⏱ ${elapsed(r.at, now)}` : '') : r.duration ? ` · ⏱ ${r.duration}` : ''}
                  {r.at ? ` · ${ago(r.at, now)}` : ''}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {'   '}
                  {r.title}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
