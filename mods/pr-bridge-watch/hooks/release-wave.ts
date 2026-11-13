// 右側パネルの Release Wave「切り替え待ち (pending flip)」(#83)。engine の `$` には触らず、
// 外界は引数の Host 越しに呼ぶ (node --test から直接 import して偽の Host で回す)。
//
// データと Flip の口は ci-dashboard の /release-wave と同じ。ci-dashboard の `/mcp` は OAuth の bearer、
// HTTP は CF Access の内側にあり mod は token を持たないので、セッションに繋がっている ci-dashboard の
// connector のツール (`mcp__<uuid>__release_wave_pending_state` / `…__release_wave_pending_flip`) を
// `$.tool.call` で呼ぶ。uuid は環境ごとに違うので `$.tool.list()` から名前の末尾で探す。

import type { Pending } from '../state'

export const STATE_SUFFIX = '__release_wave_pending_state'
export const FLIP_SUFFIX = '__release_wave_pending_flip'

/** `$.tool.call` の戻りのうち使う所だけ */
export type CallResult = { deny?: string; isError?: boolean; text?: string }

export type Host = {
  /** `$.tool.list()` の名前 */
  list: () => Promise<{ name: string; mcp?: boolean }[]>
  /** `$.tool.call({ tool, ...input })` */
  call: (tool: string, input: Record<string, unknown>) => Promise<CallResult>
  /** `$.prompt.submit({ text })`。モデルに呼ばせる (許可カードで止まる) */
  submit: (text: string) => Promise<unknown>
}

/** ci-dashboard の connector の pending_state のツール名。無ければ null (connector が繋がっていない) */
export function stateToolOf(tools: { name: string; mcp?: boolean }[]): string | null {
  return tools.find(t => t.mcp !== false && t.name.startsWith('mcp__') && t.name.endsWith(STATE_SUFFIX))?.name ?? null
}

/** 同じ connector の flip のツール名 (`…__release_wave_pending_state` → `…__release_wave_pending_flip`) */
export function flipToolOf(stateTool: string): string {
  return stateTool.slice(0, -STATE_SUFFIX.length) + FLIP_SUFFIX
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/**
 * `release_wave_pending_state` の結果の text (JSON) から `unified` の行。ci-dashboard の画面と同じ並び。
 * 読めない / `error` を返したら throw (呼び手がパネルの赤字にする)
 */
export function pendingRowsOf(text: string): Pending[] {
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch {
    throw new Error(`pending_state の結果が JSON でない: ${text.slice(0, 120)}`)
  }
  const o = d as { unified?: unknown; error?: unknown; code?: unknown }
  if (!Array.isArray(o?.unified)) {
    throw new Error(str(o?.error) ? `${str(o.code) ?? 'error'}: ${o.error}` : 'pending_state の結果に unified が無い')
  }
  return o.unified
    .filter((u): u is Record<string, unknown> => !!u && typeof u === 'object' && str((u as { repo?: unknown }).repo) !== null)
    .map(u => ({
      repo: String(u.repo),
      worker_name: str(u.worker_name),
      version_id: str(u.version_id) ?? '',
      tag: str(u.tag),
      uploaded_at: str(u.uploaded_at) ?? '',
      source: str(u.source) ?? '',
      rollback_tag: str(u.rollback_tag),
      rollback_to: str(u.rollback_to),
    }))
}

/** 1 行の識別子 (ci-dashboard の flipClaimKey と同じ形)。確認待ち・送信中の印に使う */
export function flipKeyOf(p: Pending): string {
  return `${p.repo}::${p.worker_name ?? ''}::${p.version_id}`
}

/** 行の見出し (`owner/repo / worker`) */
export function labelOf(p: Pending): string {
  return p.worker_name ? `${p.repo} / ${p.worker_name}` : p.repo
}

/** version_id の頭 8 文字 (ci-dashboard の short と同じ) */
export function shortId(v: string | null): string {
  return v ? v.slice(0, 8) : '—'
}

/** Flip できるか。tag の無い version は ci-dashboard も押させない */
export function isFlippable(p: Pending): boolean {
  return p.tag !== null
}

/** release_wave_pending_flip の引数。単一 worker の repo は worker_name を付けない */
export function flipArgsOf(p: Pending): { repo: string; worker_name?: string } {
  return p.worker_name ? { repo: p.repo, worker_name: p.worker_name } : { repo: p.repo }
}

/** 許可が要る設定 (ask) で mod から呼べなかったとき、モデルに頼む一文 */
export function flipPromptOf(flipTool: string, p: Pending): string {
  return (
    `[右側パネルで Flip を確定] Release Wave の切り替え待ち ${labelOf(p)} ${p.tag ?? ''} (version ${shortId(p.version_id)}) を 100% に切り替える。` +
    `${flipTool} を ${JSON.stringify(flipArgsOf(p))} で 1 回だけ呼び、結果を 1 行で返す (他の repo は触らない)`
  )
}

/** 全行を読む。connector が無ければ空 + 理由 */
export async function loadPending(host: Host): Promise<{ rows: Pending[]; error: string }> {
  let tool: string | null
  try {
    tool = stateToolOf(await host.list())
  } catch (err) {
    return { rows: [], error: `ツールの一覧が読めない: ${String(err)}` }
  }
  if (tool === null) return { rows: [], error: 'ci-dashboard の connector (release_wave_pending_state) が繋がっていない' }
  try {
    const r = await host.call(tool, {})
    if (r.deny !== undefined) return { rows: [], error: `release_wave_pending_state を呼べない: ${r.deny}` }
    if (r.isError) return { rows: [], error: `release_wave_pending_state が失敗: ${(r.text ?? '').slice(0, 200)}` }
    return { rows: pendingRowsOf(r.text ?? ''), error: '' }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 確定を押した後の Flip。パネルの「Flip → 確定」の 2 段が確認の 1 回。
 * 設定で ask にしてあり mod から呼べない (deny) ときは、モデルに同じ引数で呼ばせる (セッションの許可カードで止まる)
 */
export async function flipPending(host: Host, p: Pending): Promise<string> {
  const label = `Flip ${labelOf(p)} ${p.tag ?? ''}`
  let tool: string | null
  try {
    tool = stateToolOf(await host.list())
  } catch (err) {
    return `${label}: ツールの一覧が読めない (${String(err)})`
  }
  if (tool === null) return `${label}: ci-dashboard の connector が繋がっていない`
  const flipTool = flipToolOf(tool)
  try {
    const r = await host.call(flipTool, flipArgsOf(p))
    if (r.deny !== undefined) {
      await host.submit(flipPromptOf(flipTool, p))
      return `${label}: 許可が要る設定なので会話に頼んだ (許可カードで確定する)`
    }
    if (r.isError) return `${label}: 失敗 ${(r.text ?? '').slice(0, 200)}`
    return `${label}: 送信した (結果は GitHub Actions の Release Wave の run で確認)`
  } catch (err) {
    return `${label}: 失敗 ${String(err)}`
  }
}
