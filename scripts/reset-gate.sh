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
STATE_DIR="${CLAUDE_DIR}/.gate-status"

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
    # 置き場所は .claude/.gate-status/。移行前の旧パス（.claude/ 直下と .claude/hooks/logs/）の
    # 残骸も同じ条件で消す。
    for DIR in "$STATE_DIR" "$CLAUDE_DIR"; do
      rm -f "${DIR}/changed_files.${SESSION_ID}.txt" \
            "${DIR}/gate_attempts.${SESSION_ID}.txt" \
            "${DIR}/gate_passed.${SESSION_ID}.txt" \
            "${DIR}/gate_push_verified.${SESSION_ID}.txt" \
            "${DIR}/gate_pending_checks.${SESSION_ID}.json" \
            "${DIR}/gate_trace.${SESSION_ID}.jsonl" \
            "${DIR}/gate_deferred.${SESSION_ID}.json" \
            "${DIR}/feedback_gate_attempts.${SESSION_ID}.txt" \
            "${DIR}/changed_files.${SESSION_ID}"--*.txt \
            "${DIR}/gate_attempts.${SESSION_ID}"--*.txt \
            "${DIR}/gate_passed.${SESSION_ID}"--*.txt \
            "${DIR}/gate_push_verified.${SESSION_ID}"--*.txt \
            "${DIR}/gate_pending_checks.${SESSION_ID}"--*.json \
            "${DIR}/gate_trace.${SESSION_ID}"--*.jsonl \
            "${DIR}/gate_deferred.${SESSION_ID}"--*.json \
            "${DIR}/feedback_gate_attempts.${SESSION_ID}"--*.txt
    done
    for LOG_ROOT in "${STATE_DIR}/logs" "${CLAUDE_DIR}/hooks/logs"; do
      rm -rf "${LOG_ROOT}/${SESSION_ID}" "${LOG_ROOT}/${SESSION_ID}"--* 2>/dev/null
    done
    ;;
  *)
    : # resume / compact / 未知の source では削除しない
    ;;
esac

for DIR in "$STATE_DIR" "$CLAUDE_DIR"; do
  [ -d "$DIR" ] || continue
  find "$DIR" -maxdepth 1 \
    \( -name 'changed_files.*.txt' -o -name 'gate_attempts.*.txt' -o -name 'gate_passed.*.txt' \
       -o -name 'gate_push_verified.*.txt' \
       -o -name 'gate_pending_checks.*.json' -o -name 'feedback_gate_attempts.*.txt' \
       -o -name 'gate_trace.*.jsonl' -o -name 'gate_deferred.*.json' \) \
    -mmin +1440 -delete 2>/dev/null
done

# ログ（新: .gate-status/logs/<state_id>/、旧: hooks/logs/<state_id>/）も 24h 超は掃除する。
for LOG_ROOT in "${STATE_DIR}/logs" "${CLAUDE_DIR}/hooks/logs"; do
  [ -d "$LOG_ROOT" ] || continue
  find "$LOG_ROOT" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf {} + 2>/dev/null
done
# 旧パスのログ置き場が空になったら片付ける。
rmdir "${CLAUDE_DIR}/hooks/logs" "${CLAUDE_DIR}/hooks" 2>/dev/null

exit 0
