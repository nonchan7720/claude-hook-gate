#!/bin/bash
# Notification の settings hook（hooks/hooks.json の command hook）: Claude が確認待ちのとき、macOS のデスクトップ通知を出す。
# mod 側の classic.Notification（src/register.ts）と同じ通知をするので、二重に出さないよう、classic が走る環境では黙る:
# mod は classic.* のどれかが走ると <feedbackDir>/.classic_seen/<session_id> を書く（feedbackDir は CLAUDE_FEEDBACK_DIR か
# ~/.claude/feedback）。そのマーカーがあれば何もせず exit 0。組織管理（sec-default）の環境では classic.* が飛ばされて
# マーカーが書かれないので、settings hook であるこちらが通知する（settings hook は sec-default に飛ばされない）。
# 完了通知（Stop）は mod 側（src/notification.ts の stop）が出す。macOS 前提（osascript / terminal-notifier）。
# jq が無い、terminal-notifier が無い環境では何もせず exit 0。
set -uo pipefail

TYPE="${1:-}"
[ "$TYPE" = "notify" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

PAYLOAD="$(cat 2>/dev/null || true)"

SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null | tr -cd 'A-Za-z0-9_-')"
FEEDBACK_DIR="${CLAUDE_FEEDBACK_DIR:-${HOME:-~}/.claude/feedback}"
[ -n "$SESSION_ID" ] && [ -e "$FEEDBACK_DIR/.classic_seen/$SESSION_ID" ] && exit 0

# メッセージの言語は src/i18n.ts と同じ決め方: FEEDBACK_GATE_LANG → LC_ALL → LC_MESSAGES → LANG の順に、
# 最初に値のあるものを使い、ja で始まれば日本語、それ以外（C / POSIX を含む）と未設定は英語。
# プラグイン設定の language（ja / en）が渡ってくれば、それを優先する。
LOCALE=""
for v in "${CLAUDE_PLUGIN_OPTION_language:-}" "${FEEDBACK_GATE_LANG:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
  v="${v#"${v%%[![:space:]]*}"}"
  [ "$v" = "auto" ] && continue
  if [ -n "$v" ]; then LOCALE="$v"; break; fi
done
case "$LOCALE" in
  ja|ja[!a-zA-Z]*|JA|JA[!a-zA-Z]*) LABEL="確認待ち"; FALLBACK="確認を待っています" ;;
  *) LABEL="Waiting for you"; FALLBACK="Claude is waiting for your input" ;;
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
exit 0
