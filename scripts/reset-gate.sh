#!/usr/bin/env bash
# UserPromptSubmit / SessionStart hook (global):
# 自分のセッション分の状態だけを消す。加えて、クラッシュ等で残った
# 古いセッションのゴミ（24h超）も掃除する。
# 注意: stdout に出力しないこと（UserPromptSubmit では context に注入されるため）。
#
# SessionStart は起動時だけでなく resume / `/clear` / compact でも発火する。
# resume / compact は同一セッションの継続なので、無条件に消すと中断前に
# 変更したファイルがゲートの検証対象から丸ごと落ちてしまう。source が
# startup / clear のときだけ削除し、resume / compact や未知の source
# （取得できない場合を含む）では安全側に倒して削除しない。

JSON_INPUT=$(cat)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
CLAUDE_DIR="${PROJECT_DIR}/.claude"

if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(printf '%s' "$JSON_INPUT" | jq -r '.session_id // empty')
  SOURCE=$(printf '%s' "$JSON_INPUT" | jq -r '.source // empty')
else
  SESSION_ID=$(printf '%s' "$JSON_INPUT" \
    | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n 1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')
  SOURCE=$(printf '%s' "$JSON_INPUT" \
    | grep -o '"source"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n 1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/')
fi
[ -n "$SESSION_ID" ] || SESSION_ID="unknown"

case "$SOURCE" in
  startup|clear)
    # SubagentStop 経由の状態ファイル（changed_files.<session>--<agent>.txt 等）も対象。
    # payload の session_id はメインのセッションIDのみなので、--* を別途 glob で拾う。
    rm -f "${CLAUDE_DIR}/changed_files.${SESSION_ID}.txt" \
          "${CLAUDE_DIR}/gate_attempts.${SESSION_ID}.txt" \
          "${CLAUDE_DIR}/gate_passed.${SESSION_ID}.txt" \
          "${CLAUDE_DIR}/gate_push_verified.${SESSION_ID}.txt" \
          "${CLAUDE_DIR}/gate_pending_checks.${SESSION_ID}.json" \
          "${CLAUDE_DIR}/gate_trace.${SESSION_ID}.jsonl" \
          "${CLAUDE_DIR}/gate_deferred.${SESSION_ID}.json" \
          "${CLAUDE_DIR}/feedback_gate_attempts.${SESSION_ID}.txt" \
          "${CLAUDE_DIR}/changed_files.${SESSION_ID}"--*.txt \
          "${CLAUDE_DIR}/gate_attempts.${SESSION_ID}"--*.txt \
          "${CLAUDE_DIR}/gate_passed.${SESSION_ID}"--*.txt \
          "${CLAUDE_DIR}/gate_push_verified.${SESSION_ID}"--*.txt \
          "${CLAUDE_DIR}/gate_pending_checks.${SESSION_ID}"--*.json \
          "${CLAUDE_DIR}/gate_trace.${SESSION_ID}"--*.jsonl \
          "${CLAUDE_DIR}/gate_deferred.${SESSION_ID}"--*.json \
          "${CLAUDE_DIR}/feedback_gate_attempts.${SESSION_ID}"--*.txt
    ;;
  *)
    : # resume / compact / 未知の source では削除しない
    ;;
esac

if [ -d "$CLAUDE_DIR" ]; then
  find "$CLAUDE_DIR" -maxdepth 1 \
    \( -name 'changed_files.*.txt' -o -name 'gate_attempts.*.txt' -o -name 'gate_passed.*.txt' \
       -o -name 'gate_push_verified.*.txt' \
       -o -name 'gate_pending_checks.*.json' -o -name 'feedback_gate_attempts.*.txt' \
       -o -name 'gate_trace.*.jsonl' -o -name 'gate_deferred.*.json' \) \
    -mmin +1440 -delete 2>/dev/null
fi

exit 0
