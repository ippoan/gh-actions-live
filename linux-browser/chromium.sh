#!/usr/bin/env bash
# Linux で拡張 (extension/) を headless Chromium に載せて常駐させる (#62)。拡張はここでだけ動かす。
# systemd --user の gh-actions-browser.service から起動する。手で試すなら ./chromium.sh
#
# - snap の Chromium を使う (Playwright 同梱の Chromium は sandbox が使えず落ちる)。
#   snap は $HOME 直下の隠しディレクトリを読めないので、プロファイルは ~/snap/chromium/common/ に置く
# - CDP は 127.0.0.1:9223 だけ。github-login.sh / github-logout.mjs がここに繋ぐ。外には出さない
# - User-Agent から HeadlessChrome を外す (GitHub のログイン画面で弾かれないように)
# - ダッシュボード (bridge に繋ぐ本体) は起動後に CDP の /json/new で開く。起動時の URL に渡すと、
#   拡張の読み込みより先に開いてタブの中身が空のまま bridge に繋がらない。headless は起動時の URL を
#   1 つしか受けない (2 つ渡すと "Multiple targets are not supported in headless mode" で status 13)。
#   前回のタブが復元されていたら閉じてから開く (ダッシュボードが 2 枚だと bridge に 2 つ繋がる)。
#   github.com のタブ (alive の購読) は background が自分で開く
set -euo pipefail
DIR="$(dirname "$(readlink -f "$0")")"
EXT="$(cd "$DIR/../extension" && pwd)"
PROFILE="${GH_ACTIONS_BROWSER_PROFILE:-$HOME/snap/chromium/common/gh-actions-live-profile}"
CHROMIUM="${GH_ACTIONS_BROWSER_CHROMIUM:-/snap/bin/chromium}"
EXT_ID=oaadakmclelmnaieokjbhldfacfckaaj   # manifest.json の key から決まる (key を変えるとずれる)

mkdir -p "$PROFILE"
chmod 700 "$PROFILE"
"$CHROMIUM" \
  --headless=new \
  --user-data-dir="$PROFILE" \
  --password-store=basic \
  --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
  --disable-extensions-except="$EXT" \
  --load-extension="$EXT" \
  about:blank &
PID=$!
trap 'kill "$PID" 2>/dev/null' TERM INT

CDP=http://127.0.0.1:9223
for _ in $(seq 60); do curl -sf "$CDP/json/version" >/dev/null && break; sleep 1; done
sleep 3   # 拡張 (service worker) の読み込みを待つ
DASH="chrome-extension://$EXT_ID/dashboard.html"
for id in $(curl -sf "$CDP/json/list" | grep -o '"id": *"[^"]*"\|"url": *"[^"]*"' | paste - - | grep -F "$DASH" | sed 's/.*"id": *"\([^"]*\)".*/\1/'); do
  curl -sf "$CDP/json/close/$id" >/dev/null || true
done
curl -sf -X PUT "$CDP/json/new?$DASH" >/dev/null || echo "[gh-actions-browser] ダッシュボードを開けなかった" >&2
wait "$PID"
