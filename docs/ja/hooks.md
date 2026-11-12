# フック

[← README](../../README_ja.md) · [English](../hooks.md)

どのイベントで何が動くかの一覧です。組織管理の環境と Cowork では同じ処理を Go 製バイナリが行います（[組織管理の環境](managed-environments.md)）。

| イベント | 何をするか |
| --- | --- |
| SessionStart | 新しいセッションと `/clear` のとき、自セッションのゲート状態を消す（resume / compact では残す）。続けて `gate.yaml` の [`session_start`](gate.md#session_start) を実行する |
| UserPromptSubmit | 共通ルールファイルと、確定したルール（`count >= 3`）をコンテキストに足す |
| PreToolUse（Bash / Edit / Write / MultiEdit） | `pre_bash` / `pre_edit` を評価し、`count` に応じて拒否・確認・警告する |
| PostToolUse（Read） | 読んだファイルに `files` が一致する確定ルールを足す |
| PostToolUse（Edit / Write / MultiEdit / Bash） | 変更ファイルを記録し、`post_edit` を評価し、`gate.yaml` の該当する `rules` を実行する |
| PreToolUse（Agent / SendMessage） | [`agentLaunchGuard`](settings.md#エージェント起動ガード) が有効なときだけ、送る本文を見せて確認する |
| Notification | 確認待ちをデスクトップ通知する |
| Stop | ゲートの停止時チェック → `stop_check` → [`stop_review`](gate.md#stop_review) → 完了通知、の順に実行する |
| SubagentStop | Stop と同じ検査をサブエージェントに行い、結果を呼び出し元へ渡す |
| PostToolUse（Agent） | 終わったサブエージェントの検査結果を、呼び出し元のコンテキストに足す |

ルールを新しく作ろうとしたとき（feedback ディレクトリへの新規 `*.md`）は、最初の 1 回だけ止めて既存ルールの一覧を返します。同じ指摘のルールがあれば、新しく作らずにそれを更新させるためです。

## Bash で書いたファイル

Edit / Write を使わずに Bash で書いても、同じ検査がかかります。

| 書き方 | 検査のタイミング |
| --- | --- |
| 書き先と本文が文面にある heredoc（`cat > path <<'EOF'`、`tee path <<EOF` など） | 実行前に `pre_edit`（Write と同じ） |
| それ以外（`python`、`sed -i`、実行時に書き先が決まる heredoc など） | 実行後に `post_edit` と `pre_edit` |

- 実行後の検査では書き込みが済んでいるので、拒否・確認は「直すまでブロック」になります。
- 実行後に拾うのは、git が変更・未追跡と見ているファイルのうち、更新時刻がコマンド開始以降のものです。`.gitignore` されたファイルと作業ツリーの外は対象外です。
- 読むだけのコマンド（`ls`・`cat`・`grep`・`git log` など）と、git の履歴操作（rebase / checkout / merge など）は検査しません。知らないコマンドは「書くかもしれない」ものとして検査します。

## ファイル種別スコープのルール

<a id="file-scoped-rules"></a>特定の言語やファイル種別だけに関係するルールは、frontmatter に `files` を書くと、そのファイルに触れたときだけ注入されます。

```yaml
files: ['**/*.go']
exclude_files: ['**/*_test.go']   # 任意
```

- 毎回のプロンプトには出ません。一致するファイルを読んだ・編集した直後に、ターンごと・ルールごとに 1 回だけ出ます。
- そのルールの `pre_edit` / `post_edit` は、`path` を省略すると `files` を使います。
- `expires` / `projects` / `when_exists` による有効・無効は、`files` とは別に効きます。
- Codex には `Read` が無いので、編集したときにだけ届きます。

## 同じ作業ツリーの複数セッション

Bash の変更検出は更新時刻しか見ないので、同じ作業ツリーで別のセッションが書いたファイルを区別できません。取り違えを減らすために次のようにしています。

- 読むだけのコマンドでは変更検出をしない。
- 別のセッションがすでに自分の変更として持っているファイルは記録しない。

2 つのセッションが同時に編集するなら、worktree（`.claude/worktrees/<name>`）を分けてください。

## サブエージェントの結果

<a id="results-of-subagents"></a>サブエージェントの停止時に走ったゲートと `stop_check` の結果は、呼び出し元の `Agent` の結果に足されます。呼び出し元がログを読んだり検証をやり直したりしなくて済みます。

```
[feedback-gate] サブエージェント code-implementer (a1b2c3) の停止時に実行された hook（gate の検証と feedback の stop_check）の結果です。…
[gate] 検証がすべて通りました: lint ✓ / typecheck ✓ / test ✓
```

バックグラウンドで起動したサブエージェントの結果は渡されません。

全体の流れは [README のシーケンス図](../../README_ja.md#動きの流れ) にあります。
