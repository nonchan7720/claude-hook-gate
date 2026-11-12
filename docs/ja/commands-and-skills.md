# コマンドとスキル

[← README](../../README_ja.md) · [English](../commands-and-skills.md)

## コマンド

### `/correct`

繰り返す間違いを、最も効く層で直すためのコマンドです。feedback ルール（`~/{.claude,.agents}/feedback/*.md` と `<project>/{.claude,.agents}/feedback/*.md`）と違反ログ（`~/.claude/feedback/.violations.jsonl`）を集計し、締め直しの提案を出します。`src/register.ts` が `session.start` で登録し、ロジックは `src/correct.ts` にあります。

```
/correct [--window 30d] [--min 2] [apply]
```

- `--window`: 違反を数える期間。`Nd` または `Nh`（既定 `30d`）。
- `--min`: 提案を出す窓内の最小違反回数（既定 `2`）。
- `apply`: `bump` の提案をルールファイルに書き込みます（下記）。付けなければ何も変更しません。

不明な引数は無視します。提案は次の 5 種類で、この順に並びます。

| 種類 | 条件 | 提案 |
| --- | --- | --- |
| `broken` | ルールファイルが読めない、または `enforce` の要素が不正（[壊れたルール](files.md#broken-rules)を参照）。ルール名はファイル名から `.md` を除いたもの。 | ファイルの修正。理由を添えます。 |
| `bump` | 有効なルールの窓内の違反が `--min` 回以上。 | `count` 1〜2 は 3 へ（確定ルールに昇格）。`count` 3〜4 で窓内の `ask` / `block` が `--min` 回以上なら 5（`deny`）へ。`count` 5 以上は提案しません。 |
| `enforce` | 有効なルールが `count >= 3` なのに `enforce` が無い。hook が検知できず、違反ログにも出ない。 | `enforce` の追加。4 イベント分の雛形を添えます。 |
| `stale` | 有効なルールが `count >= 3` で `enforce` もあるが、違反ログに一度も出ていない。 | `enforce` が効いているか、ルールが古くなっていないかの確認。 |
| `expired` | `expires` / `projects` / `when_exists` のいずれかで無効になっているルールファイル。 | 削除または更新。 |

`apply` が書き換えるのは、`bump` 対象ファイルの frontmatter 内の `count:` 行だけです。変更したファイルの一覧を表示し、それ以外は一切触りません。`enforce`（と `stale` / `expired`）は提案のみで、Claude はそれをユーザーに提示し、ファイルを書き換える前に確認します。

自動引き上げ（`autoCount`）が有効なら、違反したセッションごとに `count` が 1 ずつ上がります。`bump` 提案は窓内の違反回数を根拠に 3 や 5 へ一気に引き上げるもので、`apply` は提案時の `count` がファイルと一致するときだけ書き換えるため、自動引き上げと二重に上がることはありません（提案は常に現在の `count` から出ます）。

### `/hook-list`

このプロジェクトで feedback-gate が「いつ・何を」動かすかを、ブラウザの画面で一覧表示するコマンドです。ルールやゲートのファイルは何も書き換えません。

```
/hook-list [--no-open]
```

一覧を作るのは Go のバイナリ（`feedback-gate <claude|codex> hook-list`、`internal/hookgate/hook_list.go`）で、画面は `webui/hook-list.html`（バイナリに埋め込み）です。mod の `/hook-list`（`src/hook-list.ts`）は `scripts/hook-list.sh` でそれを呼ぶだけなので、mod のフックが動かない組織管理の環境や Codex でも、同じスクリプト（スキル `/feedback-gate:hook-list`、Codex では `bash <プラグイン>/scripts/hook-list.sh codex`）で同じ画面が出ます。HTML は `~/.claude/feedback-gate/hook-list/<プロジェクトのパス>-<ハッシュ>.html` に書き出し、既定のブラウザ（macOS は `open`、ほかは `xdg-open` か `wslview`、Windows は `start`）で開きます。開けない環境（リモートなど）や `--no-open` では、書き出したファイルのパスだけを返します。

画面に出るもの:

- **gate.yaml**: 見つかったファイルのパスと、`rules`（ファイル編集直後の PostToolUse。`match`・`run` のコマンド・`parallel`・`run_checks`・`dir` / `per_file_dir` / `timeout` / `policy`）、`consistency_checks`（Stop / SubagentStop。どの rule の `run_checks` にも無いものは「実行されない」と表示）、`session_start`（SessionStart。`on` / `background`）を、それぞれが動くタイミングの説明付きで。無い・YAML として読めない場合はその旨。
- **feedback ルール**: グローバルとプロジェクトをマージした有効なルールごとに、置き場所、`count` と段階（暫定・確定・deny）、注入のされ方（毎プロンプト / `files` に一致するファイルを読んだ・編集したとき / しない）、`enforce` の各要素（イベントと実効の severity、`path` / `changed` / `when` / `unless` / `check` のコマンドなど）、ファイルのパス。続けて無効なルール（`expires` 切れ・`projects` / `when_exists` 不一致）と読めないルールを理由付きで。
- **プラグイン設定**: `agentLaunchGuard`・`autoCount`・`language` の現在値。

feedback ルールは 1 ルール 1 行の一覧表で、行を開くと上記の詳細が出ます。段階・置き場所・イベントのボタンと、名前・コマンド・glob の文字で絞り込めます（数十件のルールでも見渡せるように）。無効なルールは折りたたんで件数だけ、読めないルールは開いた状態で出します。ライト / ダークの両方に対応しています。

## スキル

`skills/` に 3 つのスキルと、effort を切り替えるだけの `effort-<level>`（[下記](#feedback-gateeffort-level)）を同梱しています。プラグインと一緒に Claude Code が読み込み、`/feedback-gate:<name>` で呼び出せます（説明文から Claude が自分で使うこともあります）。それぞれ手順を書いた `SKILL.md` と、必要なときに読む参照ファイルからなり、フックの動作はスキルに依存しません。

### `/feedback-gate:feedback`

フィードバックルールのファイル（`~/.claude/feedback/*.md`、`<project>/.claude/feedback/*.md`）を作成・更新・棚卸しします。

```
/feedback-gate:feedback [create|update|review] [トピックまたはルール名]
```

- `create`: フィードバック・指摘・好みを受けたとき。保存してよいか確認し、グローバルかプロジェクトか（または `projects` / `when_exists` / `expires` で絞ったグローバルルールか）を選び、具体的な指摘を抽象的なルールに変換して本文の第 1 段落（フックが注入する部分）に書き、ファイル名を snake_case で付け、`count` を決め（1 は暫定、3 は確定）、フックが検知できるものにだけ `enforce` を付け（イベントの選択、正規表現の検証）、書いたファイルを読み戻して frontmatter を確認します。
- `update`: 同じ指摘の再発（そのセッションでフックが上げていなければ `count` を 1 上げる）、誤検知したルール（削除せず `unless` / `exclude_path` で絞る）、`enforce` の無い確定ルール、文言の修正、適用範囲の変更。
- `review`: 定期的な棚卸し（`skills/feedback/review.md`）。`/correct` を実行し、`.violations.jsonl` からルールごとの違反回数を集計し、全ルールを 1 つの表にして「維持・昇格・修正・絞り込み・統合・範囲変更・廃止（期限切れ、不要になった、`gate.yaml` や linter で代替された）」の提案を付けます。削除と統合は確認してからにします。

書式のリファレンス（`skills/feedback/reference.md`）と、4 つの `enforce` イベントそれぞれの完成例（`skills/feedback/examples.md`）をスキルに同梱しています。スキルが編集するのはルールファイルだけで、フックの状態ファイルには触れません。

### `/feedback-gate:gate`

プロジェクトの `.claude/gate.yaml` を作成・更新します。

```
/feedback-gate:gate [init|update|review]
```

コマンドを推測せず、まずプロジェクトが実際に動かしているものを読みます。マニフェスト（言語とパッケージマネージャ）、タスクランナー（`Makefile`、`justfile`、`Taskfile.yml`、`mise` のタスク、`package.json` の scripts）、CI 設定（GitHub Actions、GitLab CI、CircleCI など）や pre-commit 系のフック、リポジトリの構成（単一パッケージ、ワークスペース、1 ディレクトリ 1 パッケージ）です。それをゲートに写します。ファイル単位の lint・フォーマット検査・型検査とパッケージのテストは `rules` に（ツールがファイルを受け取れるなら `$CLAUDE_GATE_FILES` を渡す）、プロジェクト全体のテストやビルドは `consistency_checks` に置いて `run_checks` から参照し、モノレポには `per_file_dir`、各コマンドに `name`、独立したものは `parallel`、計測した所要時間から `timeout`、全体を見るコマンドには `files: false` を付けます。CI だけで必要なもの（カバレッジのアップロード、デプロイ、サービスやシークレットが要るステップ）は外して報告に列挙します。引き渡す前に、各コマンドを現在のツリーで 1 回ずつ実行し（通常の権限確認を通ります）、スキーマのキー一覧と照合し、`.gitignore` に `.claude/.gate-status/` があることを確かめます。`review` は現在のファイルと CI のずれを編集せずに報告します。フィールドのリファレンス、調査のチェックリスト、ツールチェーン別のレシピ（TypeScript、ワークスペース、Python、Go、Rust、Ruby、JVM、Terraform、シェル、Makefile 駆動）は `skills/gate/` にあります。

### `/feedback-gate:hook-list`

[`/hook-list`](#hook-list) と同じ画面を、`scripts/hook-list.sh` を実行して出します（引数は `--no-open`）。mod の `/hook-list` が使えない組織管理の環境で使います。プロジェクトにどんな hook・gate のルール・feedback ルールが登録されているかを尋ねられたときに、Claude が自分で使うこともあります。

### `/feedback-gate:effort-<level>`

`effort-low`・`effort-medium`・`effort-high`・`effort-xhigh`・`effort-max` の 5 つ。本文はほぼ空で、frontmatter の `effort` によって、呼び出したターンの残りの effort をその値に切り替えます（Claude Code のスキルの機能。モデルが対応していない値は、それ以下で対応している最も高い値になります。環境変数 `CLAUDE_CODE_EFFORT_LEVEL` があればそちらが優先）。hook の出力ではセッションの effort を変えられないので、[stop_review](gate.md#stop_review) はブロックの理由の中でこのスキルを Claude に呼ばせます。`/feedback-gate:effort-max このテストが落ちる原因を調べて` のように自分で使うこともできます。
