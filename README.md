# GitHub Actions Live

GitHub の **repo の Actions ページを起点に**、実行状態をポーリングせず受け取る Chrome 拡張。
repo ごとの列 + run カードで並べるので、**同一 repo で並列に走っている run が全部同時に見える**。

## 何をどこから取るか

```
1. GET https://github.com/<owner>/<repo>/actions   (cookie 付き)  = スナップショット
     ├─ .Box-row[id^=check_suite_]        → 全 run (畳まれていない)
     ├─ link[rel=shared-web-socket]       → alive の socket URL
     └─ data-channel                      → 署名済み購読トークン
2. wss://alive.github.com/_sockets/u/<userId>/ws?session=...
     → {"subscribe": {"<トークン>": null}}  →  {"e":"ack","off":"...","health":true}
   **この socket は github.com のタブ (content script) で張る。** 拡張ページから張ると
   Origin が chrome-extension:// になり alive が握手直後に 1006 で切る。
   background が監視対象 repo の Actions ページを pinned タブで開いて場所を用意する
   (pinned タブを閉じても / 他サイトへ移しても background が即ダッシュボードへ `closed` を伝え、数秒で開き直す #36)
3. push が来たら、その run の partial (/actions/workflow-run/<checkSuiteId>, 約 10KB) だけ
   取り直して状態を確定する
```

**別の API を叩かない**のが要点。Actions ページの取得そのものがスナップショットなので、
初期状態を取るための追加エンドポイントは要らない。

3 は GitHub 自身のクライアント (`js-updatable-content` + `data-url`) と同じ方針で、
未文書な push ペイロードの形に依存しないための作り。

## なぜ集約ダッシュボードの WebSocket を使わないか

CI 状態を集約して WebSocket で配信するダッシュボードは珍しくないが、その手の実装は
たいてい **repo あたり「最新の in-progress」と「最新の completed」だけ**に畳んでいる。
一覧としては見やすいが、同一 repo で複数の workflow が並列に走るとそれらが 1 件に潰れる。

同じ tag に対して CI と複数の deploy worker が同時に走るような構成では、
畳まれた側からは 1 本しか見えない。潰れないのは GitHub 自身の alive socket
(`check_suites:<id>` 単位) のほうで、本拡張がそちらを直接読む理由がこれ。

なお webhook 経由の集約は取りこぼしが起きる。実運用の集約基盤が
「一定時間 in_progress のまま残った run を API から取り直す」補償を持っているのは
そのためで、webhook は「来たら早い」が「来ないことがある」経路だと考えたほうがよい。

## なぜブラウザ拡張なのか

| | タブに JS を挿す | Rust / Worker | **拡張** |
|---|---|---|---|
| タブを開いたままにする必要 | 要る | 不要 | 不要 (このウィンドウが本体) |
| セッションを外に持ち出す | 不要 | **`user_session` を貼る必要あり** | **不要** |
| 変化を外に push できる | しにくい | できる | できる |

`user_session` は 2FA を素通りするアカウント全権の資格情報なので、ブラウザの外に出さないのが要点。
拡張は「ブラウザの中」なので、`host_permissions` があれば `fetch` に cookie が自動で付く。

### 認証の境界 (実測)

| | ログイン有 | 無認証 |
|---|---|---|
| `data-channel` トークン | 26 個 | 26 個 (貰える) |
| `link[rel=shared-web-socket]` | あり | **無し** (HTML に alive の言及 0 件) |
| partial `/actions/workflow-run/<id>` | 200 / 10.9KB | **404** |
| フルページ | 200 / 440KB | 200 / 440KB |

→ push はログイン機能。無認証でできるのは HTML / atom のポーリングまで。

## ウィンドウ

ツールバーのアイコンをクリックすると、タブバーもアドレスバーも無い独立ウィンドウで開く。
設定画面から **独立ウィンドウ / 最大化 / 全画面 / タブ** を選べる。

```js
chrome.windows.create({ url, type: 'popup', width: 1280, height: 820 })  // アプリ風
chrome.windows.create({ url, type: 'normal', state: 'maximized' })       // 最大化
chrome.windows.create({ url, type: 'popup',  state: 'fullscreen' })      // 全画面
```

このウィンドウが fetch も WebSocket も描画も全部持つ。service worker は
ウィンドウを開くのと通知を出すだけなので、MV3 の service worker 寿命問題に当たらない。

## インストール

