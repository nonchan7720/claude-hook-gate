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
#      sha256sum も shasum も無い環境では照合できないので、検証せずに入れることはしない（入れない）。
# どこかで失敗したら（curl も wget も無い、取得失敗、チェックサム不一致、ハッシュのコマンドが無い、未対応の OS など）
# 標準出力には何も書かず、標準エラーに理由つきの 1 行だけを書いて 1 を返す。フックは何もしない（hook.sh は exit 0）:
#   feedback-gate: could not install the feedback-gate v<version> binary (<reason>); the hook did nothing
# <reason> は bad-version / unsupported-platform / no-cache-dir / no-download-tool / no-sha256-tool / cache-unwritable /
# download-failed / checksum-mismatch / extract-failed のどれか。バイナリが見つかったときは標準エラーにも何も書かない。
#
# キャッシュの片付け: 新しく入れたとき、現在のバージョン以外で 30 日より長く使われていない（mtime が古い）バージョンのディレクトリだけを消す。
# 使われたバージョンのディレクトリは、フックのたびに touch して「使用中」にする（Claude Code と Codex など、別のバージョンを
# 使う複数のインストールが互いのキャッシュを消し合わないようにするため）。

# 失敗の理由を FEEDBACK_GATE_REASON に入れる（feedback_gate_binary が 1 行の通知にする）。
FEEDBACK_GATE_REASON=""

feedback_gate_notice() { # <version> <reason>
  # バージョンは未検証の文字列かもしれないので、通知に出すときは安全な文字だけにする。
  local v="${1//[!0-9A-Za-z.+_-]/}"
  printf 'feedback-gate: could not install the feedback-gate v%s binary (%s); the hook did nothing\n' "$v" "$2" >&2
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

  # 必要な道具は、何かを作る前に確かめる。
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    FEEDBACK_GATE_REASON="no-download-tool"
    return 1
  fi
  # チェックサムは必須（照合できない環境では、検証しないまま入れることはしない）。
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    FEEDBACK_GATE_REASON="no-sha256-tool"
    return 1
  fi

  if ! mkdir -p "$vdir" 2>/dev/null; then
    FEEDBACK_GATE_REASON="cache-unwritable"
    return 1
  fi
  # タイムアウトで殺されたフックが残した作業ディレクトリ（60 分より古いもの）を片付ける。
  if command -v find >/dev/null 2>&1; then
    find "$vdir" -mindepth 1 -maxdepth 1 -type d -name '.download.*' -mmin +60 -exec rm -rf {} + >/dev/null 2>&1 || true
  fi
  # 展開先は vdir の中に作る（最後の mv が同じファイルシステム内の rename になり、並列に走る別のフックが半端なファイルを見ない）。
  if ! tmp="$(mktemp -d "$vdir/.download.XXXXXX" 2>/dev/null)"; then
    FEEDBACK_GATE_REASON="cache-unwritable"
    return 1
  fi

  local ok=1
  while :; do
    feedback_gate_fetch "$url/$archive" "$tmp/$archive" || { FEEDBACK_GATE_REASON="download-failed"; break; }
    local actual expected
    actual="$(feedback_gate_sha256 "$tmp/$archive")" || { FEEDBACK_GATE_REASON="checksum-mismatch"; break; }
    feedback_gate_fetch "$url/checksums.txt" "$tmp/checksums.txt" || { FEEDBACK_GATE_REASON="download-failed"; break; }
    expected="$(sed -n "s/^\([0-9A-Fa-f]\{64\}\)[[:space:]]\{1,\}\*\{0,1\}$archive\$/\1/p" "$tmp/checksums.txt" | head -n 1 | tr 'A-F' 'a-f')"
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
      FEEDBACK_GATE_REASON="checksum-mismatch"
      break
    fi
    FEEDBACK_GATE_REASON="extract-failed"
    mkdir "$tmp/extract" 2>/dev/null || break
    tar -xzf "$tmp/$archive" -C "$tmp/extract" >/dev/null 2>&1 || break
    [ -f "$tmp/extract/feedback-gate" ] || break
    chmod +x "$tmp/extract/feedback-gate" 2>/dev/null || break
    mv -f "$tmp/extract/feedback-gate" "$bin" 2>/dev/null || break
    FEEDBACK_GATE_REASON=""
    ok=0
    break
  done
  rm -rf "$tmp" 2>/dev/null
  return "$ok"
}

# 失敗の通知（標準エラーに 1 行）を出して 1 を返す。
feedback_gate_fail() { # <version> <reason>
  feedback_gate_notice "$1" "$2"
  return 1
}

feedback_gate_binary() { # <plugin root>
  if [ -n "${FEEDBACK_GATE_BIN:-}" ] && [ -x "$FEEDBACK_GATE_BIN" ]; then
    printf '%s\n' "$FEEDBACK_GATE_BIN"
    return 0
  fi

  local root="$1" manifest="$1/.claude-plugin/plugin.json" version=""
  [ -f "$manifest" ] || feedback_gate_fail "" "bad-version" || return 1
  if command -v jq >/dev/null 2>&1; then
    version="$(jq -r '.version // empty' "$manifest" 2>/dev/null)"
  else
    version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" 2>/dev/null | head -n 1)"
  fi
  # パスと URL に使うので、バージョンに使える文字だけを通す。
  case "$version" in
    '' | *[!0-9A-Za-z.+_-]*) feedback_gate_fail "$version" "bad-version"; return 1 ;;
  esac

  local os arch
  case "$(uname -s 2>/dev/null)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) feedback_gate_fail "$version" "unsupported-platform"; return 1 ;;
  esac
  case "$(uname -m 2>/dev/null)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) feedback_gate_fail "$version" "unsupported-platform"; return 1 ;;
  esac

  local cache="${FEEDBACK_GATE_CACHE_DIR:-}"
  if [ -z "$cache" ]; then
    if [ -n "${XDG_CACHE_HOME:-}" ]; then
      cache="$XDG_CACHE_HOME/feedback-gate"
    elif [ -n "${HOME:-}" ]; then
      cache="$HOME/.cache/feedback-gate"
    else
      feedback_gate_fail "$version" "no-cache-dir"
      return 1
    fi
  fi
  while [ "${#cache}" -gt 1 ] && [ "${cache%/}" != "$cache" ]; do cache="${cache%/}"; done
  local vdir="$cache/$version" bin="$cache/$version/feedback-gate"

  if [ -x "$bin" ]; then
    # 使っているバージョンは「新しい」ままにする（古いバージョンの片付けで消されないように）。フックごとに 1 回。
    if command -v touch >/dev/null 2>&1; then touch "$vdir" 2>/dev/null || true; fi
  else
    if ! feedback_gate_install "$version" "$os" "$arch" "$vdir" "$bin"; then
      feedback_gate_fail "$version" "${FEEDBACK_GATE_REASON:-extract-failed}"
      return 1
    fi
    # 新しく入れたときだけ、30 日より長く使われていない別バージョンのキャッシュを片付ける（現在のバージョンは残す）。
    if command -v find >/dev/null 2>&1; then
      find "$cache" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' -mtime +30 ! -path "$vdir" -exec rm -rf {} + >/dev/null 2>&1 || true
    fi
  fi
  printf '%s\n' "$bin"
}
