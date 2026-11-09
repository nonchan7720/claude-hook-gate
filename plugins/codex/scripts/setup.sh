#!/bin/bash
# Codex にインストール済みの feedback-gate プラグインのうち最新のバージョンを探し、その install-hooks.sh を走らせる:
#   gh api repos/nonchan7720/claude-hook-gate/contents/plugins/codex/scripts/setup.sh -H "Accept: application/vnd.github.raw" | bash
#   curl -fsSL https://raw.githubusercontent.com/nonchan7720/claude-hook-gate/main/plugins/codex/scripts/setup.sh | bash
#   ... | bash -s -- --project        → 引数は install-hooks.sh にそのまま渡す（--project, --print, --remove など）
# プラグインは ${CODEX_HOME:-$HOME/.codex}/plugins/cache/hook-gate/feedback-gate/<version>/ から探す。
# FEEDBACK_GATE_PLUGIN_DIR にプラグインのルート（plugins/codex/scripts/install-hooks.sh を含むディレクトリ。チェックアウトでも可）を
# 指定すると、探さずにそれを使う。終了コードは install-hooks.sh のもの。
#
# 最初に Codex のプラグインを最新にする（--no-update で省く。このフラグは install-hooks.sh には渡さない）:
#   codex plugin marketplace upgrade hook-gate（未登録で失敗したら codex plugin marketplace add nonchan7720/claude-hook-gate）
#   → codex plugin add feedback-gate@hook-gate。codex が PATH に無ければ飛ばしてインストール済みのものを使う。
#   FEEDBACK_GATE_CODEX_BIN で codex の実行ファイルを差し替えられる。FEEDBACK_GATE_PLUGIN_DIR を指定したときも更新しない。
#   つまりコマンド feedback-gate-setup 一つで「プラグインの更新 + フックの更新」になる。
#
# install-hooks.sh の前に、このスクリプト自身をコマンド feedback-gate-setup として
# ${FEEDBACK_GATE_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}} に置く（次回からは `feedback-gate-setup [オプション]` だけでよい）。
#   - 置く元: 実ファイルとして実行されていればそのファイル、なければ選んだプラグインの plugins/codex/scripts/setup.sh、
#     それも無ければ GitHub（main）からダウンロード（FEEDBACK_GATE_SETUP_URL で URL を差し替え可）。置けなくても失敗にはしない。
#   - ディレクトリが PATH に無ければ、~/.zshrc（$SHELL が zsh）か ~/.bashrc（bash）に
#     「# feedback-gate-setup」の目印付きで export PATH=... を 1 回だけ追記する。それ以外のシェルでは行を表示するだけ。
#     FEEDBACK_GATE_NO_RC=1 なら rc ファイルには触らず、行を表示するだけ。
#   - --no-command を付けると置かない（このフラグは install-hooks.sh には渡さない）。
# `| bash` で標準入力から読まれるので、標準入力は読まず、$0 / BASH_SOURCE だけに頼らない。
set -uo pipefail

SETUP_REL="plugins/codex/scripts/setup.sh"
SETUP_URL="${FEEDBACK_GATE_SETUP_URL:-https://raw.githubusercontent.com/nonchan7720/claude-hook-gate/main/plugins/codex/scripts/setup.sh}"
CMD_NAME="feedback-gate-setup"

# --no-command と --no-update だけを取り除き、残りはそのまま install-hooks.sh へ渡す
install_command=1
do_update=1
fwd=()
for a in "$@"; do
  case "$a" in
    --no-command) install_command=0 ;;
    --no-update) do_update=0 ;;
    *) fwd+=("$a") ;;
  esac
done

MARKETPLACE_SOURCE="nonchan7720/claude-hook-gate"
MARKETPLACE_NAME="hook-gate"
PLUGIN_NAME="feedback-gate"
CODEX_BIN="${FEEDBACK_GATE_CODEX_BIN:-codex}"
update_note=""

# 標準入力は渡さない（パイプで流れてきたスクリプトを codex に食べさせない）
run_codex() {
  printf 'feedback-gate: running codex %s\n' "$*" >&2
  "$CODEX_BIN" "$@" </dev/null
}

update_plugin() {
  if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
    printf 'feedback-gate: codex not found in PATH; skipping the plugin update and using the installed plugin\n' >&2
    update_note="the plugin update was skipped (codex not found)"
    return 0
  fi
  if ! run_codex plugin marketplace upgrade "$MARKETPLACE_NAME"; then
    if ! run_codex plugin marketplace add "$MARKETPLACE_SOURCE"; then
      printf 'feedback-gate: could not update the %s marketplace; using the installed plugin if any\n' "$MARKETPLACE_NAME" >&2
      update_note="the plugin update failed (marketplace upgrade/add)"
      return 0
    fi
  fi
  if ! run_codex plugin add "$PLUGIN_NAME@$MARKETPLACE_NAME"; then
    printf 'feedback-gate: codex plugin add failed; using the installed plugin if any\n' >&2
    update_note="the plugin update failed (codex plugin add)"
  fi
  return 0
}

