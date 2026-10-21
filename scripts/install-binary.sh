#!/bin/bash
# hook.sh から source される: feedback-gate バイナリ（Go 製）の場所を求め、無ければリリースから取ってくる。
#
#   feedback_gate_binary <plugin root>   # 標準出力にバイナリのパスを 1 行だけ書く。使えなければ何も書かず 1 を返す（hook.sh は exit 0 にする）。
#
# 探す順序:
#   1. FEEDBACK_GATE_BIN（実行できるファイル）。開発とテスト用。
#   2. ${FEEDBACK_GATE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/feedback-gate}/<version>/feedback-gate
#      <version> は <plugin root>/.claude-plugin/plugin.json の "version"（release-please がタグ vX.Y.Z と同じ値に保つ）。
#   3. 無ければ ${FEEDBACK_GATE_RELEASE_BASE_URL:-https://github.com/nonchan7720/claude-hook-gate/releases/download}/v<version>/
#      feedback-gate_<os>_<arch>.tar.gz と checksums.txt を取り、sha256 を照合してから展開してキャッシュに置く（GoReleaser の成果物）。
# どこかで失敗したら（curl も wget も無い、取得失敗、チェックサム不一致、未対応の OS）何も書かずに 1 を返す。フックは何もしない。

feedback_gate_fetch() { # <url> <output file>
  if command -v curl >/dev/null 2>&1 && curl -fsSL "$1" -o "$2" >/dev/null 2>&1; then
    return 0
  fi
  if command -v wget >/dev/null 2>&1 && wget -qO "$2" "$1" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

feedback_gate_sha256() { # <file> → 小文字の 16 進
  local out
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$1" 2>/dev/null)" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$1" 2>/dev/null)" || return 1
  else
    return 2
  fi
  printf '%s' "${out%% *}" | tr 'A-F' 'a-f'
}

feedback_gate_install() { # <version> <os> <arch> <cache version dir> <destination>
  local version="$1" os="$2" arch="$3" vdir="$4" bin="$5"
  local base="${FEEDBACK_GATE_RELEASE_BASE_URL:-https://github.com/nonchan7720/claude-hook-gate/releases/download}"
  base="${base%/}"
  local archive="feedback-gate_${os}_${arch}.tar.gz"
  local url="$base/v$version"
  local tmp
  mkdir -p "$vdir" 2>/dev/null || return 1
  # 展開先は vdir の中に作る（最後の mv が同じファイルシステム内の rename になり、並列に走る別のフックが半端なファイルを見ない）。
  tmp="$(mktemp -d "$vdir/.download.XXXXXX" 2>/dev/null)" || return 1

  local ok=1
  while :; do
    feedback_gate_fetch "$url/$archive" "$tmp/$archive" || break
    # チェックサム: sha256sum か shasum がある環境では照合する（無ければ照合できないので省く）。
    local actual rc=0
    actual="$(feedback_gate_sha256 "$tmp/$archive")" || rc=$?
    if [ "$rc" -eq 1 ]; then
      break
    elif [ "$rc" -eq 0 ]; then
      feedback_gate_fetch "$url/checksums.txt" "$tmp/checksums.txt" || break
      local expected
      expected="$(sed -n "s/^\([0-9A-Fa-f]\{64\}\)[[:space:]]\{1,\}\*\{0,1\}$archive\$/\1/p" "$tmp/checksums.txt" | head -n 1 | tr 'A-F' 'a-f')"
      [ -n "$expected" ] && [ "$expected" = "$actual" ] || break
    fi
    mkdir "$tmp/extract" 2>/dev/null || break
    tar -xzf "$tmp/$archive" -C "$tmp/extract" >/dev/null 2>&1 || break
    [ -f "$tmp/extract/feedback-gate" ] || break
    chmod +x "$tmp/extract/feedback-gate" 2>/dev/null || break
    mv -f "$tmp/extract/feedback-gate" "$bin" 2>/dev/null || break
    ok=0
    break
  done
  rm -rf "$tmp" 2>/dev/null
  return "$ok"
}

feedback_gate_binary() { # <plugin root>
  if [ -n "${FEEDBACK_GATE_BIN:-}" ] && [ -x "$FEEDBACK_GATE_BIN" ]; then
    printf '%s\n' "$FEEDBACK_GATE_BIN"
    return 0
  fi

  local root="$1" manifest="$1/.claude-plugin/plugin.json" version=""
  [ -f "$manifest" ] || return 1
  if command -v jq >/dev/null 2>&1; then
    version="$(jq -r '.version // empty' "$manifest" 2>/dev/null)"
  else
    version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" 2>/dev/null | head -n 1)"
  fi
  # パスと URL に使うので、バージョンに使える文字だけを通す。
  case "$version" in
    '' | *[!0-9A-Za-z.+_-]*) return 1 ;;
  esac

  local os arch
  case "$(uname -s 2>/dev/null)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) return 1 ;;
  esac
  case "$(uname -m 2>/dev/null)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) return 1 ;;
  esac

  local cache="${FEEDBACK_GATE_CACHE_DIR:-}"
  if [ -z "$cache" ]; then
    if [ -n "${XDG_CACHE_HOME:-}" ]; then
      cache="$XDG_CACHE_HOME/feedback-gate"
    elif [ -n "${HOME:-}" ]; then
      cache="$HOME/.cache/feedback-gate"
    else
      return 1
    fi
  fi
  local vdir="$cache/$version" bin="$cache/$version/feedback-gate"

  if [ ! -x "$bin" ]; then
    feedback_gate_install "$version" "$os" "$arch" "$vdir" "$bin" || return 1
    # 新しく入れたときだけ、古いバージョンのキャッシュを片付ける（現在のバージョンは残す）。
    local d
    for d in "$cache"/[0-9]*; do
      [ -d "$d" ] && [ "$d" != "$vdir" ] && rm -rf "$d" 2>/dev/null
    done
  fi
  printf '%s\n' "$bin"
}
