#!/bin/bash
# Codex の command hook の入口: `hook.sh <Event>` → `feedback-gate codex <Event>`（Go 製のバイナリ）。
# プラグイン同梱の hooks.json からも、install-hooks.sh が ~/.codex/hooks.json などに書いた写しからも、同じこのファイルが呼ばれる。
# バイナリは FEEDBACK_GATE_BIN、無ければキャッシュ、無ければこのプラグインのバージョンのリリースから取ってくる（scripts/install-binary.sh）。
# 使えなければ（curl も wget も無い、取得失敗、チェックサム不一致、sha256sum / shasum が無いなど）何もせず exit 0（標準エラーに理由つきの 1 行だけを出す）。
# プラグインのルートはリポジトリのルート（rules/ や scripts/ を二重に持たないため）。
set -uo pipefail

EVENT="${1:-}"
[ -n "$EVENT" ] || exit 0

# Codex は PLUGIN_ROOT を渡す。~/.codex/hooks.json から直接呼ばれたときはこのファイルの場所から求める。
ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"

# どの層から呼ばれたかをバイナリに伝える（FEEDBACK_GATE_HOOK_SOURCE）。Codex はプラグイン同梱の hooks.json の hook にだけ PLUGIN_ROOT を
# 渡すので、それがあれば "plugin"、無ければ設定層への写し（~/.codex/hooks.json、.codex/hooks.json、管理者の hooks。install-hooks.sh が書く）
# からの呼び出し "config"。同じセッションで両方が走る環境では、plugin の側だけが働き、写しは黙る（host_codex.go の CodexHookSourceAllows）。
if [ -n "${PLUGIN_ROOT:-}" ]; then
  export FEEDBACK_GATE_HOOK_SOURCE=plugin
else
  export FEEDBACK_GATE_HOOK_SOURCE=config
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$ROOT" ] || ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
export CLAUDE_PLUGIN_ROOT="$ROOT"

# shellcheck source=../../../scripts/install-binary.sh
. "$SCRIPT_DIR/../../../scripts/install-binary.sh" 2>/dev/null || exit 0
BIN="$(feedback_gate_binary "$ROOT")" || exit 0
[ -n "$BIN" ] || exit 0

exec "$BIN" codex "$EVENT"
