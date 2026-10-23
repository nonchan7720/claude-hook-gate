#!/bin/bash
# UserPromptSubmit が毎回のプロンプトに足す内容（rules ファイルと確定した feedback ルール）を標準出力に出す: `feedback-gate codex print-rules`。
# Codex がどの hook も走らせない環境（管理者の allow_managed_hooks_only で、管理者が managed hooks を配ってくれない）で、
# ~/.codex/AGENTS.md かプロジェクトの AGENTS.md に貼るためのもの。現在のディレクトリのプロジェクトのルールも含む。
# バイナリは hook.sh と同じく FEEDBACK_GATE_BIN、無ければキャッシュ、無ければリリースから取ってくる（scripts/install-binary.sh）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
export CLAUDE_PLUGIN_ROOT="$ROOT"

# shellcheck source=../../../scripts/install-binary.sh
if ! . "$SCRIPT_DIR/../../../scripts/install-binary.sh" 2>/dev/null; then
  echo "feedback-gate: scripts/install-binary.sh not found next to $SCRIPT_DIR" >&2
  exit 1
fi
BIN="$(feedback_gate_binary "$ROOT")" || exit 1
[ -n "$BIN" ] || exit 1

exec "$BIN" codex print-rules "$@"
