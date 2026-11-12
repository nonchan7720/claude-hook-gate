# 設定

[← README](../../README_ja.md) · [English](../settings.md)

## エージェント起動ガード（任意）

`src/agent-launch-guard.ts` は、`userConfig` の `agentLaunchGuard` を `true` にしたときだけ有効になります（既定は `false`）。有効にすると、`Agent` と `SendMessage` の PreToolUse で `ask` を返し、送信しようとしている本文を確認理由にそのまま載せるので、サブエージェントに渡る前に内容を確認できます。

- `Agent`: `subagent_type` が `code-implementer` のとき、`prompt` を見せて確認する。
- `SendMessage`: 宛先が `git-operator` 以外のとき、`message` を見せて確認する。

どちらにも該当しなければ何も出力せず、通常のパーミッション判定に委ねます。対象のエージェント種別と許可する宛先の既定は `src/agent-launch-guard.ts` 冒頭の `ASK_AGENT_TYPES` / `ALLOW_RECIPIENTS`（`internal/hookgate/agent_launch_guard.go` の `AskAgentTypes` / `AllowRecipients`）です。mod の hook も command hook（`feedback-gate` バイナリ）も、環境変数 `FEEDBACK_GATE_ASK_AGENT_TYPES`（確認する `subagent_type`）と `FEEDBACK_GATE_ALLOW_RECIPIENTS`（確認なしで送ってよい宛先）で差し替えられます。どちらも `,` または `;` 区切りの一覧で、名前の前後の空白は無視し、未設定や空なら既定のままです（例: `FEEDBACK_GATE_ASK_AGENT_TYPES='code-implementer;worker'`）。

有効化するには、`/plugin` でインストールするときに表示される設定画面で `agentLaunchGuard` をオンにするか、後から `/config` メニューのこのプラグインの `agentLaunchGuard` の行で切り替えます。

## count の自動引き上げ

hook（PreToolUse の `pre_bash` / `pre_edit`、PostToolUse の `post_edit`、Stop / SubagentStop の `stop_check`）が feedback ルールの違反を検出すると、違反ログに記録するのと同じタイミングで、そのルールのファイルの `count` を 1 上げます。同じ違反を繰り返すほど強制力が warn → ask / block → deny と上がり、`count: 1` のまま放置されることがありません。Bash（heredoc・`python`・`sed -i` など）で書いたファイルを PostToolUse(Bash) で検査した結果（`post_edit` と、実行後に判定する `pre_edit`。上の「Bash で書いたファイル」）も、Edit / Write と同じく対象です。

- 書き換えるのは、そのとき実際に使われたルールのファイル（グローバルとプロジェクトに同名があればプロジェクト側）の frontmatter 内の `count: N` 行だけです（数値で書かれた行のみ。`count` 行が無い・数値でないルールは上げません）。同じディレクトリの一時ファイルに書いてから `mv` で置き換えます。
- 抑制の単位は「セッション × ルール名」です。同じセッションでは、同じルールを何度違反しても（enforce が複数一致しても、Stop のブロックが続いても）1 回しか上げません。次のセッションでまた違反すればまた上がります。上げ済みのルール名は `~/.claude/feedback/.count_state/<session_id>.json` に記録します。`session_id` が渡されない呼び出しでは上げません。
- 上限は `5`（`severity` の明示が無いときに deny になる値）で、それ以上は上げません。
- 今回の判定は上げる前の `count` で行い、上げた次の違反から新しい強制力が効きます。上げたときは deny / ask / block の理由（warn なら stderr）に「`count` を N → N+1 に上げた」旨の 1 行を添えるので、モデルにも伝わります。
- 書き込みに失敗しても hook は止めません。

無効にするには、`userConfig` の `autoCount` を `false` にします（既定は `true`。`/plugin` のインストール時の設定画面か、後から `/config` で変更）。

## メッセージの言語

hook が出すもの（コンテキストに注入するフィードバックルール、block / warn の理由、gate の結果、帯とステータス行、デスクトップ通知、`/correct` の報告、同梱のルールファイル）は日本語と英語を選べます。`userConfig` の `language`（`/plugin` のインストール時の設定画面か、後から `/config` で変更）で決めます。

- `auto`（既定）: OS の言語設定に従います。環境変数 `FEEDBACK_GATE_LANG`（このプラグイン専用の上書き。`ja` か `en`）、`LC_ALL`、`LC_MESSAGES`、`LANG` の順に最初に値のあるものを見て、`ja` で始まれば日本語（例: `ja_JP.UTF-8`）、それ以外（`en_US.UTF-8`、`C`、`POSIX` など）は英語です。どれも無ければ英語になります。
- `ja` / `en`: 環境によらず常にその言語。

文面は `locales/ja.yaml` と `locales/en.yaml` にあり（メッセージ 1 つにつき 1 キー。実行時に埋める値は `{{name}}`。両ファイルのキーは一致している必要があり、テストで検査します）、[i18next](https://www.i18next.com/) で引きます。言語の判定は `src/i18n.ts` です。文面を変えたいときは YAML を編集してください。このドキュメントの例は日本語の文面です（英語では `[gate] 実行中:` が `[gate] running:`、`[gate] 完了:` が `[gate] done:` などになります）。自分で置いた `rulesFile` と、フィードバックルールの `message` は、どの言語でも書いたとおりに出ます。
