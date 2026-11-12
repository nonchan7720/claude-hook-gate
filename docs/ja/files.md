# ルールとファイル

[← README](../../README_ja.md) · [English](../files.md)

## 置き場所

| ファイル | 場所 |
| --- | --- |
| ゲートの定義 | `<project>/.claude/gate.yaml`（無ければゲートは何もしません） |
| ルール（全プロジェクト） | `~/.claude/feedback/*.md`（`CLAUDE_FEEDBACK_DIR` で変更可） |
| ルール（そのプロジェクト） | `<project>/.claude/feedback/*.md`。同じ `name` ならこちらが優先 |
| 共通ルールファイル | `~/.claude/feedback-gate/feedback_rules.md`（無ければ同梱のもの） |
| ゲートの状態とログ | `<project>/.claude/.gate-status/`（`.gitignore` に足してください） |
| 違反ログ、エラーログ | `~/.claude/feedback/.violations.jsonl`、`.errors.jsonl` |

`.claude` の代わりに `.agents` も使えます。Claude Code は `.claude` を、Codex は `.agents` を先に見ます。一方を他方へのシンボリックリンクにしても構いません。

## ルールの frontmatter

| キー | 意味 |
| --- | --- |
| `name`、`description`、`type` | 必須。`type` は `feedback` |
| `count` | 強制力。3 以上で注入・強制（[README](../../README_ja.md#2-指摘をルールにする)） |
| `enforce` | hook が検知する条件（`pre_bash` / `pre_edit` / `post_edit` / `stop_check`） |
| `files`、`exclude_files` | そのファイルに触れたときだけ注入する（[ファイル種別スコープのルール](hooks.md#ファイル種別スコープのルール)） |
| `expires` | この日時を過ぎたら無効（`YYYY-MM-DD` か ISO 8601） |
| `projects` | 一致するプロジェクト（絶対パスの glob）でだけ有効 |
| `when_exists` | 一致するファイルがあるプロジェクトでだけ有効 |

書式の全体と例は [`skills/feedback/reference.md`](../../skills/feedback/reference.md) と [`examples.md`](../../skills/feedback/examples.md) にあります。

## 共通ルールファイル

毎回のプロンプトに足されるファイルです。既定では同梱の `rules/feedback_rules.md`（英語なら `rules/feedback_rules.en.md`）を使います。差し替えるには、`rulesFile` のパスに自分のファイルを置きます。置けば同梱のものの代わりに使われます。

`~/.claude/rules/` には置かないでください。Claude Code 自身がそこを読むので二重に入ります。

## 壊れたルール

1 つのルールファイルの不備で、他のルールが無効になることはありません。

| 不備 | 扱い |
| --- | --- |
| frontmatter が YAML として読めない | そのファイルだけ飛ばす |
| `enforce` がリストでない | `enforce` を空として扱う |
| `enforce` の要素が不正（辞書でない、正規表現が使えない） | その要素だけ捨てる |

- 壊れたファイルと理由は `.errors.jsonl` に記録し、直すまで毎回のプロンプトの先頭に一覧を出します。`/correct` でも `broken` として出ます。
- 正規表現は Python の `re` の書き方で書きます。先頭の `(?i)` / `(?s)` / `(?m)`、`(?P<name>...)`、`\A` / `\Z` は使えます。先頭の `(?x)`、途中のインラインフラグ、`a*+`、`(?#...)` は使えません。

## 実行中の表示

ゲートのコマンドが走っている間、プロンプトの上に一覧が出ます。

```
[gate] 実行中:
  typecheck ✓ (0.7s)
  lint ✗ (0.2s)
  test $ bun run test (8s)
```

- 同じセッションのメインとサブエージェントの分をまとめて表示します。`待機中` は、別のエージェントの同じ実行の完了を待っているコマンドです（[エージェント間の実行共有](gate.md#エージェント間の実行共有)）。
- すべて終わると一覧は消え、`[gate] 完了: ✓ 5 / ✗ 1 (81.0s)` がステータス行に残ります。どれが落ちたかは Stop hook の出力に出ます。
- ルールの評価中は、ステータス行に `[feedback-guard] 評価中: <rule>` などが出ます。
