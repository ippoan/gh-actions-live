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

MSI は 1 つで、**既定は perUser (admin 不要)**。管理端末向けの機能は `ALLUSERS=1` を付けたときだけ出る。

| 端末 | コマンド | 何が起きるか |
|---|---|---|
| 非管理 (Windows Home / WORKGROUP / 個人 PC) — **こちらが既定** | `msiexec /i gh-actions-live-x.y.z-x64.msi` (ダブルクリックでも同じ) | `%LOCALAPPDATA%\Programs\gh-actions-live\extension` に配置 + **自動更新タスク**を登録。Chrome への初回読み込みだけ手動 |
| 管理端末 (AD / Entra / Chrome Enterprise Core 登録済み) | `msiexec /i gh-actions-live-x.y.z-x64.msi ALLUSERS=1` (UAC 昇格) | `C:\Program Files\gh-actions-live` に配置 + HKLM に `ExtensionSettings` (force_installed)。Chrome 再起動だけで入り、更新も Chrome が拾う |
| 非管理端末を Chrome Enterprise Core に登録したい | `… ALLUSERS=1 ENROLLMENTTOKEN=<token>` | 上に加えて `CloudManagementEnrollmentToken` を書く。token は Google Admin で発行 |

なぜ分かれるか: Chrome の公式仕様で、Windows では Web Store **外** の拡張を `force_installed` できるのは
管理端末だけ。非管理端末ではレジストリに正しく書けていても Chrome が黙って捨てる
(`chrome://policy` に `[BLOCKED]` + 警告で出る)。詳細は [#9](https://github.com/ippoan/gh-actions-live/issues/9)。
自分の端末は `dsregcmd /status` で分かる (`AzureAdJoined` / `DomainJoined` / `EnterpriseJoined` が全部 `NO` なら非管理)。

### 非管理端末での手順 (既定)

1. [Releases](https://github.com/ippoan/gh-actions-live/releases) から `gh-actions-live-*-x64.msi` を落とし、
   **設定ごと** インストールする (admin 不要):

   ```
   msiexec /i gh-actions-live-x.y.z-x64.msi REPOS=owner/repo,owner/repo2 BRIDGEURL=ws://host:8799 NOTIFY=0
   ```

   property は全部任意。渡した値は `extension\config.json` に書かれ、拡張が起動時に取り込む。
   **設定画面での手入力は不要**。拡張を入れ直して `chrome.storage` が消えても config.json から戻る。
   あとから変えたいときは同じコマンドを渡し直す (upgrade で上書き)。
   ダブルクリックで入れた場合は設定画面から手で入れる (従来どおり)
2. `chrome://extensions` → 右上「デベロッパー モード」ON → 「パッケージ化されていない拡張機能を読み込む」→
   `%LOCALAPPDATA%\Programs\gh-actions-live\extension`
3. ID が `oaadakmclelmnaieokjbhldfacfckaaj` になっていることを確認。その Chrome プロファイルで GitHub にログインしていること

**以降の更新はダッシュボードの「更新」ボタン 1 クリック**。MSI を入れ直す必要は無い。

#### 更新の仕組み

Chrome は Web Store 外の拡張の `update_url` を相手にしないので自前で組む。拡張はディスクに
書けないため、MSI が小さな **native messaging host** (`host.bat` → `host.ps1`) を
`HKCU\Software\Google\Chrome\NativeMessagingHosts` に登録する (Policies 配下ではないので admin 不要)。

1. ヘッダに `v0.0.12 → v0.0.13 あり` と出たら **「更新」ボタン**を押す
2. 拡張が host を呼び、host が `update.ps1` を実行: `update.xml` の版を見て
   `gh-actions-live-extension.zip` を落とし、sha256 を照合して `extension\` を差し替える (ログは `update.log`)
3. background が `reloadSelf()`: **先にダッシュボードのタブを `about:blank` に差し替えてから**
   `chrome.runtime.reload()`。reload 後は**同じタブ**にダッシュボードを読み込み直す
   (何もせず reload すると空ウィンドウが残る → #30。閉じて開き直すと新規ウィンドウが
   前面に出ない → #32)

Linux 側 (bridge) から `{"command":"update"}` を送っても同じことが起きる。
定期的に勝手に上げたい人は `update.ps1 -Register` でタスク スケジューラに登録できる (既定では登録しない)。

MSI を使わずに zip を展開して読み込むこともできる。その場合は host が無いので、
新しい zip を同じフォルダに上書き展開して拡張カードの ↻ を押す。

#### 再読込 / 更新の手動確認 (実機でしか分からない)

拡張の再起動 (`chrome.runtime.reload()`) は**ページを殺すだけでウィンドウは閉じない**ので、
放っておくと空のウィンドウが 1 枚残る (#30)。かといって先にタブを閉じると、復活が新規ウィンドウに
なり、reload 直後の service worker からでは Windows の foreground lock で**前面に出ない** (#32)。
reload は background の `reloadSelf()` に一本化してあり、**先にダッシュボードのタブを
`about:blank` に差し替えてから** reload し、`onInstalled` で**同じタブ**に読み込み直す。
実機で見るのはここ:

1. ダッシュボードを開いた状態で「再読込」→ **同じウィンドウのまま**中身が復活し、**前面にある**こと
   (空白のウィンドウが増えていない / ウィンドウが消えていない)
2. bridge から `{"command":"update"}` / `{"command":"reload"}` を送っても同じこと
3. 10 分ごとの self-update (ディスクの版が上がったとき) でも同じこと

### 管理端末での手順

`ALLUSERS=1` を付けて実行 (UAC 昇格が 1 回) → Chrome を再起動。それだけで入る。
HKLM の `ExtensionSettings` は `update_url` が `releases/latest/download/...` の固定 URL なので、
版が上がってもポリシーを書き換えなくてよい。Chrome に「組織によって管理されています」が出て、
ユーザーは拡張を Chrome から削除できない (アンインストールは「アプリと機能」から MSI を消す)。

`HKCU\Software\Policies` はユーザー権限で書けないため、ポリシー系は `ALLUSERS=1` (HKLM) のときだけ出る。

### トラブルシュート

- **`chrome://policy` に `ExtensionSettings` が載っていない** → `ALLUSERS=1` で入れたか。
  `reg query "HKLM\SOFTWARE\Policies\Google\Chrome" /v ExtensionSettings` で単一の REG_SZ に JSON が入っているか。Chrome は再起動したか
- **載っているが `[BLOCKED]` + 警告** → 端末が非管理。仕様なので perUser (既定) の手順を使う
- **「更新」ボタンが失敗する** → `%LOCALAPPDATA%\Programs\gh-actions-live\update.log` を見る。
  「native host が見つかりません」なら MSI で入れていない (zip 展開) か、
  `reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\jp.ippoan.gh_actions_live` が無い

## リリースサイクル

バージョンは**自動採番**する。直近の `v*` tag の patch を +1、tag が無ければ `0.0.1` から。

- **stable**: `main` への push で自動的に次の版を採番し、`vX.Y.Z` の Release を作る (Latest)
- **auto-merge**: PR (non-draft) の CI が全部緑になると、org 標準の reusable
  (`ippoan/ci-workflows/.github/workflows/auto-merge.yml`) が squash merge を queue する。
  **PR を出して緑になれば、そのまま新しい版が公開される**
- **dev**: PR (non-draft) の CI が `dev-<run_number>` の prerelease を PR head に打つ。
  **merge を待たずに MSI を試せる。** 版は「その PR が出す予定の stable と同じ」
- **手動**: 任意の版を切りたい場合は Release workflow を `workflow_dispatch` で
  実行し、`version` に `X.Y.Z` を指定する

tag は Release 作成時に打たれる。手で tag を push する経路は持たない (二重採番になるため)。
manifest の version は tag から stamp されるので、repo に入っている値は開発用の目安。

## リポジトリ構成

```
extension/          MV3 拡張本体 (これを Chrome に読み込む)
installer/main.wxs  MSI (WiX v4+、perUserOrMachine)。配置 + 自動更新タスク + (ALLUSERS=1 で) Chrome ポリシー
installer/update.ps1 更新スクリプト (native host / 手動 / 任意でタスク登録)
installer/host.ps1   native messaging host (「更新」ボタンの実体)
bridge/             Claude Code (Linux) 側のリレー。依存なし (下記)
```

## 既知の制約

- **未テスト**。alive のプロトコル (接続・購読・ack)、認証境界、partial のサイズは
  実機で確認済みだが、拡張として読み込んだ状態での動作確認はまだ。
- push ペイロードの形は未確認。生サンプルを 50 件まで保存して設定画面に出すので、
  形が分かったら `ws.onmessage` を絞り込める。
- `data-channel` のトークンは発行時刻 `t` 入りの時限。20 分ごとにページを取り直して更新する。
- **未文書の内部プロトコル**なので、GitHub 側の変更で黙って壊れうる。

## Claude から設定を入れる (github.com 経由)

拡張は `externally_connectable` で `https://github.com/*` からのメッセージを受ける。
Claude in Chrome は github.com のタブで JS を実行できるので、**設定画面を触らずに**
そこから設定を流し込める (bridge URL が未設定でも届く):

```js
// github.com のタブで
chrome.runtime.sendMessage('oaadakmclelmnaieokjbhldfacfckaaj',
  { command: 'set-config', repos: ['owner/repo'], bridgeUrl: 'ws://host:8799', notify: false },
  r => console.log(r));
// command: get-config / open-dashboard / access-login / update / check-update / native-ping / status / alive-reset / reload も同じ経路で使える
```

## Claude Code への途中通知 (bridge)

拡張は GitHub を見ているだけなので、そのままでは Claude Code (別マシン) に何も届かない。
`bridge/ws-bridge.mjs` を Claude Code 側で動かし、拡張からそこへ **outbound** で WebSocket を
張ると双方向になる。

```
Windows Chrome 拡張  ──ws://<linux>:8799──▶  ws-bridge.mjs  ──stdout──▶  Claude Code (Monitor)
        ▲                                          │
        └──────── {"type":"command",...} ◀─────────┘  POST /cmd  /  stdin  /  ?role=listener
```

- Linux → 拡張 (設定): `curl -X POST localhost:8799/cmd -d '{"command":"set-config","repos":["owner/repo"],"notify":false}'`
  で repo を変えられる。`get-config` で現在値を返す
- 拡張 → Linux: run の状態変化を 1 行ずつ stdout に出す。Claude Code の `Monitor` ツールが
  それを通知に変える (`Monitor({command: "node bridge/ws-bridge.mjs 8799", persistent: true})`)
- Linux → 拡張: `curl -X POST localhost:8799/cmd -d '{"command":"open-dashboard","mode":"popup"}'`
  でウィンドウを遠隔で開ける。`refresh` / `snapshot` も受ける
- Cloudflare Access のログイン承認: `curl -X POST localhost:8799/cmd -d '{"command":"access-login","url":"<cloudflared access login が出した URL>"}'`
  で承認ページを前面のウィンドウに開く。トークンを取りに行くのは Linux 側の `cloudflared` 自身なので、
  ブラウザは「Approve」を押すだけでよく、Windows の Chrome で承認しても通る。
  **開ける URL は https かつパスが `/cdn-cgi/access/cli` ちょうどのものだけ** (完全一致)。
  bridge には認証が無いので、絞らないと 8799 に届く者が Chrome で任意のページを開けてしまうため。
  弾いた URL はログにも応答にも全体を出さない (`token=` の nonce が乗っている)
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
