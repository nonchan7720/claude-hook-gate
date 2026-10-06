#!/bin/bash
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$(cat 2>/dev/null || true)"

# gate が 1 つでも止めたらそこで終了し、通知は出さない
if [ -f "$HOOKS/stop-test-gate.sh" ]; then
  printf '%s' "$PAYLOAD" | bash "$HOOKS/stop-test-gate.sh" checks || exit $?
fi

if [ -f "$HOOKS/feedback-stop-check.py" ]; then
  printf '%s' "$PAYLOAD" | python3 "$HOOKS/feedback-stop-check.py" || exit $?
fi

# stop_hook_active は Stop hook のブロックで会話が継続している状態を指す。
# ここで通知すると「Stop hook feedback」のたびに鳴るため除外する
STOP_HOOK_ACTIVE="$(printf '%s' "$PAYLOAD" | jq -r '.stop_hook_active // false' 2>/dev/null)"

if [ -f "$HOOKS/notification.sh" ] && [ "$STOP_HOOK_ACTIVE" != "true" ]; then
  printf '%s' "$PAYLOAD" | bash "$HOOKS/notification.sh" stop
fi
