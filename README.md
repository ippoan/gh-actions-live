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

### MSI

[Releases](https://github.com/ippoan/gh-actions-live/releases) から
`gh-actions-live-*-x64.msi` を実行し(**UAC の昇格が 1 回出る**)、**Chrome を再起動する**。
それだけで拡張が入る。

MSI は 2 つのことをする:

1. Chrome の `ExtensionSettings` ポリシーを HKLM に書き、拡張を `force_installed` にする
2. 拡張一式を `C:\Program Files\gh-actions-live\extension` にも置く (手動読み込み用の予備)

```
HKLM\Software\Policies\Google\Chrome\ExtensionSettings\oaadakmclelmnaieokjbhldfacfckaaj
    installation_mode = force_installed
    update_url        = https://github.com/ippoan/gh-actions-live/releases/latest/download/update.xml
```

`update_url` は `releases/latest/download/...` の固定 URL で常に最新 Release の
asset に解決されるので、**版が上がってもポリシーを書き換えなくてよい**。
Chrome が自分で更新を拾う。

インストール後、オプション画面から repo を追加する (1 行 1 つ、`owner/repo`)。
その Chrome プロファイルで GitHub にログインしていること。

#### なぜ admin が要るのか

Windows は `HKCU\Software\Policies` に ACL をかけていて、**ユーザー権限では書き込めない**
(ユーザーが自分にポリシーを適用できないようにするため)。perUser MSI で試すと
`値 installation_mode をキー ...\ExtensionSettings\<id> に書き込めません` で失敗する。
ポリシーを使う以上 HKLM しか選択肢が無く、そのため perMachine にしている。

admin を使いたくない場合は下の「手動で読み込む場合」を使う。

#### 副作用

Chrome に「組織によって管理されています」が出る。`force_installed` の拡張は
ユーザーが Chrome から削除できない (アンインストールは「アプリと機能」から MSI を消す。
`ForceDeleteOnUninstall` でポリシーキーも一緒に消える)。

### 手動で読み込む場合 (admin 不要)

Release の `gh-actions-live-extension-*.zip` を展開するか、この repo の `extension/` を
`chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を
読み込む」で指す。manifest の `key` で ID を固定しているので、どちらでも ID は
`oaadakmclelmnaieokjbhldfacfckaaj` になる。

### トラブルシュート

`chrome://policy` を開いて `ExtensionSettings` が載っているかを見る。

- **載っていない** → ポリシーが読まれていない (MSI が失敗しているか Chrome 未再起動)
- **載っているのに拡張が入らない** → `update.xml` / `.crx` の取得か検証で失敗している

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
installer/main.wxs  perUser MSI (WiX v4+)。拡張の配置 + Chrome ポリシー書き込み
bridge/             Claude Code (Linux) 側のリレー。依存なし (下記)
```

## 既知の制約

- **未テスト**。alive のプロトコル (接続・購読・ack)、認証境界、partial のサイズは
  実機で確認済みだが、拡張として読み込んだ状態での動作確認はまだ。
- push ペイロードの形は未確認。生サンプルを 50 件まで保存して設定画面に出すので、
  形が分かったら `ws.onmessage` を絞り込める。
- `data-channel` のトークンは発行時刻 `t` 入りの時限。20 分ごとにページを取り直して更新する。
- **未文書の内部プロトコル**なので、GitHub 側の変更で黙って壊れうる。

## Claude Code への途中通知 (bridge)

拡張は GitHub を見ているだけなので、そのままでは Claude Code (別マシン) に何も届かない。
`bridge/ws-bridge.mjs` を Claude Code 側で動かし、拡張からそこへ **outbound** で WebSocket を
張ると双方向になる。

```
Windows Chrome 拡張  ──ws://<linux>:8799──▶  ws-bridge.mjs  ──stdout──▶  Claude Code (Monitor)
        ▲                                          │
        └──────── {"type":"command",...} ◀─────────┘  POST /cmd  /  stdin  /  ?role=listener
```

- 拡張 → Linux: run の状態変化を 1 行ずつ stdout に出す。Claude Code の `Monitor` ツールが
  それを通知に変える (`Monitor({command: "node bridge/ws-bridge.mjs 8799", persistent: true})`)
- Linux → 拡張: `curl -X POST localhost:8799/cmd -d '{"command":"open-dashboard","mode":"popup"}'`
  でウィンドウを遠隔で開ける。`refresh` / `snapshot` も受ける
- 拡張側は **設定画面の「Linux 側リレーの URL」** に `ws://<host>:8799` を入れる
- service worker も 1 本張っていて、ダッシュボードが閉じていても `open-dashboard` を受けられる
  (リレーの 20 秒 ping → pong の往来で MV3 の service worker が生き続ける)
- 認証は無い。tailnet / LAN 内で使う前提。外に出すなら前段に Access 等を置く