拡張は Linux の headless Chromium で動かす (下の「Linux で拡張を動かす」)。作業ツリーの `extension/` を
`--load-extension` で直接読むので、配布物 (Release / インストーラー) は無い。
更新は作業ツリーを `git pull` してから、ダッシュボードの「再読込」か bridge の `{"command":"reload"}` で拡張を再起動する。

### 共通の設定 (GitHub の private repo)

監視する repo や bridge の URL はブラウザのプロファイルの `chrome.storage` にあり、新しいプロファイルでは空 (0 repos / bridge 未設定) から始まる。
正本は private repo [ippoan/gh-actions-live-config](https://github.com/ippoan/gh-actions-live-config) の `config.json`:

- 拡張は起動時・10 分ごと・ダッシュボードの boot ごとに `https://github.com/<repo>/raw/HEAD/config.json` を
  **github.com のログイン cookie で**読む (PAT 不要。private の raw は `raw.githubusercontent.com` の `?token=` 付き URL へ飛ぶ)
- **内容が変わったときだけ**、書いてあるキーを上書きする。設定画面や `set-config` で変えた値は repo 側が次に変わるまで残る。
  `extension/` に置いた `config.json` (任意。その作業ツリーだけの値) → repo の順に読むので、両方変われば repo が勝つ
- 読めたかは設定画面の「共通設定」行と `get-config` の `remoteConfigStatus` (`ok` / `error` / `hash` / `at`) で見る。
  `HTTP 404` は「そのブラウザで github.com に未ログイン」か「repo が見えない」
- 置き場は `configRepo` (`set-config` か config.json) で差し替えられる。既定は `ippoan/gh-actions-live-config`

### 再読込の手動確認 (実機でしか分からない)

拡張の再起動 (`chrome.runtime.reload()`) は**ページを殺すだけでウィンドウは閉じない**ので、
放っておくと空のウィンドウが 1 枚残る (#30)。かといって先にタブを閉じると、復活が新規ウィンドウに
なり、reload 直後の service worker からでは**前面に出ない** (#32)。
reload は background の `reloadSelf()` に一本化してあり、**先にダッシュボードのタブを
`about:blank` に差し替えてから** reload し、`onInstalled` で**同じタブ**に読み込み直す。
実機で見るのはここ:

1. ダッシュボードを開いた状態で「再読込」→ **同じウィンドウのまま**中身が復活すること
   (空白のウィンドウが増えていない / ウィンドウが消えていない)
2. bridge から `{"command":"reload"}` を送っても同じこと
3. 数秒後に `curl -s localhost:8799/` の `clients` に `extension-bg@127.0.0.1` と `extension@127.0.0.1` が戻ること
   (戻らなければデベロッパー モードがオフ。下の「Linux で拡張を動かす」)

## CI

PR (non-draft) の CI (JS 構文 / `npm test` / manifest / 参照ファイル / bridge の `cargo test`) が全部緑になると、
org 標準の reusable (`ippoan/ci-workflows/.github/workflows/auto-merge.yml`) が squash merge する。
Release も tag も出さない。manifest の `version` は固定 (拡張は作業ツリーから直接読むので版で配らない)。

## リポジトリ構成

```
extension/          MV3 拡張本体 (linux-browser/ の Chromium がこれを直接読む)
bridge/             Claude Code (Linux) 側の常駐リレー (Rust / systemd --user。下記)
linux-browser/      拡張を Linux の headless Chromium で常駐させる一式 (下記)
mods/pr-bridge-watch Claude Mod: PR を作ったら branch の CI を bridge の /watch に繋ぎ、右側パネルに出す (下記)
.claude-plugin/     上の mod を配る plugin marketplace
```

## 既知の制約

- **未テスト**。alive のプロトコル (接続・購読・ack)、認証境界、partial のサイズは
  実機で確認済みだが、拡張として読み込んだ状態での動作確認はまだ。
- push ペイロードの形は未確認。生サンプルを 50 件まで保存して設定画面に出すので、
  形が分かったら `ws.onmessage` を絞り込める。
- `data-channel` のトークンは発行時刻 `t` 入りの時限。20 分ごとにページを取り直して更新する。
- **未文書の内部プロトコル**なので、GitHub 側の変更で黙って壊れうる。

## Linux で拡張を動かす (#62)

拡張 (`extension/`) をそのまま、bridge と同じ Linux の headless Chromium に載せて常駐させる。ログイン済みのブラウザが
Actions ページと alive の push を読む (GitHub の API は叩かない)。
拡張 ID は `manifest.json` の `key` で固定 (`chromium.sh` の `EXT_ID`)。設定は共通設定 (`config.json`) から入る。

```
# 1 回だけ
ln -sfn "$PWD/linux-browser/chromium.sh" ~/.local/bin/gh-actions-browser
cp linux-browser/gh-actions-browser.service ~/.config/systemd/user/
mkdir -p ~/.config/gh-actions-live && echo 'GITHUB_USER=<GitHub のユーザー名>' > ~/.config/gh-actions-live/browser.env
systemctl --user daemon-reload && systemctl --user enable --now gh-actions-browser
linux-browser/github-login.sh        # GitHub にログイン (下)
```

**ログイン** (初回と、切れたとき): `linux-browser/github-login.sh` を端末で起動し、パスワードを貼り付ける (表示されない)。
2FA は GitHub Mobile を選ぶので、アプリで承認する (数字を聞かれたら端末に出る数字を選ぶ)。ログイン済みなら何も聞かずに終わる。
Windows のクリップボードからなら `Get-Clipboard | ssh <user>@<host> <clone>/linux-browser/github-login.sh`。
パスワードは SSH の中だけを通り、どこにも書かない。パスキー / セキュリティキーは headless では使えない。
`linux-browser/github-logout.mjs` はこのブラウザだけをサインアウトする (他の端末は触らない。ログインの試し用)。

- CDP は `127.0.0.1:9223` だけ。ログイン用のスクリプトはここに繋ぐ。**外 (Tailscale の IP 等) へ出さない** — ログイン済みブラウザの全権になる
- snap の Chromium を使う。Playwright 同梱の Chromium は sandbox が使えず起動しない。snap は `$HOME` 直下の隠しディレクトリを読めないので
  プロファイルは `~/snap/chromium/common/gh-actions-live-profile`
- プロファイルの**デベロッパー モードをオンにする** (`chromium.sh` が起動直後に `linux-browser/developer-mode.mjs` で入れる)。
  Chrome 133 からパッケージ化されていない拡張はデベロッパー モードのときだけ有効で、オフのまま「再読込」/ bridge の `reload` を打つと
  拡張が `unsupportedDeveloperExtension` で無効化されて bridge に戻らない (起動時は `--load-extension` の分だけ有効なので気づきにくい)。
  そうなったら `node linux-browser/developer-mode.mjs` で有効に戻る
- GitHub のログインは使っている限り延長される (失効は約 2 週間の無操作か、パスワード変更・セッションの revoke)

## Claude から設定を入れる (github.com 経由)

拡張は `externally_connectable` で `https://github.com/*` からのメッセージを受ける。
Claude in Chrome は github.com のタブで JS を実行できるので、**設定画面を触らずに**
そこから設定を流し込める (bridge URL が未設定でも届く):

```js
// github.com のタブで
chrome.runtime.sendMessage('oaadakmclelmnaieokjbhldfacfckaaj',
  { command: 'set-config', repos: ['owner/repo'], bridgeUrl: 'ws://host:8799', notify: false },
  r => console.log(r));
// command: get-config / open-dashboard / status / alive-reset / reload も同じ経路で使える
```

## Claude Code への途中通知 (bridge)

拡張は GitHub を見ているだけなので、そのままでは Claude Code に何も届かない。
`bridge/` (Rust の常駐サーバー `gh-actions-bridge`) を Linux 側で **1 本だけ** 動かし、拡張からそこへ
**outbound** で WebSocket を張ると双方向になる。Claude Code の各セッションは bridge に**繋ぐだけ**で、
bridge 自体を起動しない (セッションが Monitor で起動していた頃は 8799 を取り合い、起動したセッションが
終わると bridge ごと落ち、全 repo の変化がそのセッションにだけ流れていた)。

```
拡張 (headless Chromium) ──ws://127.0.0.1:8799/?role=extension──▶ gh-actions-bridge (systemd --user)
        ▲                                                              │ ws /watch?repo=…&run=…
        └──── {"type":"command",...} ◀── POST /cmd                     ▼ (条件に合う run だけ、1 フレーム 1 行)
                                                       Claude Code の各セッション (Monitor の ws ソース)
```

導入 (Linux 側、1 回だけ):
```
cargo install --path bridge
cp bridge/gh-actions-bridge.service ~/.config/systemd/user/
systemctl --user enable --now gh-actions-bridge
```
bridge 自体の出力 (全 repo の変化・接続ログ) は `journalctl --user -u gh-actions-bridge -f`。

- 見張り (`/watch`): セッションごとに条件を付けて繋ぐ。一致した run の変化だけがテキストで届く
  ```
  Monitor({ ws: { url: "ws://127.0.0.1:8799/watch?repo=ippoan/rust-alc-api&workflow=CI&run=1619" }, ... })
  ```
  条件は `repo` / `ref` / `run` / `workflow` (部分一致・大小無視) / `by`。同じ key を重ねると OR、違う key は AND。
  例外: workflow 名に `retest` を含む run (`Release Wave Retest`) の失敗は条件に関係なく全 /watch に
  `retest 失敗 (全 watch へ): …` の 1 行で届く (backend の更新で front 側 repo の retest が走るため)。
  条件なしは 400 (全量が流れるのを防ぐ。本当に全部見るなら `all=1`)
  - 繋いだ時点の状態を bridge の写しから出す (進行中の run と、`run` 指定の run)。
    既に終わった run を指定しても待ちぼうけにならない
  - `run` を指定すると、その run が全部終わった時点で bridge が socket を閉じる (= Monitor の見張りが終わる)。
    run 番号は workflow ごとなので `workflow` と併用する。re-run は同じ番号で走り直すので、閉じた後に re-run したら繋ぎ直す
  - GitHub のログインが切れると (拡張が Actions ページの `meta[name=user-login]` で判定) 全 /watch に
    `watch: GitHub のログインが切れた …` の 1 行が届き、切れている間に繋いだ /watch にも最初に 1 回届く。
    戻ったら `watch: GitHub のログインが戻った (<user>)`。bridge の状態 (`GET /`) の `loggedIn` は null (未知) / true / false
  - `ref` は完全一致 (拡張が 40 文字で切るので長い branch 名は先頭 40 文字で比べる)。`ref` だけの見張りは閉じない
  - 拡張 (ダッシュボード) が bridge から外れた / 戻ったときも 1 行出す (目隠しを黙らない)。bridge が落ちれば socket が閉じる
- 一覧を見る (`POST /mcp`、#62): bridge は MCP (Streamable HTTP の stateless JSON) も話す。ツール
  `actions_dashboard` (引数 `repo` は完全一致を優先し無ければ部分一致、`since` はその時刻 (UTC) 以降の run だけ。PR を出したら `repo` + `since` で見る) が、拡張のダッシュボードと同じ見た目のウィジェット
  (MCP Apps、`ui://gh-actions-live/dashboard-<HTML のハッシュ>.html`。見出しにも同じ版 `v<版>+<ハッシュ>` が出る) を Claude の会話の中に出す。ウィジェットは 5 秒ごとに
  ホスト経由でツールを呼び直して bridge の写しを読む (**GitHub の API は叩かない**。データは今までどおり
  ログイン済みのブラウザが流したもの)。モデルには実行中と workflow ごとの最新が赤の run だけを要約で返す。
  ウィジェットが取りに行くのはビュー専用のツール `actions_dashboard_data` (`_meta.ui.visibility: ["app"]`)。
  モデル向けの `actions_dashboard` に `structuredContent` を付けると、Claude Code はテキストの代わりにそちらを
  モデルへ渡し、全 repo 分 (9 万字) が上限超えでファイルに退避されたため分けている。
  **ウィジェットの HTML を変えたら、claude.ai の設定 → Connectors で connector を切断 → 接続し直す。** claude.ai は
  接続したときにウィジェット (`ui://`) を先読みして保存し、セッションをまたいで使い回す。bridge を入れ替えても、
  新しいセッションでも、繋ぎ直すまで古い HTML が描かれる (#62 で 3 回踏んだ。見出しの版で見分けられる)。
  Code タブのアプリはウィジェットからの `tools/call` を受けない (`Method not found`) が、`serverTools` の無いホストではウィジェットが `resources/read` (`gh-actions-live://dashboard?repo=&since=`) で 5 秒ごとに更新する (#74)。
  最初のデータは `actions_dashboard` の結果の `_meta` で渡し、以後はウィジェットが `resources/read` で自分で更新する
  読み取り専用 (書き込みの口は無い)。登録は user scope で 1 回:
  ```
  claude mcp add --transport http --scope user gh-actions-live http://127.0.0.1:8799/mcp
  ```
  bridge を入れ替える (`cargo install --locked --path bridge` → `systemctl --user restart gh-actions-bridge`) と
  全セッションの `/watch` が数秒切れるので、入れ替えと登録はユーザーの承認を取ってから
- **ウィジェットとして描かせるには claude.ai の custom connector に登録する** (#62)。Claude Code (CLI・デスクトップの
  Code タブ) は MCP Apps を描かずテキストだけを出す (公式: "Claude Code calls the tool as text and doesn't render the UI")。
  描くのは claude.ai / Claude デスクトップのチャットで、サーバーは Anthropic 側から https で届く必要がある。そこで:
  1. `~/.config/gh-actions-bridge/env` (0600) に `GH_ACTIONS_BRIDGE_MCP_TOKEN=<32 文字以上のランダム>` を置き、bridge を再起動。
     `POST /mcp/<合言葉>` が開く (未設定・不一致は 404)
  2. Cloudflare Tunnel の ingress に `hostname: <host>` / `path: ^/mcp/` / `service: http://localhost:8799` を足す。
     bridge も `cf-ray` 付き (= Tunnel 経由) の要求は `/mcp/` 以外を 403 にする (`/cmd` や `/watch` を外に出さない)
  3. claude.ai の設定 → Connectors → custom connector に `https://<host>/mcp/<合言葉>` を登録
- 生の JSON が欲しい購読者は `/?role=listener` (繋いだ時点で bridge の写しを snapshot として 1 回受ける。送った JSON は拡張へのコマンド)
- Linux → 拡張 (設定): `curl -X POST localhost:8799/cmd -d '{"command":"set-config","repos":["owner/repo"],"notify":false}'`
  で repo を変えられる。`get-config` で現在値を返す。**repos は全セッション共通**なので、
  自分の PR に絞るのは `set-config` ではなく `/watch` の条件で
- Linux → 拡張: `curl -X POST localhost:8799/cmd -d '{"command":"open-dashboard","mode":"popup"}'`
  でウィンドウを遠隔で開ける。`refresh` / `snapshot` も受ける
- 診断: `curl -X POST localhost:8799/cmd -d '{"command":"status"}'`。ダッシュボードからは
  `{"type":"status", alive:{connected, fails, lastState, lastMessageAt, idleMs, idleLimitMs, idleResets,
  watchdogArmed, idleArmed, reconnectPending, background:{state, lastMessageAt, idleMs, relay:{readyState, tokens, lastFrameAt, sinceLastFrameMs, frames}}}}`、
  service worker からは `{"type":"ack","command":"status", alive:{tab, state, lastMessageAt, idleMs, relay}}` が返る
  (`relay.readyState` は 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED、null = socket 無し)
- **`connected:true` は「生きている」の証明にならない** (#28)。half-open (TCP が静かに死ぬ) だと
  readyState は OPEN のままで `ws.send()` も通るので、購読し直しは成功したように見える。
  生死は **フレームを受け取った時刻** で見る:
  `alive.idleMs` (ダッシュボードが最後にフレームを受けてからの ms) と
  `alive.background.relay.sinceLastFrameMs` (socket を持つ github.com のタブ側の実測)。
  `idleMs` が `idleLimitMs` (既定 10 分) を超えるとダッシュボードが自分で close → connect で張り直し、
  `idleResets` が 1 増える。ダッシュボードのヘッダにも「最終受信 HH:MM:SS」として出る
- 強制再接続: `curl -X POST localhost:8799/cmd -d '{"command":"alive-reset"}'`。relay の socket を閉じ、
  ダッシュボードが張り直す (閉じていれば開く)。`status` が `connected:false` のまま戻らないときに
- 拡張側は **設定画面の「Linux 側リレーの URL」** に `ws://<host>:8799` を入れる
- service worker も 1 本張っていて、ダッシュボードが閉じていても `open-dashboard` を受けられる
  (リレーの 20 秒 ping → pong の往来で MV3 の service worker が生き続ける)
- 認証は無い。tailnet / LAN 内で使う前提。外に出すなら前段に Access 等を置く

## PR を作ったら bridge に自動で繋ぐ (Claude Mod)

`mods/pr-bridge-watch` は Claude Code の **function hooks** (製品名 Claude Mods、early access) で書いた plugin。
Bash の `tool.call` を包み、`gh pr create` / `pr-push.sh` が成功して PR の URL が出たら:

1. `gh pr view <url> --json headRefName` で branch を取る (失敗したら command の `--head`)
2. bridge の `GET /` で生死を見る
3. `$.tool.call({ tool: 'Monitor', ws: { url: 'ws://127.0.0.1:8799/watch?repo=…&ref=<branch>' }, persistent: true })`
4. 結果に context を 1 行足す (「繋いだ (task …)。gh run list で polling しない」)

bridge が落ちている / Monitor が拒否されたときは張らずに、自分で張る `Monitor(...)` の引数を context に書く
(見張りが黙って欠けるより model に拾わせる)。同じセッションで同じ branch は二度張らない。

**Claude desktop (Code タブ) でも張る。** desktop の app が起こしてくれるのは Auto-fix をオンにした PR の失敗
(と conflict・レビューコメント) だけで、CI が通った・merge された、は届かない (Auto-fix は既定でオフ)。
desktop の Monitor には `persistent` が無く `timeout_ms` は 30 分まで (schema で弾かれる) なので、desktop では
`timeout_ms: 1800000` だけで張る (切れたら通知が来るので張り直す)。

**auto mode では hook から張れない。** hook の発した Monitor に分類器が判定を返さない (`gave no verdict`、#50)。
そのときの context は環境で分ける (どちらも拒否の全文は載せない):

- desktop (`CLAUDE_CODE_ENTRYPOINT` が `claude-desktop`): 「CI を見張るため自分で `Monitor({ ws: … })`」と引数つきで返す。
  model が自分で張った ws の Monitor は通る (2026-10-17 実測)
- それ以外: 「CI は PR の監視か `gh pr checks` で確認する」と 1 行の事実だけ返す

**Monitor は archive の前に止める。** `ref` の /watch は bridge が閉じないが、`archive_session` は生きた
background task を持つセッションを畳まない (`still has live work`)。放っておくと見張りが archive を塞ぐので:

- **Actions の通知 (task-notification) が来るたびに全部の見張りを突合**し、local の branch
  (`git --git-dir=<共通 dir> show-ref refs/heads/<ref>`) が消えていたら `TaskStop`。
  PR は親セッションが作るので、子の archive → worktree-janitor で branch が消える → 親に次の通知が来た時点で止まる。
  gh の polling や timer は持たない
- `archive_session { session_id: "self" }` の `tool.call` を包み、先に全部の Monitor を止めてから通す
- **他のセッションの archive が live work で断られたら**、相手へ `[pr-bridge-watch:stop]` 入りの `send_message` を送って
  3 秒後に 1 回やり直す。受けた側の mod は `session.receive` (届かなければ `prompt.submit`) で要求を飲み込み
  (turn を起こさない)、全部止める。子が自分で PR を作ったときの経路。pinned 等の拒否ではやり直さない

task ID (Monitor の結果) が取れないとき・PR の branch が local に無いときは自動では止まらないので、context にそう書く。

**右側パネル** (`hooks/pane.tsx`): PR を作ると、その repo の run を Code タブの右側パネル (`$.ui.open` の Pane) に
5 秒ごとに出す (PR を作った時刻の 1 分前以降の run だけ)。`/actions-pane owner/repo` で repo を足して開く (引数なしはセッションの cwd の `git remote get-url origin` から repo を引いて足す)。
データは bridge の `POST /mcp` に `resources/read` (`gh-actions-live://dashboard?repo=…&since=…`) を投げて読む
(GitHub の API は叩かない)。見た目と `ago` / `elapsed` は `bridge/widget/dashboard.html` と揃える。
installed plugin は起動中のセッションでは読み直されない (更新は新しいセッションから効く)。

導入 (Claude Code 2.1.260 以上。function hooks は既定 off):
```
# ~/.claude/settings.json の env に "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" (起動中のセッションにも効く)
claude plugin marketplace add ippoan/gh-actions-live
claude plugin install pr-bridge-watch@gh-actions-live
```
bridge が別ホストなら userConfig の `bridgeUrl` (既定 `ws://127.0.0.1:8799`) を変える。

開発: 型は build ごとに生成する (commit しない。`mods/*/types/` は gitignore)。
```
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "/plugin-types mods/pr-bridge-watch/types"
tsc -p mods/pr-bridge-watch/tsconfig.json
claude plugin validate mods/pr-bridge-watch
npm test    # test/pr-bridge-watch.test.mjs が偽の $ で register を回す (Node 24 の type stripping で .ts を直接 import)
```
