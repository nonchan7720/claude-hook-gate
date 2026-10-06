#!/usr/bin/env bash
# PostToolUse hook (global): 変更ファイルのパスをセッション別メモに記録する。
# PJ が .claude/gate.yaml を持つ場合のみ動く（オプトイン）。

JSON_INPUT=$(cat)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
[ -f "${PROJECT_DIR}/.claude/gate.yaml" ] || exit 0

if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(printf '%s' "$JSON_INPUT" | jq -r '.tool_input.file_path // empty')
  SESSION_ID=$(printf '%s' "$JSON_INPUT" | jq -r '.session_id // empty')
  AGENT_ID=$(printf '%s' "$JSON_INPUT" | jq -r '.agent_id // empty')
else
  FILE_PATH=$(printf '%s' "$JSON_INPUT" \
    | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n 1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')
  SESSION_ID=$(printf '%s' "$JSON_INPUT" \
    | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n 1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')
  AGENT_ID=$(printf '%s' "$JSON_INPUT" \
    | grep -o '"agent_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n 1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')
fi

[ -n "$SESSION_ID" ] || SESSION_ID="unknown"
STATE_ID="$SESSION_ID"
[ -n "$AGENT_ID" ] && STATE_ID="${SESSION_ID}--${AGENT_ID}"
MEMO_FILE="${PROJECT_DIR}/.claude/.gate-status/changed_files.${STATE_ID}.txt"

if [ -n "$FILE_PATH" ]; then
  mkdir -p "$(dirname "$MEMO_FILE")"
  grep -qxF "$FILE_PATH" "$MEMO_FILE" 2>/dev/null || printf '%s\n' "$FILE_PATH" >> "$MEMO_FILE"
fi

exit 0
