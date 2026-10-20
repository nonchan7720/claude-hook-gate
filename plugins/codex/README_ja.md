# feedback-gate for Codex

[English](README.md)

[feedback-gate](../../README_ja.md) のフックを [Codex](https://developers.openai.com/codex) のプラグインにしたものです。Claude Code 版と同じ 3 つのことを、同じルールファイルと同じ `gate.yaml` で行うので、両方のツールで触るプロジェクトは同じ検査を受けます。

- フィードバックルール（`~/{.claude,.agents}/feedback/*.md`、`<project>/{.claude,.agents}/feedback/*.md`）を毎回のプロンプトに注入し、ツール呼び出し時と Codex の停止時に強制する。
- `{.claude,.agents}/gate.yaml` のプロジェクト別の品質ゲートを、ファイル編集後と Codex の停止時に走らせる。
- Codex が承認待ちになったときと停止したときにデスクトップ通知を出す（macOS、`terminal-notifier`）。

Codex は `.agents/` を先に、次に `.claude/` を見ます（Claude Code は逆順）。状態ファイルは両者のうち先に存在する方の `.gate-status/` に置きます。一方を他方へのシンボリックリンクにしても構いません。[読み込むもの](../../README_ja.md#読み込むもの)を参照。

## インストール

```
codex plugin marketplace add nonchan7720/claude-hook-gate
```

これでこのリポジトリが `hook-gate` マーケットプレイス（`.agents/plugins/marketplace.json`）として登録されます。`/plugins` から `feedback-gate` をインストールし、起動時に「Hooks need review」と出たらフックを信頼してください（`/hooks`）。信頼するまでプラグインのフックは動きません。

プラグインのルートはリポジトリそのものです。ルートの Codex 用マニフェスト（`.codex-plugin/plugin.json`、`plugin.json`）が `plugins/codex/hooks/hooks.json` を指し、`rules/`、`scripts/dogwood/`、`hooks/vendor/` は Claude Code 版とコピーせず共有します。

お使いの Codex がプラグイン同梱のフックを走らせない場合（[openai/codex#16430](https://github.com/openai/codex/issues/16430)）は、`hooks/hooks.json` の各イベントを `~/.codex/hooks.json`（またはプロジェクトの `.codex/hooks.json`）に写し、`${PLUGIN_ROOT}` をチェックアウトかインストール先（`~/.codex/plugins/cache/hook-gate/feedback-gate/<version>`）のパスに置き換えてください。`PLUGIN_ROOT` が無いときは `scripts/hook.sh` が自分の場所からルートを求めます。

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

## 前提

- `PATH` 上の `node`（または `bun`）と `bash`: フックは `plugins/codex/hooks/cli.js` を動かします。ランタイムが無ければ何もしません（exit 0）。
- `terminal-notifier`（任意、macOS）: デスクトップ通知。
- `dogwood`（任意）: gate のポリシーエンジン。[メインの README](../../README_ja.md#前提) を参照。

## フック

すべてのイベントが `hooks/hooks.json` の command hook `bash "${PLUGIN_ROOT}/plugins/codex/scripts/hook.sh" <Event>` で、`hooks/cli.js <Event>`（`src/codex-cli.ts` から作る）を走らせます。Codex は Claude Code の command hook と同じイベント名・同じ stdin の JSON を送り、同じ出力（`permissionDecision`、`decision: block`、`additionalContext`、終了コード 2）を読むので、[メインの README の表](../../README_ja.md#フック) がそのまま当てはまります。違いは次のとおりです。

| Codex のイベント | 走るもの | Claude Code との違い |
| --- | --- | --- |
| SessionStart | `reset-gate` | なし。 |
| UserPromptSubmit | rules ファイル + `feedback-inject` | なし。 |
| PreToolUse（`Bash`） | `bash-changes`（`bashStarted`）、`feedback-guard`（`pre_bash`） | なし。 |
| PreToolUse（`apply_patch`） | ファイルごとの `feedback-guard`（`pre_edit`） | Codex はファイル編集を 1 つのパッチ（`tool_input.command`、`*** Begin Patch` 形式）で行います。パッチをファイルごとに分け（`src/apply-patch.ts`）、`*** Add File` は `Write`（全文）、`*** Update File` は `Edit`（追加行）として検査します。`*** Move to` は移動先のパスで検査し、`*** Delete File` は検査しません。deny が 1 つでもあれば deny、無ければ ask です。 |
| PreToolUse（`spawn_agent` / `send_input`）、任意 | `agent-launch-guard` | `FEEDBACK_GATE_AGENT_LAUNCH_GUARD=true` のときだけ。`spawn_agent` は `Agent`（`agent_type` → `subagent_type`、`message` → `prompt`）、`send_input` は `SendMessage`（`agent_id` → `to`）として扱います。 |
| PostToolUse（`Bash`） | `bash-changes`、`feedback-bash-edit`、gate の `rules` | なし。 |
| PostToolUse（`apply_patch`） | ファイルごとの `record-changes` + `feedback-post-edit`、その後 gate の `rules` を 1 回 | 上と同じ分け方。gate はパッチ全体で 1 回だけ走ります。 |
| PostToolUse（`spawn_agent`） | `subagent-report` | エージェント ID は `tool_response.agentId` か `agent_id` から読みます（JSON 文字列でも可）。 |
| PermissionRequest | `notification`（`notify`） | Codex には `Notification` イベントが無いので、ツール呼び出しが承認待ちになったときに「確認待ち」の通知を出します。フックは何も返さないので、承認の判断は通常のダイアログに残ります。 |
| Stop | `all-stop`（gate の `checks`、`stop_check`、`stop` 通知） | なし。 |
| SubagentStop | gate の `checks`、`stop_check`、`saveSubagentReport` | なし。 |

出力の違いは 2 つです。

- **`ask` は `deny` になる。** Codex の PreToolUse には `ask` が無く、返すとフックが失敗扱いになってツールがそのまま動きます。`severity: ask`（または `severity` 無しの `count` 3〜4）のルールは呼び出しを拒否し、理由にその旨を添えます。Claude Code と同じく、同じセッション・同じ対象への同じルールは次の呼び出しから `warn` に落ちるので、Codex は呼び出しを直してやり直せます。
- **warn がモデルに届く。** Claude Code はフックが stderr に出した warn を表示しますが、Codex は表示しません。PreToolUse（拒否しないとき）と PostToolUse では `additionalContext` として、Stop / SubagentStop では `systemMessage` として渡します。stderr にも従来どおり出します。

## 設定

Codex のプラグインには設定画面が無いので、Claude Code 版のオプションは `codex` を起動するプロセスの環境変数で渡します（`CLAUDE_PLUGIN_OPTION_<key>` も読みます）。

| 変数 | Claude Code のオプション | 値 |
| --- | --- | --- |
| `FEEDBACK_GATE_LANG` | `language` | `ja` / `en`。未設定なら `LC_ALL` / `LC_MESSAGES` / `LANG` に従う。 |
| `FEEDBACK_GATE_AGENT_LAUNCH_GUARD` | `agentLaunchGuard` | `true` で有効（既定は無効）。 |
| `FEEDBACK_GATE_AUTO_COUNT` | `autoCount` | `false` で無効（既定は有効）。 |
| `FEEDBACK_GATE_RULES_FILE` | `rulesFile` | 毎回のプロンプトに注入する rules ファイルのパス（既定 `~/{.agents,.claude}/feedback-gate/feedback_rules.md`。無ければ同梱の `rules/feedback_rules.md`）。 |

`CLAUDE_FEEDBACK_DIR` と `DOGWOOD_BIN` は Claude Code と同じように効きます。状態ファイルのセッションの鍵には Codex のセッション ID を使います。

## 構成

Claude Code の settings hook と同じ形（`hooks/hooks.json` → `scripts/hook.sh` → `hooks/cli.js`）から、Codex に相当するものが無い mod（`register.js`）を除いたものです。

```
.codex-plugin/plugin.json       # Codex のマニフェスト（リポジトリのルート）。hooks -> plugins/codex/hooks/hooks.json
plugin.json                     # ポータブルな Agent Plugins のマニフェスト（リポジトリのルート）。同じ hooks
.agents/plugins/marketplace.json
plugins/codex/
├── hooks/hooks.json            # 全イベントの command hook
├── hooks/cli.js                # src/codex-cli.ts から作る（CI がコミット）。../../../hooks/vendor/ を import する
├── scripts/hook.sh             # 入口: node か bun で hooks/cli.js を動かす
└── README.md, README_ja.md
```

ソース（`src/`）: `host.ts`（`Host` インターフェース: `options` / `normalize` / `render`、`runCore`、`cliMain`）、`host-codex.ts`（このプラグイン）、`host-claude.ts`（Claude Code の settings hook）、`apply-patch.ts`、`codex-cli.ts`。別のホストを足すときは `Host` を実装して `cliMain(host)` の入口をバンドルするだけで、検査そのものには触りません。
