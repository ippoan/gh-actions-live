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
  (Release 資産のリダイレクト先) と `*://alive.github.com/*` (DNR の Origin 書き換え) が要る。
  `key` を変えると拡張 ID が変わり MSI のポリシー / native host manifest / README が全部ずれる
- `dashboard.js`: alive 切断時の再接続は指数バックオフ。無条件に `boot()` を呼ぶと 5 秒周期ポーリングになる
- 非管理 Windows では HKLM の `ExtensionSettings` を Chrome が捨てる (仕様)。
  「MSI で入らない」は #9 を先に読む

## 検証
- CI: JS 構文 / manifest 整合 / `.ps1` BOM / 参照ファイル実在。MSI ビルドは windows-latest
- 実機でしか分からないもの: MSI の配置先・native host・alive の接続。bridge の `status` で見る
