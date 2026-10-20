#!/bin/bash
# Codex の command hook の入口: `hook.sh <Event>` → `node plugins/codex/hooks/cli.js <Event>`（node が無ければ bun、どちらも無ければ exit 0）。
# プラグインのルートはリポジトリのルート（rules/ や scripts/dogwood/ を二重に持たないため）。
set -uo pipefail

EVENT="${1:-}"
[ -n "$EVENT" ] || exit 0

RUNTIME="$(command -v node 2>/dev/null || command -v bun 2>/dev/null || true)"
[ -n "$RUNTIME" ] || exit 0

# Codex は PLUGIN_ROOT を渡す。~/.codex/hooks.json から直接呼ばれたときはこのファイルの場所から求める。
ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export CLAUDE_PLUGIN_ROOT="$ROOT"

exec "$RUNTIME" "$ROOT/plugins/codex/hooks/cli.js" "$EVENT"
