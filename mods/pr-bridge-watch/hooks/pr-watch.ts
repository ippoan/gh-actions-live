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

/**
 * PR を作ったら、その repo の run をその時刻以降だけウィジェット (connector の actions_dashboard) で出させる一文 (#62)。
 * since は PR を作った時刻の 1 分前 (作成直後に走り出す CI を取りこぼさないため)。秒より下は落とす
 */
export function dashboardHintOf(repo: string, nowMs: number): string {
  const since = sinceOf(nowMs)
  return `pr-bridge-watch: この PR の CI はウィジェットで見せる。connector「gh-action-live」の actions_dashboard を ` +
    `{ repo: "${repo}", since: "${since}" } で 1 回呼ぶ (全 repo は出さない)`
}

/** PR を作った時刻の 1 分前 (作成直後に走り出す CI を取りこぼさない)。秒より下は落とす */
export function sinceOf(nowMs: number): string {
  return new Date(nowMs - 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
}

/**
 * git remote の URL から `owner/repo`。`https://github.com/o/r(.git)` と `git@github.com:o/r(.git)` (ssh:// も) だけ。
 * github.com 以外は null (`/actions-pane` を引数なしで打ったとき、セッションの repo を引くのに使う)
 */
export function repoOfRemoteUrl(url: string): string | null {
  const m = url
    .trim()
    .match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

/** bridge の `POST /mcp` (右側パネルが resources/read を投げる口)。`ws://127.0.0.1:8799` → `http://127.0.0.1:8799/mcp` */
export function mcpUrlOf(bridge: string): string {
  return statusUrlOf(bridge) + 'mcp'
}

/** bridge の resources/read に渡す、1 repo ぶんの一覧の URI (#74) */
export function dataUriOf(repo: string, since: string): string {
  return `gh-actions-live://dashboard?repo=${encodeURIComponent(repo)}&since=${encodeURIComponent(since)}`
}

/** HH:MM:SS (JST)。module の環境では Intl のタイムゾーンが当てにならないので +9 時間して UTC で読む */
export function jst(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(11, 19)
}

// ago / elapsed は bridge/widget/dashboard.html の同名関数と同じ文言・同じ区切り (片方だけ変えない)。
// 違いは「今」を引数で受けることと、読めない時刻を '' にすることだけ

/** `12秒前` / `3分前` / `2時間前` / `1日前` */
export function ago(at: string, nowMs: number): string {
  const t = Date.parse(at)
  if (!at || Number.isNaN(t)) return ''
  const d = (nowMs - t) / 1000
  if (d < 60) return `${Math.max(0, Math.trunc(d))}秒前`
  if (d < 3600) return `${Math.trunc(d / 60)}分前`
  if (d < 86400) return `${Math.trunc(d / 3600)}時間前`
  return `${Math.trunc(d / 86400)}日前`
}

/** 実行中の run の開始からの経過。`5s` / `1m 5s` / `1h 2m` */
export function elapsed(at: string, nowMs: number): string {
  const t = Date.parse(at)
  if (!at || Number.isNaN(t)) return ''
  const d = Math.max(0, Math.trunc((nowMs - t) / 1000))
  const h = Math.trunc(d / 3600)
  const m = Math.trunc((d % 3600) / 60)
  const s = d % 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`
}

/** bridge の状態 (`GET /`) を叩く http URL */
export function statusUrlOf(bridge: string): string {
  return bridge.replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '') + '/'
}

/**
 * Claude desktop (Code タブ) のセッションか。`CLAUDE_CODE_ENTRYPOINT` の値で見る。
 * desktop の app は Auto-fix オンの PR の失敗しか知らせない (成功・merge は届かない) ので desktop でも bridge に繋ぐ。
 * auto mode で hook の Monitor が無判定になったとき、desktop なら引数つきで model に張らせる
 */
export function isDesktopEntrypoint(entrypoint: string | undefined): boolean {
  return entrypoint === 'claude-desktop'
}

/**
 * auto mode の分類器が、hook の発した tool 呼び出しに判定を返さなかった拒否か。
 * `$.tool.call` の戻りに種別の欄は無いので文面で見る (テストで文面を固定している)
 */
export function isAutoModeNoVerdict(text: string): boolean {
  return /auto mode classifier/i.test(text) && /gave no verdict/i.test(text)
}

export const ARCHIVE_TOOL ='mcp__ccd_session_mgmt__archive_session'
export const SEND_MESSAGE_TOOL = 'mcp__ccd_session_mgmt__send_message'

/** `archive_session` がこのセッション自身を畳む呼び出しか */
export function isSelfArchive(tool: string, input: { session_id?: unknown }): boolean {
  return tool === ARCHIVE_TOOL && input.session_id === 'self'
}

/** 他のセッションを畳む `archive_session` なら、その session_id */
export function archiveTargetOf(tool: string, input: { session_id?: unknown }): string | null {
  return tool === ARCHIVE_TOOL && typeof input.session_id === 'string' && input.session_id !== 'self' ? input.session_id : null
}

/** archive が「まだ動いている (background task 等)」で断られた応答か。pinned / 画面に開いている等の拒否は含めない */
export function isLiveWorkRefusal(text: string): boolean {
  return /was not archived/i.test(text) && /live work|background (task|work)|still working/i.test(text)
}

/** TaskStop が「その task はもう無い」で返った応答か (Monitor が先に終わっていた。bridge の再起動で 1006 等) */
export function isTaskGone(text: string): boolean {
  return /no task found/i.test(text)
}

/** 相手の pr-bridge-watch が拾って Monitor を全部止める合図 (send_message の本文に入れる) */
export const STOP_MARKER = '[pr-bridge-watch:stop]'

export const STOP_REQUEST =
  `${STOP_MARKER} このセッションを archive するので、bridge の /watch に張った Monitor を止めてください。` +
  'pr-bridge-watch が入っていれば自動で処理され、この文はモデルに届きません。届いた場合は TaskStop で Monitor を止めるだけで、返信は不要です。'

export function isStopRequest(text: string): boolean {
  return text.includes(STOP_MARKER)
}
