import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Pending, RepoRuns, View, Watched, Wave } from '../state'
import { ago, dataUriOf, elapsed, isPrCreateCommand, jst, mcpUrlOf, pullRefsOf, repoOfRemoteUrl, sinceOf } from './pr-watch.ts'
import { flipKeyOf, flipPending, isFlippable, labelOf, loadPending, shortId } from './release-wave.ts'

const DEFAULT_BRIDGE = 'ws://127.0.0.1:8799'
const PANE = 'actions-pane'
const TITLE = 'GitHub Actions'
const POLL_MS = 5000
/** Release Wave の切り替え待ちは connector 越し (ci-dashboard) なので run より間を空ける: POLL_MS × 6 = 30 秒 */
const WAVE_EVERY = 6

const watched = atom({ plugin: 'pr-bridge-watch', key: 'watched' } as const, [] as Watched[], { shape: 'watched-1' })
const view = atom({ plugin: 'pr-bridge-watch', key: 'view' } as const, { repos: [], fetchedAt: 0, error: '' } as View, {
  shape: 'view-1',
})
const wave = atom(
  { plugin: 'pr-bridge-watch', key: 'wave' } as const,
  { rows: [], fetchedAt: 0, error: '', armed: '', busy: '', msg: '' } as Wave,
  { shape: 'wave-1' },
)

/**
 * PR を作った repo の GitHub Actions の run を、Code タブの右側パネルに 5 秒ごとに出す (#62)。
 * データは bridge の `POST /mcp` に `resources/read` (`gh-actions-live://dashboard?repo=&since=`) を投げて読む。
 * GitHub の API は叩かない。見た目と ago / elapsed は bridge/widget/dashboard.html と揃える。
 * パネルは PR を作ったときと `/actions-pane` のときだけ開く
 *
 * 下に Release Wave の「切り替え待ち」を並べ、行ごとに Flip できる (#83)。データは ci-dashboard の connector の
 * release_wave_pending_state を `$.tool.call` で読む (release-wave.ts)。Flip は「Flip → 確定」の 2 段で確認を 1 回挟む
 */
export const register: Register = (on, options) => {
  const bridge = typeof options.bridgeUrl === 'string' && options.bridgeUrl !== '' ? options.bridgeUrl : DEFAULT_BRIDGE
  const mcp = mcpUrlOf(bridge)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'actions-pane', description: 'GitHub Actions のパネルを開く (引数に owner/repo で追加)' })
    let tick = 0
    $.clock.every(POLL_MS, async () => {
      const list = await read($, watched)
      if (list.length === 0) return
      if (tick++ % WAVE_EVERY === 0) {
        const { rows, error } = await loadPending({
          list: () => $.tool.list(),
          call: (tool, input) => $.tool.call({ tool, ...input } as Parameters<typeof $.tool.call>[0]),
          submit: text => $.prompt.submit({ text }),
        })
        const at = await $.clock.now()
        await update($, wave, w => ({ ...w, rows, error, fetchedAt: at }))
      }
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
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const list = await read($, watched)
    const w = await read($, wave)
    // 「今」は最後に取りに行った時刻 (render の中で時計を読まない)
    const now = v.fetchedAt
    if (list.length === 0) return <Text dimColor>PR を出すと、その repo の CI がここに出る (/actions-pane owner/repo でも足せる)</Text>
    const flip = async (p: Pending) => {
      const key = flipKeyOf(p)
      await update($, wave, x => ({ ...x, armed: '', busy: key, msg: `Flip ${labelOf(p)} ${p.tag ?? ''} を送信中…` }))
      const msg = await flipPending(
        {
          list: () => $.tool.list(),
          call: (tool, input) => $.tool.call({ tool, ...input } as Parameters<typeof $.tool.call>[0]),
          submit: text => $.prompt.submit({ text }),
        },
        p,
      )
      await update($, wave, x => ({ ...x, busy: '', msg }))
    }
    const waveRows = (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>
          Release Wave 切り替え待ち <Text dimColor>{w.fetchedAt ? `${w.rows.length} 件 · 更新 ${jst(w.fetchedAt)}` : '読み込み中…'}</Text>
        </Text>
        {w.error !== '' && <Text color="red">{w.error}</Text>}
        {w.msg !== '' && <Text dimColor wrap="truncate-end">{w.msg}</Text>}
        {w.fetchedAt !== 0 && w.error === '' && w.rows.length === 0 && <Text dimColor>切り替え待ちは無い</Text>}
        {w.rows.map(p => {
          const key = flipKeyOf(p)
          return (
            <Box flexDirection="column">
              <Text>
                <Text color={isFlippable(p) ? 'warning' : 'inactive'}>●</Text> {labelOf(p)}
                <Text dimColor>{` ${p.tag ?? '未tag'}`}</Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                {'   '}
                {`version ${shortId(p.version_id)} · 戻し先 ${p.rollback_tag ?? shortId(p.rollback_to)}`}
                {p.source ? ` · ${p.source}` : ''}
                {p.uploaded_at ? ` · ${ago(p.uploaded_at, w.fetchedAt)}` : ''}
              </Text>
              {!isFlippable(p) ? (
                <Text dimColor>{'   '}tag が無いので Flip できない</Text>
              ) : w.busy === key ? (
                <Text dimColor>{'   '}送信中…</Text>
              ) : w.armed === key ? (
                <Box flexDirection="row">
                  <Text color="warning">{`   ${p.tag} を 100% に切り替える? `}</Text>
                  <Button key={`ok:${key}`} variant="primary" onPress={() => void flip(p)}>
                    確定
                  </Button>
                  <Text> </Text>
                  <Button key={`no:${key}`} onPress={() => void update($, wave, x => ({ ...x, armed: '' }))}>
                    やめる
                  </Button>
                </Box>
              ) : w.busy !== '' ? (
                <Text dimColor>{'   '}他の Flip の送信中</Text>
              ) : (
                <Box flexDirection="row">
                  <Text>{'   '}</Text>
                  <Button key={`flip:${key}`} onPress={() => void update($, wave, x => ({ ...x, armed: key }))}>
                    Flip
                  </Button>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
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
        {waveRows}
      </Box>
    )
  })
}
