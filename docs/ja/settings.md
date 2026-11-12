# 設定

[← README](../../README_ja.md) · [English](../settings.md)

`/plugin` のインストール時の画面か、後から `/config` で変えられます。

| 設定 | 既定 | 内容 |
| --- | --- | --- |
| `language` | `auto` | メッセージの言語 |
| `autoCount` | `true` | 違反を検出したらルールの `count` を 1 上げる |
| `agentLaunchGuard` | `false` | サブエージェントへ指示を送る前に確認する |
| `rulesFile` | `~/.claude/feedback-gate/feedback_rules.md` | 毎回注入する共通ルールファイル（[読み込むもの](files.md#共通ルールファイル)） |

## エージェント起動ガード

`agentLaunchGuard` を `true` にすると、次の呼び出しの前に、送る本文をそのまま見せて確認します。

| ツール | 確認する条件 |
| --- | --- |
| `Agent` | `subagent_type` が `code-implementer` のとき |
| `SendMessage` | 宛先が `git-operator` 以外のとき |

対象は環境変数で変えられます（`,` か `;` 区切り）。

- `FEEDBACK_GATE_ASK_AGENT_TYPES`: 確認する `subagent_type`
- `FEEDBACK_GATE_ALLOW_RECIPIENTS`: 確認なしで送ってよい宛先

## count の自動引き上げ

hook がルール違反を検出すると、そのルールファイルの `count` を 1 上げます。繰り返すほど 警告 → 確認 / ブロック → 拒否 と強くなります。

- 上げるのは「セッション × ルール」ごとに 1 回、上限は 5 です。
- 書き換えるのは frontmatter の `count: N` の行だけです。`count` が無い・数値でないルールは上げません。
- その回の判定は上げる前の `count` で行い、次の違反から新しい強制力が効きます。
- 上げたことは、理由の文面に 1 行添えて Claude にも伝えます。

止めるには `autoCount` を `false` にします。

## メッセージの言語

hook が出す文面（ルール、ブロックの理由、ゲートの結果、通知など）は日本語か英語です。

- `auto`: `FEEDBACK_GATE_LANG`、`LC_ALL`、`LC_MESSAGES`、`LANG` の順に最初に値があるものを見て、`ja` で始まれば日本語、それ以外は英語。
- `ja` / `en`: 常にその言語。

文面は `locales/ja.yaml` と `locales/en.yaml` にあります。自分で置いた共通ルールファイルと、ルールの `message` は書いたとおりに出ます。
