# feedback-gate for Codex

[English](README.md)

[feedback-gate](../../README_ja.md) のフックを [Codex](https://developers.openai.com/codex) のプラグインにしたものです。Claude Code 版と同じ 3 つのことを、同じルールファイルと同じ `.claude/gate.yaml` で行うので、両方のツールで触るプロジェクトは同じ検査を受けます。

- フィードバックルール（`~/.claude/feedback/*.md`、`<project>/.claude/feedback/*.md`）を毎回のプロンプトに注入し、ツール呼び出し時と Codex の停止時に強制する。
- `.claude/gate.yaml` のプロジェクト別の品質ゲートを、ファイル編集後と Codex の停止時に走らせる。
- Codex が承認待ちになったときと停止したときにデスクトップ通知を出す（macOS、`terminal-notifier`）。

検査のロジック（`src/hooks.ts` とそこから呼ぶモジュール）は Claude Code 版と共有し、Codex のために変えていません。ホストごとの違いは `src/host.ts` の `Host` インターフェースに閉じ込めてあり、Claude Code の settings hook 向けが `src/host-claude.ts`、Codex 向けが `src/host-codex.ts` です。[構成](#構成)を参照。

## インストール

```
codex plugin marketplace add nonchan7720/claude-hook-gate
```

これでこのリポジトリが `claude-hook-gate` マーケットプレイスとして登録されます（カタログは `.agents/plugins/marketplace.json` で、このディレクトリを指しています）。続けて Codex のプラグイン一覧（`/plugins`）から `feedback-gate` をインストールし、起動時に「Hooks need review」と出たらプラグインのフックを信頼してください（`/hooks`）。信頼するまでプラグインのフックは動きません。

Codex はインストールしたプラグインの `hooks/hooks.json` を読みます。お使いの Codex がプラグイン同梱のフックをまだ走らせない場合（[openai/codex#16430](https://github.com/openai/codex/issues/16430)）は、代わりに `~/.codex/hooks.json`（またはプロジェクトの `.codex/hooks.json`）からインストール先を直接指してください。フックのコマンドはプラグインのルートを `CLAUDE_PLUGIN_ROOT`（`PLUGIN_ROOT` も可）から取り、どちらも無ければ `scripts/hook.sh` が自分の場所から求めるので、`hooks/hooks.json` の変数をプラグインのパス（`~/.codex/plugins/cache/claude-hook-gate/feedback-gate/<version>` や、このリポジトリのチェックアウト）に置き換えればそのまま使えます。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|apply_patch|spawn_agent|send_input",
        "hooks": [{ "type": "command", "command": "bash /path/to/claude-hook-gate/plugins/codex/scripts/hook.sh PreToolUse" }]
      }
    ]
  }
}
```

（`hooks/hooks.json` の全イベントを同じように写します。）

## 前提

- `PATH` 上の `node`（または `bun`）: フックはこれで `hooks/cli.js` を動かします。どちらも無ければ何もしません（exit 0）。
- `bash`。
- `terminal-notifier`（任意、macOS）: デスクトップ通知。
- `dogwood`（任意）: gate のポリシーエンジン。[メインの README](../../README_ja.md#前提) を参照。

## フック

すべてのイベントが `hooks/hooks.json` の command hook `bash "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" <Event>` で、`hooks/cli.js <Event>`（`src/codex-cli.ts` から作る）を走らせます。Codex は Claude Code の command hook と同じイベント名・同じ stdin の JSON を送り、同じ出力（`permissionDecision`、`decision: block`、`additionalContext`、終了コード 2）を読むので、[メインの README の表](../../README_ja.md#フック) がそのまま当てはまります。違いは次のとおりです。

| Codex のイベント | 走るもの | Claude Code との違い |
| --- | --- | --- |
| SessionStart | `reset-gate` | なし。 |
| UserPromptSubmit | rules ファイル + `feedback-inject` | なし。 |
| PreToolUse（`Bash`） | `bash-changes`（`bashStarted`）、`feedback-guard`（`pre_bash`） | なし。 |
| PreToolUse（`apply_patch`） | ファイルごとの `feedback-guard`（`pre_edit`） | Codex はファイル編集を 1 つのパッチ（`tool_input.command`、`*** Begin Patch` 形式）で行います。パッチをファイルごとに分け（`src/apply-patch.ts`）、`*** Add File` は `Write`（全文）、`*** Update File` は `Edit`（追加行）として検査します。`*** Move to` は移動先のパスで検査し、`*** Delete File` は検査しません。結果は 1 つにまとめ、deny が 1 つでもあれば deny、無ければ ask です。 |
| PreToolUse（`spawn_agent` / `send_input`）、任意 | `agent-launch-guard` | `FEEDBACK_GATE_AGENT_LAUNCH_GUARD=true` のときだけ。`spawn_agent` は `Agent`（`agent_type` → `subagent_type`、`message` → `prompt`）、`send_input` は `SendMessage`（`agent_id` → `to`）として扱います。 |
| PostToolUse（`Bash`） | `bash-changes`、`feedback-bash-edit`、gate の `rules` | なし。 |
| PostToolUse（`apply_patch`） | ファイルごとの `record-changes` + `feedback-post-edit`、その後 gate の `rules` を 1 回 | 上と同じ分け方。gate はパッチ全体で 1 回だけ走ります。 |
| PostToolUse（`spawn_agent`） | `subagent-report` | エージェント ID は `tool_response.agentId` か `agent_id` から読みます（結果が JSON 文字列でも可）。 |
| PermissionRequest | `notification`（`notify`） | Codex には `Notification` イベントが無いので、ツール呼び出しが承認待ちになったときに「確認待ち」の通知を出します。フックは何も返さないので、承認の判断は通常のダイアログに残ります。 |
| Stop | `all-stop`（gate の `checks`、`stop_check`、`stop` 通知） | なし。 |
| SubagentStop | gate の `checks`、`stop_check`、`saveSubagentReport` | なし。 |

出力にもう 2 つ違いがあります。

- **`ask` は `deny` になる。** Codex の PreToolUse には `ask` が無く、返すとフックが失敗扱いになってツールがそのまま動きます。`severity: ask`（または `severity` 無しの `count` 3〜4）のルールは呼び出しを拒否し、理由にその旨を添えます。Claude Code と同じく、同じセッション・同じ対象への同じルールは次の呼び出しから `warn` に落ちるので、Codex は呼び出しを直してやり直せます。
- **warn がモデルに届く。** Claude Code はフックが stderr に出した warn を表示しますが、Codex は表示しません。PreToolUse（拒否しないとき）と PostToolUse では `additionalContext` として、Stop / SubagentStop では `systemMessage` として渡します。stderr にも従来どおり出します。

## 設定

Codex のプラグインには設定画面が無いので、Claude Code 版のオプションは `codex` を起動するプロセスの環境変数で渡します（Claude Code の名前 `CLAUDE_PLUGIN_OPTION_<key>` も読みます）。

| 変数 | Claude Code のオプション | 値 |
| --- | --- | --- |
| `FEEDBACK_GATE_LANG` | `language` | `ja` / `en`。未設定なら `LC_ALL` / `LC_MESSAGES` / `LANG` に従う。 |
| `FEEDBACK_GATE_AGENT_LAUNCH_GUARD` | `agentLaunchGuard` | `true` で有効（既定は無効）。 |
| `FEEDBACK_GATE_AUTO_COUNT` | `autoCount` | `false` で無効（既定は有効）。 |
| `FEEDBACK_GATE_RULES_FILE` | `rulesFile` | 毎回のプロンプトに注入する rules ファイルのパス（既定 `~/.claude/feedback-gate/feedback_rules.md`。無ければ同梱の `rules/feedback_rules.md`）。 |

`CLAUDE_FEEDBACK_DIR` と `DOGWOOD_BIN` は Claude Code と同じように効きます。状態ファイルは `.claude/.gate-status/` と `~/.claude/feedback/` のままなので、両方のツールで使うプロジェクトはルール・ゲート・count を 1 つで共有します。セッションの鍵には Codex のセッション ID を使います。

## 構成

Claude Code 版と同じ形（`hooks/hooks.json` → `scripts/hook.sh` → `hooks/cli.js`）から、Codex に相当するものが無い mod（`register.js`）を除いたものです。

```
plugins/codex/
├── .codex-plugin/plugin.json   # Codex のマニフェスト（互換レイアウト）
├── plugin.json                 # ポータブルな Agent Plugins のマニフェスト
├── hooks/
│   ├── hooks.json              # 全イベントの command hook
│   ├── cli.js                  # src/codex-cli.ts から作る（CI がコミット）
│   └── vendor/                 # yaml / i18next（ビルド生成物）
├── scripts/
│   ├── hook.sh                 # 入口: node か bun で hooks/cli.js を動かす
│   ├── dogwood/                # ビルド時に scripts/dogwood/ からコピー
│   └── gate.schema.json        # ビルド時に scripts/ からコピー
└── rules/                      # ビルド時に rules/ からコピー
```

`hooks/cli.js`、`hooks/vendor/`、`rules/`、`scripts/dogwood/`、`scripts/gate.schema.json` は `bun run build` が生成し、「Build bundle」ワークフローがコミットします。直すときはリポジトリのルートにある元のファイルを直してください。

ソースはリポジトリの `src/` にあります。

- `src/host.ts`: `Host` インターフェース（`normalize`: ホストのイベントと stdin の JSON → 中核のイベントと payload、`render`: 中核の `Outcome` と warn → ホストの stdout の JSON、`options`: 環境変数からのプラグイン設定）、`runCore`（`src/hooks.ts` を呼ぶ）、`cliMain`（stdin を読み、stdout / stderr / 終了コードを返す）。
- `src/host-codex.ts`: Codex のホスト（このプラグイン）。`src/host-claude.ts`: Claude Code のホスト（settings hook、ルートの `hooks/cli.js`）。
- `src/apply-patch.ts`: `apply_patch` のパーサ。
- `src/codex-cli.ts`: `cliMain(codexHost)`。

別のホストを足すときは `Host` を実装して `cliMain(host)` の入口をバンドルするだけで、検査そのものには触りません。
