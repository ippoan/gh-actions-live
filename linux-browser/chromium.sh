#!/usr/bin/env bash
# Linux で拡張 (extension/) を headless Chromium に載せて常駐させる (#62)。Windows の Chrome の代わり。
# systemd --user の gh-actions-browser.service から起動する。手で試すなら ./chromium.sh
#
# - snap の Chromium を使う (Playwright 同梱の Chromium は sandbox が使えず落ちる)。
#   snap は $HOME 直下の隠しディレクトリを読めないので、プロファイルは ~/snap/chromium/common/ に置く
# - CDP は 127.0.0.1:9223 だけ。github-login.sh / github-logout.mjs がここに繋ぐ。外には出さない
# - User-Agent から HeadlessChrome を外す (GitHub のログイン画面で弾かれないように)
# - 開くのはダッシュボード (bridge に繋ぐ本体) と github.com (alive の購読タブ・ログイン用)
set -euo pipefail
DIR="$(dirname "$(readlink -f "$0")")"
EXT="$(cd "$DIR/../extension" && pwd)"
PROFILE="${GH_ACTIONS_BROWSER_PROFILE:-$HOME/snap/chromium/common/gh-actions-live-profile}"
CHROMIUM="${GH_ACTIONS_BROWSER_CHROMIUM:-/snap/bin/chromium}"
EXT_ID=oaadakmclelmnaieokjbhldfacfckaaj   # manifest.json の key から決まる (Windows と同じ)

mkdir -p "$PROFILE"
chmod 700 "$PROFILE"
exec "$CHROMIUM" \
  --headless=new \
  --user-data-dir="$PROFILE" \
  --password-store=basic \
  --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
  --disable-extensions-except="$EXT" \
  --load-extension="$EXT" \
  "chrome-extension://$EXT_ID/dashboard.html" \
  https://github.com/
