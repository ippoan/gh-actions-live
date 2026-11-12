# CLAUDE.md — ippoan/gh-actions-live

Chrome 拡張 (`extension/`。Linux の headless Chromium = `linux-browser/` が作業ツリーから直接読む) + Linux 側リレー (`bridge/`)。
使い方・運用は `gh-actions-live` skill (ippoan/claude-skills)、設計の経緯は README と issue。

## repo-policy
- **PR を出して CI が緑 = auto-merge**。merge 前に止めたいなら draft で出す。Release / tag は出さない
- `Closes #N` 禁止、`Refs #N`。branch は `<type>-<topic>` か `<issue>-<type>-<topic>`
- merge 済み branch への push は hook が止める。新 branch は **別コマンドで** `git checkout main` してから切る

## 触るときの罠 (全部実機で踏んだ)
- `manifest.json`: `key` を変えると拡張 ID が変わり、`linux-browser/chromium.sh` の `EXT_ID` と README がずれる
- **alive の WebSocket は github.com のタブ (content script `alive-relay.js`) が持つ。**
  拡張ページ (`chrome-extension://`) から張ると Origin で弾かれ握手直後に 1006。
  DNR の `modifyHeaders` では websocket 握手の Origin を変えられない (v0.0.19 で実測・失敗)。
  background が pinned タブを用意し、ダッシュボードは socket URL と購読トークンを渡すだけ
  alive タブを閉じる / github.com 外へ遷移 / discard されたら background が `alive-status closed (reason: tab-closed|tab-gone)`
  をダッシュボードへ送り、watchdog が即張り直す (#36)。content script は自分では closed を post できない
- **拡張の reload は background の `reloadSelf()` に一本化。ダッシュボードのタブを `about:blank` に
  差し替えてから `chrome.runtime.reload()` し、`onInstalled` で同じタブ (`reopenTabId`) に読み込み直す。**
  reload はページを殺すがウィンドウは閉じないので、何もせず reload → `onInstalled` の
  `reopenDashboard` が新しい popup を開く = 空ウィンドウが 1 枚残る (#30)。
  かといって `tabs.remove` で閉じると復活が `windows.create` の新規ウィンドウになり、reload 直後の
  service worker からでは**前面に出ない** (#32)。
  差し替えならウィンドウの位置も z 順もそのままで、Chrome 最後の 1 枚でも Chrome が落ちない。
  ダッシュボードの「再読込」は background へ `command:'reload'` を送るだけ (自分で reload しない)。
  保険として `openDashboard()` は既存タブに `{target:'dashboard',type:'ping'}` を打ち、
  無応答なら `chrome.tabs.reload` で**同じウィンドウ**に読み込み直す。新規に `windows.create`
  したときも直後に `windows.update({focused, drawAttention, state:'normal'})` をもう一度打つ
- **Actions ページの run 一覧は `react-app.embeddedData` の JSON から読む** (`run-row.js` の `runsFromEmbedded`)。
  ログイン中は React 版しか返らず `check_suite_` の行も run の data-channel も無い (#52)。`?react=false` で旧 UI を
  取る回避は 2026-10-21 に GitHub に無視されるようになり、全 repo が「0 runs / 読み込み中…」に戻った。
  購読 channel (`workflow_runs:` / `check_suites:`) も JSON の `aliveChannel` にある。state は旧 aria-label の
  文言 (`completed successfully` / `failed` / `currently running` …) に直して渡す (bridge の正規表現が見る)。
  1 run の partial (`/actions/workflow-run/<id>` + XHR ヘッダ) は旧形式の行のままなので `parseRow` で読む
- `dashboard.js`: alive 切断時の再接続は指数バックオフ。無条件に `boot()` を呼ぶと 5 秒周期ポーリングになる
- **`connected:true` / `ws.send()` の成功は socket が生きている証明にならない** (#28)。half-open だと
  readyState は OPEN のまま、send も例外を投げず、20 分 boot の購読し直しも成功して見える。
  生死の判断材料は受信時刻だけ: relay の `lastFrameAt` / `sinceLastFrameMs`、watchdog の
  `lastMessageAt` / `idleMs`。閾値 (`idleLimitMs`、既定 10 分) を超えたら `reset('idle')` で
  close → connect して確かめる。status に全部載っている。
  再接続の判断は `alive-watchdog.js` (純粋モジュール・`npm test` で回る) に集約。connect を頼んだら必ず
  watchdog を張る。「`closed`/`error` が来たときだけ再接続」に戻すと CONNECTING で固まって死ぬ (#25)
- `background.js` の `relayToDashboard` は `{ ...msg, target: 'dashboard' }` (target を後勝ち)。relay の msg には
  `target:'background'` が付いているので逆にすると dashboard が全部捨て、push が一切届かなくなる (#25 の真因、#23〜v0.0.22)
- **bridge (`bridge/`、Rust) は systemd --user で 1 本だけ常駐させる。セッションの Monitor で起動しない。**
  セッションが起動していた頃は 8799 を取り合い、起動したセッションが終わると bridge ごと落ち、
  全 repo の変化がそのセッションにだけ流れた。セッションは `ws /watch?repo=…&run=…` に繋いで絞る。
  拡張側のプロトコル (`/?role=extension`、`{"type":"ping"}` の keepalive、`POST /cmd`) は Node 版と同じに保つ
  (変えると拡張の更新が要る)。/watch への keepalive は Ping フレーム (テキストにすると通知になる)
- **ログイン切れは拡張の `{type:"login", loggedIn, user}` で bridge に知らせる。** 判定は `extension/login-state.js` (純粋)。
  boot 1 周で読めた Actions ページと 404 の本文 (未ログインだと private repo は 404) の `meta[name=user-login]` を見て、
  変わったときと bridge へ繋ぎ直した直後 (hello の後) に送る。bridge は `logged_in` が変わったときだけ /watch に 1 行
  (起動直後の初回 true は流さない)。`login` を送らない古い拡張では None のまま何も起きない
- **bridge の `POST /mcp` (#62) は一覧のウィジェット専用の読み取り口。** 判定と整形は `bridge/src/mcp.rs` の純粋関数
  (`dashboard` / `summary` / `handle`) に置き、`lib.rs` は Hub の写しを渡すだけ。ウィジェット (`bridge/widget/dashboard.html`) は
  Windows のデスクトップアプリの iframe に出るので Linux の bridge へ直接 ws を張らない (5 秒ごとの `callServerTool`)。
  モデル向けの `actions_dashboard` に `structuredContent` を付けない (Claude Code はそれをテキストの代わりにモデルへ渡し、
  全 repo 分 9 万字が上限超えで退避された)。ビューのデータは app 専用の `actions_dashboard_data` から。
  見た目と並びは `extension/dashboard.js` の `card()` / `render()` / `MAX_CARDS_PER_REPO` と揃える (片方だけ変えない)。
  右側パネル (`mods/pr-bridge-watch/hooks/pane.tsx`) も `resources/read` で読む。見た目と `ago`/`elapsed` は widget/dashboard.html と揃える
  (`pr-watch.ts` の `ago`/`elapsed` を widget から取り出して突き合わせるテストがある)。
  **ウィジェットの HTML を変えたら connector を繋ぎ直す** (claude.ai は接続時に `ui://` を先読みして保存し、セッションをまたいで
  使い回す。bridge の入れ替えでも新しいセッションでも読み直さない)。URI と見出しの版は HTML のハッシュで変わる (`view_uri` / `view_version`)。
  Code タブはウィジェットからの `tools/call` を受けない (`Method not found`) ので、データは `actions_dashboard` の結果の `_meta` で渡す。
  Claude Code のローカル MCP (`claude mcp add`) ではウィジェットは描かれない (公式。テキストだけ)。描くのは claude.ai の custom connector 経由で、
  Tunnel 越しの `/mcp/<合言葉>` だけを外に出す。`tunnel_guard` (cf-ray 付きは `/mcp/` 以外 403) を外さない。
  **GitHub の API を叩く経路を足さない** (レート制限を避けるためブラウザから取る、がユーザーの決定)
- **設定の正本は private repo `ippoan/gh-actions-live-config` の `config.json`** (`seed-config.js` が github.com の cookie で raw を読む)。
  取り込みは**内容ハッシュが変わったときだけ** (毎回上書きすると設定画面 / `set-config` の値が 10 分で戻る)。
  書いたキーだけ上書きするので、`repos: []` のような空値を置くと全 PC の値を消す。
  キーの形の検査は `configPatch` 1 か所 (background / dashboard の `set-config` も使う)。
  private の raw は `raw.githubusercontent.com` へリダイレクトするので `host_permissions` から外さない
- `mods/pr-bridge-watch` (Claude Mod) の module は Node も DOM も無い環境で動く。外界は全部 `$`
  (`$.process.run` / `$.http.fetch` / `$.tool.call`) 経由。判定は `pr-watch.ts` に純粋関数で置き、
  import は `.ts` 拡張子付き (Node 24 の `npm test` が直接読むため)。型 (`/plugin-types`) は build ごとに
  生成し commit しない。API は early access で release ごとに変わりうる → 壊れたら型を再生成して `tsc`
  `hooks.json` の `modules` は 1 plugin に 1 つだけ (2 つ目は validate が拒否) → 入口は `hooks/index.ts` で、`register.ts` と `pane.tsx` を束ねる。
  `$` は変数に代入できない (`plugin validate` が拒否。module が読まれない)。`$.clock.every(…)` 等は閉包 (`Host`) にして渡す。
  persistent な Monitor を残すと `archive_session` が「live work」で畳めない → 止めどきは
  Actions 通知ごとの local branch 突合 / self-archive の直前 / 他セッションの archive 拒否時の停止要求 (`[pr-bridge-watch:stop]`)
  **desktop (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`) でも張る** — app が知らせるのは Auto-fix オンの PR の失敗だけで、
  CI の成功・merge は届かない (#51 の「app が監視するから張らない」は誤り)。**auto mode では hook から張れない**
  (hook 発の Monitor に分類器が判定を返さない) → desktop なら引数つきで「自分で張れ」を返す (model の張った ws Monitor は通る)、
  それ以外は 1 行の事実だけ。desktop の Monitor は `persistent` 無し・`timeout_ms` 30 分上限 (CLI の引数だと schema で弾かれる)。無判定の判定は文面頼み (`isAutoModeNoVerdict`) → 文面が変わったらテストの `NO_VERDICT` ごと直す (#50)

- **`linux-browser/` は拡張を Linux の headless Chromium に載せる一式 (#62)。** snap の Chromium (Playwright 同梱は sandbox 無しで落ちる)、
  プロファイルは `~/snap/chromium/common/` (snap は `$HOME` の隠しディレクトリを読めない)、CDP は `127.0.0.1:9223` だけ
  (Tailscale の IP 等へ出すと分類器に [Expose Local Services] で止められるし、ログイン済みブラウザの全権になる)。
  同じプロファイルを 2 つの Chromium で開けない (SingletonLock) ので、ログインは常駐プロセスの CDP を使う (`github-login.sh`)。
  2FA は GitHub Mobile (パスキーは headless で使えない)。数字は JS で後から描かれるので待って読む
  **プロファイルのデベロッパー モードはオンにしておく** (`chromium.sh` が起動直後に `developer-mode.mjs` で入れる)。オフだと
  `chrome.runtime.reload()` (再読込 / bridge の `reload`) で拡張が UNPACKED として入り直し、`unsupportedDeveloperExtension`
  (disable_reasons `1<<24`) で無効化されて service worker ごと消える (Chrome 133+ の「unpacked はデベロッパー モードのときだけ」)。
  起動時は `--load-extension` の分だけ有効になるので、壊れるのは reload したときだけ。止まったら
  `node linux-browser/developer-mode.mjs` で戻る (再起動不要)

## 検証
- CI: JS 構文 / `npm test` / manifest 整合 / 参照ファイル実在 / bridge の `cargo test`
- 実機でしか分からないもの: alive の接続・reload 後の復帰。bridge の `status` で見る
