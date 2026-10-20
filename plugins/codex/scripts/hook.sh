#!/bin/bash
# Codex プラグイン（plugins/codex）の command hook の入口: `hook.sh <Event>`。
# Codex の hook は Claude Code の classic コマンド hook と同じ規約（stdin の JSON と戻り値: exit 2 / permissionDecision /
# decision: block / additionalContext）なので、ここから hooks/cli.js（src/codex-cli.ts → src/hooks.ts）を呼んで同じ処理をさせる。
# Claude Code 版（scripts/hook.sh）と違い、Codex には mod（register.js）が無いので二重起動の判定は無い。
# cli.js には node（無ければ bun）が要る。どちらも無ければ何もせず exit 0。
#
# プラグインとして入れたときは Codex が CLAUDE_PLUGIN_ROOT（PLUGIN_ROOT の別名）を渡す。~/.codex/hooks.json から直接
# 呼ぶときはこのファイルの場所から求める。
set -uo pipefail

EVENT="${1:-}"
[ -n "$EVENT" ] || exit 0

RUNTIME="$(command -v node 2>/dev/null || command -v bun 2>/dev/null || true)"
[ -n "$RUNTIME" ] || exit 0

ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CLAUDE_PLUGIN_ROOT="$ROOT"

exec "$RUNTIME" "$ROOT/hooks/cli.js" "$EVENT"
