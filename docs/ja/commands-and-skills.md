# コマンドとスキル

[← README](../../README_ja.md) · [English](../commands-and-skills.md)

## `/correct`

ルールと違反ログ（`~/.claude/feedback/.violations.jsonl`）を集計し、ルールの締め直しを提案します。

```
/correct [--window 30d] [--min 2] [apply]
```

| 引数 | 意味 |
| --- | --- |
| `--window` | 違反を数える期間。`Nd` か `Nh`（既定 `30d`） |
| `--min` | 提案を出す最小の違反回数（既定 `2`） |
| `apply` | `bump` の提案をルールファイルに書き込む。付けなければ何も変えない |

| 提案 | 出る条件 | 内容 |
| --- | --- | --- |
| `broken` | ルールファイルが読めない、`enforce` が不正 | 直し方（[壊れたルール](files.md#壊れたルール)） |
| `bump` | 期間内の違反が `--min` 回以上 | `count` 1〜2 → 3。3〜4 で確認・ブロックが続くなら → 5 |
| `enforce` | `count >= 3` なのに `enforce` が無い | `enforce` の追加（雛形つき） |
| `stale` | `enforce` はあるが一度も違反が記録されていない | 効いているか、古くなっていないかの確認 |
| `expired` | `expires` / `projects` / `when_exists` で無効になっている | 削除か更新 |

`apply` が書き換えるのは `bump` 対象の `count:` の行だけです。それ以外は提案にとどまります。

## `/hook-list`

このプロジェクトで「いつ・何が」動くかを、ブラウザの画面で一覧します。何も書き換えません。

```
/hook-list [--no-open]
```

- **gate.yaml**: `rules`、`consistency_checks`、`session_start` のコマンドと、動くタイミング。
- **ルール**: 有効なルールごとの `count`、注入のされ方、`enforce` の内容。無効なルールと読めないルールも理由つきで出ます。
- **設定**: `agentLaunchGuard`、`autoCount`、`language` の現在値。

ブラウザを開けない環境（リモートなど）や `--no-open` では、書き出した HTML のパスだけを返します。

## スキル

`/feedback-gate:<name>` で呼び出せます。説明文から Claude が自分で使うこともあります。

| スキル | 用途 |
| --- | --- |
| `/feedback-gate:feedback [create\|update\|review]` | ルールの作成・更新・棚卸し |
| `/feedback-gate:gate [init\|update\|review]` | `gate.yaml` の作成・更新・CI とのずれの報告 |
| `/feedback-gate:hook-list [--no-open]` | `/hook-list` と同じ画面。`/hook-list` が出ない環境（組織管理の環境、Cowork、Codex）で使う |
| `/feedback-gate:effort-<level>` | そのターンの残りの effort を切り替える |

### `/feedback-gate:feedback`

- `create`: 指摘を抽象的なルールに直し、置き場所（全プロジェクトかそのプロジェクトか）と `count` を決め、hook が検知できるものにだけ `enforce` を付けます。保存の前に確認します。
- `update`: 同じ指摘の再発（`count` を上げる）、誤検知（削除せず条件を絞る）、文言や適用範囲の修正。
- `review`: 全ルールを表にして、維持・昇格・修正・統合・廃止を提案します。削除と統合は確認してから行います。

### `/feedback-gate:gate`

コマンドを推測せず、プロジェクトが実際に使っているもの（マニフェスト、タスクランナー、CI 設定）を読んで `gate.yaml` に写します。CI でしか動かせないもの（デプロイ、シークレットが要るステップなど）は外して報告します。引き渡す前に各コマンドを 1 回ずつ実行します。

### `/feedback-gate:effort-<level>`

`effort-low`・`effort-medium`・`effort-high`・`effort-xhigh`・`effort-max` の 5 つです。呼び出したターンの残りの effort を切り替えるだけで、セッションの設定は変えません。[`stop_review`](gate.md#stop_review) が Claude に呼ばせます。自分で使うこともできます。

```
/feedback-gate:effort-max このテストが落ちる原因を調べて
```

モデルが対応していない値は、それ以下で対応している最も高い値になります。環境変数 `CLAUDE_CODE_EFFORT_LEVEL` があればそちらが優先されます。
