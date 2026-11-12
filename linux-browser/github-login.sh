#!/usr/bin/env bash
# #62: Linux の常駐 Chromium に GitHub のログインを入れ直す。
#   端末で:            ./github-login.sh            (パスワードを伏せ字で聞く。貼り付け可)
#   Windows から:      Get-Clipboard | ssh <user>@<host> <clone>/linux-browser/github-login.sh
set -euo pipefail
DIR="$(dirname "$(readlink -f "$0")")"
# GITHUB_USER などの設定 (無くてもよい)
[ -f "$HOME/.config/gh-actions-live/browser.env" ] && set -a && . "$HOME/.config/gh-actions-live/browser.env" && set +a
# ログイン済みならパスワードを聞かずに終わる
rc=0; node "$DIR/github-login.mjs" --check </dev/null || rc=$?
[ "$rc" -eq 0 ] && exit 0
[ "$rc" -eq 2 ] || exit "$rc"
if [ -t 0 ]; then
  read -rsp 'GitHub のパスワード (貼り付け可、表示されません): ' P; echo
else
  IFS= read -r P || true
fi
printf '%s' "$P" | node "$DIR/github-login.mjs" "${1:-}"
