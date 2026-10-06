#!/bin/bash
set -uo pipefail

TYPE="${1:-}"
PAYLOAD="$(cat 2>/dev/null || true)"

case "$TYPE" in
  notify) LABEL="確認待ち"; FALLBACK="確認を待っています" ;;
  stop)   LABEL="完了";     FALLBACK="応答が完了しました" ;;
  *)      exit 0 ;;
esac

CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
[ -n "$CWD" ] || CWD="$PWD"
MESSAGE="$(printf '%s' "$PAYLOAD" | jq -r '.message // empty' 2>/dev/null)"
[ -n "$MESSAGE" ] || MESSAGE="$FALLBACK"

# エディタのウィンドウはリポジトリルートで開かれていることが多く、サブディレクトリを
# 渡すと既存ウィンドウがそのフォルダを開き直してしまう
TARGET="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$TARGET" ] || TARGET="$CWD"
PROJECT="$(basename "$TARGET")"

# 対象を今まさに見ているなら通知しない。権限が無く前面ウィンドウ名を取れない場合は通知する
# front window は名前の無い隠しウィンドウを拾うことがあるため AXMain で実ウィンドウを選ぶ
FRONT="$(osascript -e 'tell application "System Events" to tell (first process whose frontmost is true) to get name of (first window whose value of attribute "AXMain" is true)' 2>/dev/null || true)"
case "$FRONT" in
  *"$PROJECT"*) exit 0 ;;
esac

# TERM_PROGRAM は hook まで引き継がれないことがあるので、判別できたターミナル以外は
# VSCode 扱いにする。Cursor / Windsurf も vscode を名乗るため実際の bundle id を優先する
IS_VSCODE=1
APP_BUNDLE="com.microsoft.VSCode"
case "${TERM_PROGRAM:-}" in
  vscode)         APP_BUNDLE="${__CFBundleIdentifier:-com.microsoft.VSCode}" ;;
  iTerm.app)      APP_BUNDLE="com.googlecode.iterm2";  IS_VSCODE=0 ;;
  WarpTerminal)   APP_BUNDLE="dev.warp.Warp-Terminal"; IS_VSCODE=0 ;;
  Ghostty)        APP_BUNDLE="com.mitchellh.ghostty";  IS_VSCODE=0 ;;
  Apple_Terminal) APP_BUNDLE="com.apple.Terminal";     IS_VSCODE=0 ;;
esac

q() { printf '%q' "$1"; }

# -activate はアプリを前面に出すだけで、複数ウィンドウのうちどれかを選べない。
# VSCode 系は code -r で対象を開いているウィンドウ自体にフォーカスさせる
CLICK="open -b $(q "$APP_BUNDLE")"
if [ "$IS_VSCODE" = 1 ]; then
  CODE_BIN="$(command -v code 2>/dev/null || true)"
  [ -x "${CODE_BIN:-}" ] || CODE_BIN="/usr/local/bin/code"
  [ -x "$CODE_BIN" ] && CLICK="$(q "$CODE_BIN") -r $(q "$TARGET")"
fi

command -v terminal-notifier >/dev/null 2>&1 || exit 0

terminal-notifier \
  -title "Claude Code" \
  -subtitle "📁 $PROJECT · $LABEL" \
  -message "$MESSAGE" \
  -group "claude-code-$TARGET" \
  -execute "$CLICK" >/dev/null 2>&1 || true
