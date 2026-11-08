#!/bin/bash
# hook 一覧の画面を出す: `hook-list.sh [claude|codex] [--no-open]`。
# feedback-gate バイナリ（Go）の `<host> hook-list` を呼ぶだけの入口。一覧の HTML を書き出してブラウザで開き、
# 結果（開いたファイルのパス）を 1 行出す。Claude Code の /hook-list（mod、src/hook-list.ts）とスキル
# /feedback-gate:hook-list、Codex からはこれを実行する。
# バイナリは FEEDBACK_GATE_BIN、無ければキャッシュ、無ければリリースから取ってくる（scripts/install-binary.sh）。
set -uo pipefail

HOST="${1:-claude}"
case "$HOST" in
  claude | codex) shift || true ;;
  *) HOST=claude ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -n "$ROOT" ] || ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export CLAUDE_PLUGIN_ROOT="$ROOT"

# shellcheck source=install-binary.sh
if ! . "$SCRIPT_DIR/install-binary.sh" 2>/dev/null; then
  echo "[hook-list] could not load scripts/install-binary.sh" >&2
  exit 1
fi
BIN="$(feedback_gate_binary "$ROOT")"
if [ -z "$BIN" ]; then
  # 取得できなかった理由は feedback_gate_binary が標準エラーに 1 行出している。
  exit 1
fi

exec "$BIN" "$HOST" hook-list "$@"