feedback_gate_fetch() { # <url> <output file>
  if command -v curl >/dev/null 2>&1 && curl -fsSL "$1" -o "$2" >/dev/null 2>&1; then
    return 0
  fi
  if command -v wget >/dev/null 2>&1 && wget -qO "$2" "$1" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

install_self_command() { # <plugin root>
  local root="$1" bin_dir dst src="" tmp
  bin_dir="${FEEDBACK_GATE_BIN_DIR:-${XDG_BIN_HOME:-${HOME:-}/.local/bin}}"
  while [ "${#bin_dir}" -gt 1 ] && [ "${bin_dir%/}" != "$bin_dir" ]; do bin_dir="${bin_dir%/}"; done
  dst="$bin_dir/$CMD_NAME"

  if [ -f "${BASH_SOURCE[0]:-}" ]; then
    src="${BASH_SOURCE[0]}"
  elif [ -f "$root/$SETUP_REL" ]; then
    src="$root/$SETUP_REL"
  fi

  if [ -n "$src" ] && [ "$src" -ef "$dst" ]; then
    : # インストール済みのコマンド自身を実行している
  else
    if ! mkdir -p "$bin_dir" 2>/dev/null; then
      printf 'feedback-gate: could not install %s: cannot create %s\n' "$CMD_NAME" "$bin_dir" >&2
      return 0
    fi
    tmp="$(mktemp "$bin_dir/.$CMD_NAME.XXXXXX" 2>/dev/null)" || {
      printf 'feedback-gate: could not install %s: cannot write to %s\n' "$CMD_NAME" "$bin_dir" >&2
      return 0
    }
    if [ -n "$src" ]; then
      cp "$src" "$tmp" 2>/dev/null || { rm -f "$tmp"; printf 'feedback-gate: could not install %s: copying %s failed\n' "$CMD_NAME" "$src" >&2; return 0; }
    elif ! feedback_gate_fetch "$SETUP_URL" "$tmp"; then
      rm -f "$tmp"
      printf 'feedback-gate: could not install %s: no local copy of setup.sh and downloading %s failed\n' "$CMD_NAME" "$SETUP_URL" >&2
      return 0
    fi
    if ! chmod 755 "$tmp" 2>/dev/null || ! mv -f "$tmp" "$dst" 2>/dev/null; then
      rm -f "$tmp"
      printf 'feedback-gate: could not install %s: cannot write %s\n' "$CMD_NAME" "$dst" >&2
      return 0
    fi
    printf 'feedback-gate: installed %s into %s\n' "$CMD_NAME" "$bin_dir" >&2
  fi

  # PATH に無ければ rc ファイルに追記する
  local on_path=0 p dir
  while IFS= read -r -d ':' p || [ -n "$p" ]; do
    while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
    if [ "$p" = "$bin_dir" ]; then on_path=1; break; fi
    p=""
  done <<<"${PATH:-}:"
  [ "$on_path" -eq 1 ] && return 0

  local line rc="" rc_label=""
  if [ -n "${HOME:-}" ] && [ "${bin_dir#"$HOME"/}" != "$bin_dir" ]; then
    dir="\$HOME/${bin_dir#"$HOME"/}"
  else
    dir="$bin_dir"
  fi
  line="export PATH=\"$dir:\$PATH\""
  case "${SHELL:-}" in
    *zsh) rc="${HOME:-}/.zshrc" rc_label="~/.zshrc" ;;
    *bash) rc="${HOME:-}/.bashrc" rc_label="~/.bashrc" ;;
  esac
  if [ -z "$rc" ] || [ -n "${FEEDBACK_GATE_NO_RC:-}" ] || [ -z "${HOME:-}" ]; then
    printf 'feedback-gate: %s is not in PATH; add this line to your shell rc file and open a new shell:\n  %s\n' "$bin_dir" "$line" >&2
    return 0
  fi
  if [ -f "$rc" ] && grep -qxF '# feedback-gate-setup' "$rc" 2>/dev/null; then
    printf 'feedback-gate: %s already has the %s PATH entry; open a new shell (or source %s) to use it\n' "$rc_label" "$CMD_NAME" "$rc_label" >&2
    return 0
  fi
  if printf '\n# feedback-gate-setup\n%s\n' "$line" >>"$rc" 2>/dev/null; then
    printf 'feedback-gate: added %s to PATH in %s; open a new shell (or source %s) to use it\n' "$bin_dir" "$rc_label" "$rc_label" >&2
  else
    printf 'feedback-gate: could not write %s; add this line yourself and open a new shell:\n  %s\n' "$rc_label" "$line" >&2
  fi
  return 0
}

INSTALL_REL="plugins/codex/scripts/install-hooks.sh"
CACHE_DIR="${CODEX_HOME:-${HOME:-}/.codex}/plugins/cache/hook-gate/feedback-gate"

if [ "$do_update" -eq 1 ] && [ -z "${FEEDBACK_GATE_PLUGIN_DIR:-}" ]; then
  update_plugin
fi

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
      [ -n "$update_note" ] && printf 'Note: %s.\n' "$update_note"
      printf 'Install the plugin first:\n'
      printf '  codex plugin marketplace add nonchan7720/claude-hook-gate\n'
      printf 'then install feedback-gate from /plugins in Codex, and run this again.\n'
    } >&2
    exit 1
  fi
fi

printf 'feedback-gate: using %s\n' "$ROOT" >&2
[ "$install_command" -eq 1 ] && { install_self_command "$ROOT" || true; }
exec "${BASH:-bash}" "$ROOT/$INSTALL_REL" ${fwd[@]+"${fwd[@]}"}
