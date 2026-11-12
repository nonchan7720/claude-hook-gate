# セキュリティと権限

[← README](../../README_ja.md) · [English](../security.md)

このプラグインが何を読み、何を実行し、何を書き、何を判定するかの一覧です。組織管理の環境で動く Go 製バイナリにも同じことが当てはまります。

## ネットワークと認証情報

- プラグイン自身はネットワークに何も送りません。データが外に出るのは、あなたが `gate.yaml` やルールの `check` に書いたコマンドを通したときだけです。
- 例外は、組織管理の環境と Cowork でのバイナリの取得です（GitHub のリリースから、チェックサムを照合して取得）。
- トークン・鍵・パスワードは読みません。読む環境変数は、ファイルやプログラムの場所と言語を決めるものだけです（`HOME`、`PATH`、`LANG`、`CLAUDE_FEEDBACK_DIR`、`DOGWOOD_BIN`、`FEEDBACK_GATE_LANG` など）。

## 読むもの

| 対象 | 内容 |
| --- | --- |
| 会話 | Bash / Edit / Write / MultiEdit の入力（コマンド、パス、新しい内容）。`agentLaunchGuard` が有効なら Agent / SendMessage の本文。通知の文面。トランスクリプトは読みません |
| ディスク | ルール、共通ルールファイル、`gate.yaml`、自分の状態ファイル、Claude が編集したファイル、git から見た作業ツリーの状態 |

## 実行するもの

| プログラム | 目的 |
| --- | --- |
| `sh -c` | `gate.yaml` のコマンドとルールの `check`（どちらもあなたが書くもの） |
| `git`（読み取りのみ） | リポジトリのルートと、Bash が変更したファイルを調べる |
| `sh`、`mkdir`、`mv`、`rm`、`rmdir`、`kill -0`、`sleep` | 自分の状態ファイルとロックを扱う |
| `dogwood`（任意） | ゲートのコマンドを今実行するかを決める |
| `osascript`、`terminal-notifier`（macOS） | デスクトップ通知 |

## 書くもの

- `<project>/.claude/.gate-status/`: ゲートの状態、コマンドのログ、ロック。
- `~/.claude/feedback/`: 違反ログ、エラーログ、セッションごとの状態。
- ルールファイルの `count:` の行（`autoCount` が有効なときと `/correct apply`）。それ以外の部分は変えません。
- 設定ファイル、`CLAUDE.md`、フックの設定は書きません。

## 判定とコンテキスト

- **権限の判定。** 返すのは `deny` と `ask` だけで、`allow` は返しません。呼び出しを厳しくすることはあっても、あなたの権限確認を飛ばすことはありません。権限モードや設定は変えません。
- **追加するコンテキスト。** 共通ルールファイルと確定ルール、ゲートの結果とルール違反、サブエージェントの検査結果を Claude に返します。
- **`stop_review`。** 有効なときは、変更ファイルのパスと `gate.yaml` の `prompt` を含む見直しの指示を返します。`prompt` は Claude への指示として届きます。
- **`effort-<level>` スキル。** そのターンの残りの effort を切り替えるだけです。ツールや権限は増やしません。

## 信頼していないリポジトリ

`gate.yaml` のコマンドはそのまま実行され、`stop_review.prompt` は Claude への指示になります。信頼していないリポジトリを開く前に、`gate.yaml` と `.claude/feedback/` の中身を確かめてください。

## 同梱ファイル

- `hooks/register.js` は `src/` から作るバンドルで、minify していません。
- `hooks/vendor/yaml.js` と `hooks/vendor/i18next.js` は npm パッケージ（版は `bun.lock` で固定）を minify したものです。
- プラグイン自身のコードは `Proxy`、`eval`、`new Function` を使っていません。
