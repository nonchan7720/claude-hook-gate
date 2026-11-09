#!/bin/bash
# Codex にインストール済みの feedback-gate プラグインのうち最新のバージョンを探し、その install-hooks.sh を走らせる:
#   gh api repos/nonchan7720/claude-hook-gate/contents/plugins/codex/scripts/setup.sh -H "Accept: application/vnd.github.raw" | bash
#   curl -fsSL https://raw.githubusercontent.com/nonchan7720/claude-hook-gate/main/plugins/codex/scripts/setup.sh | bash
#   ... | bash -s -- --project        → 引数は install-hooks.sh にそのまま渡す（--project, --print, --remove など）
# プラグインは ${CODEX_HOME:-$HOME/.codex}/plugins/cache/hook-gate/feedback-gate/<version>/ から探す。
# FEEDBACK_GATE_PLUGIN_DIR にプラグインのルート（plugins/codex/scripts/install-hooks.sh を含むディレクトリ。チェックアウトでも可）を
# 指定すると、探さずにそれを使う。終了コードは install-hooks.sh のもの。
# `| bash` で標準入力から読まれるので、標準入力は読まず、$0 / BASH_SOURCE からパスを求めない。
set -uo pipefail

INSTALL_REL="plugins/codex/scripts/install-hooks.sh"
CACHE_DIR="${CODEX_HOME:-${HOME:-}/.codex}/plugins/cache/hook-gate/feedback-gate"

if [ -n "${FEEDBACK_GATE_PLUGIN_DIR:-}" ]; then
  ROOT="${FEEDBACK_GATE_PLUGIN_DIR%/}"
  if [ ! -f "$ROOT/$INSTALL_REL" ]; then
    printf 'feedback-gate: FEEDBACK_GATE_PLUGIN_DIR=%s has no %s\n' "$FEEDBACK_GATE_PLUGIN_DIR" "$INSTALL_REL" >&2
    exit 1
  fi
else
  ROOT=""
  best_major=-1 best_minor=-1 best_patch=-1 best_pre=""
  for dir in "$CACHE_DIR"/[0-9vV]*/; do
    dir="${dir%/}"
    [ -f "$dir/$INSTALL_REL" ] || continue
    name="${dir##*/}"
    name="${name#[vV]}"
    [[ "$name" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-([0-9A-Za-z.-]+))?(\+[0-9A-Za-z.-]+)?$ ]] || continue
    major=$((10#${BASH_REMATCH[1]})) minor=$((10#${BASH_REMATCH[2]})) patch=$((10#${BASH_REMATCH[3]}))
    pre="${BASH_REMATCH[5]}"
    newer=0
    if [ "$major" -ne "$best_major" ]; then
      [ "$major" -gt "$best_major" ] && newer=1
    elif [ "$minor" -ne "$best_minor" ]; then
      [ "$minor" -gt "$best_minor" ] && newer=1
    elif [ "$patch" -ne "$best_patch" ]; then
      [ "$patch" -gt "$best_patch" ] && newer=1
    elif [ -z "$ROOT" ]; then
      newer=1
    elif [ -z "$pre" ] && [ -n "$best_pre" ]; then
      newer=1 # 同じバージョンなら、プレリリースの無い方が新しい
    elif [ -n "$pre" ] && [ -n "$best_pre" ] && [[ "$pre" > "$best_pre" ]]; then
      newer=1
    fi
    if [ "$newer" -eq 1 ]; then
      ROOT="$dir" best_major=$major best_minor=$minor best_patch=$patch best_pre="$pre"
    fi
  done
  if [ -z "$ROOT" ]; then
    {
      printf 'feedback-gate: no installed feedback-gate plugin found in %s\n' "$CACHE_DIR"
      printf 'Install the plugin first:\n'
      printf '  codex plugin marketplace add nonchan7720/claude-hook-gate\n'
      printf 'then install feedback-gate from /plugins in Codex, and run this again.\n'
    } >&2
    exit 1
  fi
fi

printf 'feedback-gate: using %s\n' "$ROOT" >&2
exec "${BASH:-bash}" "$ROOT/$INSTALL_REL" "$@"
