#!/bin/bash
# settings hook（hooks/hooks.json の command hook）の入口: `hook.sh <Event>`。
# 組織管理（Team / Enterprise ログイン、managed settings）の環境では、組み込みのガード（cc-plugin-sec-default）が classic.* を
# ユーザーの mod に対して飛ばす。settings hook は飛ばされず、stdin の JSON と戻り値（exit 2 / permissionDecision /
# decision: block / additionalContext）が classic と同一なので、ここから hooks/cli.js（src/ の関数）を呼んで同じ処理をさせる。
#
# mod の classic.* が走る環境では二重に動かさない: mod は classic.* のどれかが走ると
# <feedbackDir>/.classic_seen/<session_id> を書く（feedbackDir は CLAUDE_FEEDBACK_DIR か ~/{.claude,.agents}/feedback）。
# そのマーカーがあれば何もせず exit 0。
# cli.js には node（無ければ bun）が要る。どちらも無ければ何もせず exit 0。
set -uo pipefail

EVENT="${1:-}"
[ -n "$EVENT" ] || exit 0

PAYLOAD="$(cat 2>/dev/null || true)"

# session_id: jq があれば jq、無ければ sed で "session_id": "..." を拾う。パスに使うので [A-Za-z0-9_-] 以外は落とす。
if command -v jq >/dev/null 2>&1; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null | tr -cd 'A-Za-z0-9_-')"
else
  SESSION_ID="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 | tr -cd 'A-Za-z0-9_-')"
fi
if [ -n "$SESSION_ID" ]; then
  if [ -n "${CLAUDE_FEEDBACK_DIR:-}" ]; then
    [ -e "$CLAUDE_FEEDBACK_DIR/.classic_seen/$SESSION_ID" ] && exit 0
  else
    # mod は ~/.claude と ~/.agents のうち存在する方（.claude 優先）にマーカーを書く（src/config-dir.ts）。
    for d in .claude .agents; do
      [ -e "${HOME:-~}/$d/feedback/.classic_seen/$SESSION_ID" ] && exit 0
    done
  fi
fi

RUNTIME="$(command -v node 2>/dev/null || command -v bun 2>/dev/null || true)"
[ -n "$RUNTIME" ] || exit 0

ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

printf '%s' "$PAYLOAD" | exec "$RUNTIME" "$ROOT/hooks/cli.js" "$EVENT"
