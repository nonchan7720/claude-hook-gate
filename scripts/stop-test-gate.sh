#!/usr/bin/env bash
# $1: gate のフェーズ（rules|checks）。省略時は checks（Stop/SubagentStop からの
# 呼び出しに合わせたデフォルト）。PostToolUse からは "rules" を明示して呼ぶ。
GATE_PHASE="${1:-checks}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

JSON_INPUT=$(cat)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

if [ ! -f "${PROJECT_DIR}/.claude/gate.yaml" ]; then
  if [ -f "${PROJECT_DIR}/.claude/gate.yml" ]; then
    printf '%s\n' '{"systemMessage": "[gate] .claude/gate.yaml が見つかりませんが .claude/gate.yml があります。拡張子が yaml ではなく yml になっていないか確認してください。"}'
  fi
  exit 0
fi

if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(printf '%s' "$JSON_INPUT" | jq -r '.session_id // empty')
  STOP_HOOK_ACTIVE=$(printf '%s' "$JSON_INPUT" | jq -r 'if .stop_hook_active == true then "true" else "false" end')
  AGENT_ID=$(printf '%s' "$JSON_INPUT" | jq -r '.agent_id // empty')
else
  SESSION_ID=$(printf '%s' "$JSON_INPUT" \
    | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n 1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')
  STOP_HOOK_ACTIVE=$(printf '%s' "$JSON_INPUT" \
    | grep -o '"stop_hook_active"[[:space:]]*:[[:space:]]*\(true\|false\)' \
    | head -n 1 \
    | sed -E 's/.*:[[:space:]]*(true|false).*/\1/')
  AGENT_ID=$(printf '%s' "$JSON_INPUT" \
    | grep -o '"agent_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n 1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')
fi
[ -n "$SESSION_ID" ] || SESSION_ID="unknown"
[ -n "$STOP_HOOK_ACTIVE" ] || STOP_HOOK_ACTIVE="false"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[gate] python3 が必要です。スキップします。" >&2
  exit 0
fi

if [ -n "$AGENT_ID" ]; then
  CLAUDE_PROJECT_DIR="$PROJECT_DIR" CLAUDE_SESSION_ID="$SESSION_ID" CLAUDE_STOP_HOOK_ACTIVE="$STOP_HOOK_ACTIVE" \
    CLAUDE_AGENT_ID="$AGENT_ID" CLAUDE_GATE_PHASE="$GATE_PHASE" \
    python3 "$SCRIPT_DIR/stop-gate.py"
else
  CLAUDE_PROJECT_DIR="$PROJECT_DIR" CLAUDE_SESSION_ID="$SESSION_ID" CLAUDE_STOP_HOOK_ACTIVE="$STOP_HOOK_ACTIVE" \
    CLAUDE_GATE_PHASE="$GATE_PHASE" \
    python3 "$SCRIPT_DIR/stop-gate.py"
fi
exit $?
