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

### MSI (推奨、admin 不要)

1. [Releases](https://github.com/ippoan/gh-actions-live/releases) から
   `gh-actions-live-*-x64.msi` を実行。
   `%LOCALAPPDATA%\Programs\gh-actions-live\extension` に配置される (perUser)。
2. `chrome://extensions` → デベロッパーモード ON →
   「パッケージ化されていない拡張機能を読み込む」→ 上記フォルダを選択。
   ID が `oaadakmclelmnaieokjbhldfacfckaaj` になることを確認
   (manifest の `key` で固定済み。違う ID なら manifest が壊れている)。
3. オプションから repo を追加 (1 行 1 つ、`owner/repo`)。
4. その Chrome プロファイルで GitHub にログインしていること。

更新は新しい MSI を入れ直すだけ (MajorUpgrade で上書き)。
アンインストールは「アプリと機能」から。

native host を持たないので、MSI がやるのはファイル配置と upgrade / uninstall だけ。
Chrome への読み込みは手動のまま。

### zip / ソースから

Release の `gh-actions-live-extension-*.zip` を展開するか、この repo の
`extension/` フォルダをそのまま「パッケージ化されていない拡張機能を読み込む」で指す。

## リリースサイクル

バージョンは**自動採番**する。直近の `v*` tag の patch を +1、tag が無ければ `0.0.1` から。

- **stable**: `main` への push で自動的に次の版を採番し、`vX.Y.Z` の Release を作る (Latest)
- **dev**: PR (non-draft) の CI が `dev-<run_number>` の prerelease を PR head に打つ。
  **merge を待たずに MSI を試せる。** 版は「その PR が出す予定の stable と同じ」
- **手動**: 任意の版を切りたい場合は Release workflow を `workflow_dispatch` で
  実行し、`version` に `X.Y.Z` を指定する

tag は Release 作成時に打たれる。手で tag を push する経路は持たない (二重採番になるため)。
manifest の version は tag から stamp されるので、repo に入っている値は開発用の目安。

## リポジトリ構成

```
extension/          MV3 拡張本体 (これを Chrome に読み込む)
installer/main.wxs  perUser MSI (WiX v4+)
bridge/             拡張から外へイベントを出すための最小 WS サーバー (依存なし・任意)
```

## 既知の制約

- **未テスト**。alive のプロトコル (接続・購読・ack)、認証境界、partial のサイズは
  実機で確認済みだが、拡張として読み込んだ状態での動作確認はまだ。
- push ペイロードの形は未確認。生サンプルを 50 件まで保存して設定画面に出すので、
  形が分かったら `ws.onmessage` を絞り込める。
- `data-channel` のトークンは発行時刻 `t` 入りの時限。20 分ごとにページを取り直して更新する。
- **未文書の内部プロトコル**なので、GitHub 側の変更で黙って壊れうる。
