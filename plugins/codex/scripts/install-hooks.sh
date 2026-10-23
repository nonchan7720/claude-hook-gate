#!/bin/bash
# Codex がプラグイン同梱の hook を走らせない環境向けに、plugins/codex/hooks/hooks.json を Codex が読む hooks.json に写す:
#   install-hooks.sh                      → ~/.codex/hooks.json（$CODEX_HOME/hooks.json）に足す（既存の他の hook は残す。何度実行しても 1 組）
#   install-hooks.sh --project [<dir>]    → <dir>/.codex/hooks.json（既定は現在のディレクトリ）
#   install-hooks.sh --to <hooks.json>    → 任意のファイル
#   install-hooks.sh --print              → hooks.json の内容を標準出力に（/etc/codex/hooks.json など、管理者が配るとき）
#   install-hooks.sh --toml               → requirements.toml の [hooks] の形で標準出力に（allow_managed_hooks_only の環境）
#   install-hooks.sh --remove [...]       → 写しから外す
# 本体は `feedback-gate codex install-hooks`（internal/hookgate/codex_install_hooks.go）。バイナリは hook.sh と同じく
# FEEDBACK_GATE_BIN、無ければキャッシュ、無ければリリースから取ってくる（scripts/install-binary.sh）。
# プラグインのルートはこのファイルの場所から求める（リポジトリのチェックアウトか、Codex が展開したプラグインのディレクトリ）。
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

exec "$BIN" codex install-hooks --root "$ROOT" "$@"
