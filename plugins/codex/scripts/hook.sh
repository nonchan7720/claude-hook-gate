#!/bin/bash
# Codex の command hook の入口: `hook.sh <Event>` → `feedback-gate codex <Event>`（Go 製のバイナリ）。
# バイナリは FEEDBACK_GATE_BIN、無ければキャッシュ、無ければこのプラグインのバージョンのリリースから取ってくる（scripts/install-binary.sh）。
# 使えなければ（curl も wget も無い、取得失敗、チェックサム不一致など）何もせず exit 0。
# プラグインのルートはリポジトリのルート（rules/ や scripts/ を二重に持たないため）。
set -uo pipefail

EVENT="${1:-}"
[ -n "$EVENT" ] || exit 0

# Codex は PLUGIN_ROOT を渡す。~/.codex/hooks.json から直接呼ばれたときはこのファイルの場所から求める。
ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$ROOT" ] || ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
export CLAUDE_PLUGIN_ROOT="$ROOT"

# shellcheck source=../../../scripts/install-binary.sh
. "$SCRIPT_DIR/../../../scripts/install-binary.sh" 2>/dev/null || exit 0
BIN="$(feedback_gate_binary "$ROOT")" || exit 0
[ -n "$BIN" ] || exit 0

exec "$BIN" codex "$EVENT"
