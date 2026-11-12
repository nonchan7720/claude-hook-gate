# 組織管理の環境

[← README](../../README_ja.md) · [English](../managed-environments.md)

Team / Enterprise ログインや managed settings の Claude Code では、組み込みのガードがプラグインの関数 hook（mod）を飛ばします（`/plugin` に「Its hooks on classic.SessionStart, ... do not run here」と出ます）。Cowork でも mod は動きません。

そこで同じ検査を、`hooks/hooks.json` の command hook から Go 製バイナリ `feedback-gate` で行います。判定（拒否・確認・ブロック・追加するコンテキスト）は mod と同じです。

## バイナリの入手

`scripts/hook.sh` が次の順に探します。

1. 環境変数 `FEEDBACK_GATE_BIN`（実行できるファイルのパス）
2. キャッシュ: `${FEEDBACK_GATE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/feedback-gate}/<version>/feedback-gate`
3. GitHub のリリースからダウンロード（`feedback-gate_<os>_<arch>.tar.gz` と `checksums.txt`。SHA-256 を照合してからキャッシュに置く）

- バージョンは常にインストール済みのプラグインと一致します。
- ダウンロードはバージョンごとに 1 回で、最初のフック（SessionStart）の中で行います。避けたいときは `FEEDBACK_GATE_BIN` を指定します。
- 対応するのは linux / darwin の amd64 / arm64 です。
- 30 日より長く使われていない別バージョンのキャッシュは自動で消します。
- `FEEDBACK_GATE_RELEASE_BASE_URL` でダウンロード元を差し替えられます。

## 取得できないとき

バイナリが無くダウンロードもできなければ、フックは何もせずに終わり（作業は止めません）、標準エラーに 1 行だけ出します。

```
feedback-gate: could not install the feedback-gate v<version> binary (<reason>); the hook did nothing
```

| `<reason>` | 原因 |
| --- | --- |
| `no-download-tool` | `curl` も `wget` も無い |
| `no-sha256-tool` | `sha256sum` も `shasum` も無い |
| `download-failed` | ネットワークに届かない |
| `checksum-mismatch` | チェックサムが合わない |
| `unsupported-platform` | 未対応の OS / CPU |
| `extract-failed`、`cache-unwritable`、`no-cache-dir`、`bad-version` | 展開やキャッシュへの書き込みができない |

## mod との関係

- **二重に動かない。** mod が動く環境では、mod がセッションごとの印を書き、command hook はそれを見て何もしません。
- **設定。** プラグイン設定は環境変数 `CLAUDE_PLUGIN_OPTION_language` などで渡されます。
- **表示の違い。** 評価中にステータス行へ出す表示は mod だけの機能です。
