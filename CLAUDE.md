# CLAUDE.md — ippoan/gh-actions-live

Chrome 拡張 (`extension/`) + perUser MSI (`installer/`) + Linux 側リレー (`bridge/`)。
使い方・運用は `gh-actions-live` skill (ippoan/claude-skills)、設計の経緯は README と issue。

## repo-policy
- **PR を出して CI が緑 = auto-merge = Release 自動採番 (main push ごとに vX.Y.Z)**。
  merge 前に止めたいなら draft で出す。tag を手で打たない (二重採番)
- `Closes #N` 禁止、`Refs #N`。branch は `<type>-<topic>` か `<issue>-<type>-<topic>`
- merge 済み branch への push は hook が止める。新 branch は **別コマンドで** `git checkout main` してから切る
- dev prerelease (`dev-<run>`) は PR の CI が出す。`secrets: inherit` を外すと CRX 署名が空で落ちる

## 触るときの罠 (全部実機で踏んだ)
- `installer/*.ps1` は **UTF-8 BOM 必須** (5.1 が Shift_JIS で読む)。CI で検査。CRLF なので
  python で複数行置換するときは `\r\n` を正規化してから
- `update.ps1` は Release 資産 (octet-stream) を `Get-Text` で byte[] → 文字列にしてから使う
- `update.ps1` / `host.ps1` / `host.bat` は zip に入らない。Release 資産として出し、`update.ps1` が
  実行前に自己更新する。この仕組みを壊すと MSI 入れ直しが要る
- `main.wxs`: `File/@Source` は cwd 基準 (`$(sys.SOURCEFILEDIR)` を付ける)、`Files/@Include` は wxs 基準。
  HKLM 系 component は `Bitness="always64"` + `ALLUSERS=1` 条件。WiX は **5.0.2 固定** (6+ は OSMF EULA)
- `manifest.json`: `host_permissions` に `release-assets.githubusercontent.com` / `objects.githubusercontent.com`
  (Release 資産のリダイレクト先) が要る。
  `key` を変えると拡張 ID が変わり MSI のポリシー / native host manifest / README が全部ずれる
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
  service worker からでは Windows の foreground lock で**前面に出ない** (#32、v0.0.25 で実測)。
  差し替えならウィンドウの位置も z 順もそのままで、Chrome 最後の 1 枚でも Chrome が落ちない。
  ダッシュボードの「再読込」は background へ `command:'reload'` を送るだけ (自分で reload しない)。
  保険として `openDashboard()` は既存タブに `{target:'dashboard',type:'ping'}` を打ち、
  無応答なら `chrome.tabs.reload` で**同じウィンドウ**に読み込み直す。新規に `windows.create`
  したときも直後に `windows.update({focused, drawAttention, state:'normal'})` をもう一度打つ
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
- 非管理 Windows では HKLM の `ExtensionSettings` を Chrome が捨てる (仕様)。
  「MSI で入らない」は #9 を先に読む

## 検証
- CI: JS 構文 / manifest 整合 / `.ps1` BOM / 参照ファイル実在。MSI ビルドは windows-latest
- 実機でしか分からないもの: MSI の配置先・native host・alive の接続。bridge の `status` で見る
