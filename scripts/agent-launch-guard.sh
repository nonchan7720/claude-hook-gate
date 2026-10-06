#!/usr/bin/env bash
# PreToolUse(Agent|SendMessage) — サブエージェントへ作業指示を送る前に、送信内容そのものを
# 見せて ask を返す。
#
# サブエージェントはメインエージェントの会話コンテキストを持たないため、指示が雑だと
# 別解釈で実装が進み手戻りになる。確認ダイアログに本文を載せないと確認の意味がないので、
# permissionDecisionReason に prompt / message をそのまま入れる。
#
# - Agent: ASK_AGENT_TYPES に列挙した subagent_type の起動を ask
# - SendMessage: ALLOW_RECIPIENTS 以外の宛先への送信を ask
#
# どちらにも該当しなければ何も出力せず、通常のパーミッション判定に委ねる。

set -euo pipefail

ASK_AGENT_TYPES=(
  "code-implementer"
)

# 確認なしで送ってよい宛先（エージェント名）
ALLOW_RECIPIENTS=(
  "git-operator"
)

CHECKLIST="--- チェック: やること / 背景 / 既存コードの現状 / やらないこと / 完了条件"

ask() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $reason
    }
  }'
}

contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty')

case "$tool" in
  Agent)
    agent_type=$(printf '%s' "$payload" | jq -r '.tool_input.subagent_type // empty')
    [ -n "$agent_type" ] || exit 0
    if contains "$agent_type" "${ASK_AGENT_TYPES[@]}"; then
      body=$(printf '%s' "$payload" | jq -r '.tool_input.prompt // ""')
      ask "${agent_type} に送るプロンプト:

${body}

${CHECKLIST}"
    fi
    ;;
  SendMessage)
    recipient=$(printf '%s' "$payload" | jq -r '.tool_input.to // empty')
    if ! contains "$recipient" "${ALLOW_RECIPIENTS[@]}"; then
      body=$(printf '%s' "$payload" | jq -r '.tool_input.message // ""')
      ask "${recipient:-宛先不明} に送るメッセージ:

${body}

${CHECKLIST}"
    fi
    ;;
esac

exit 0
