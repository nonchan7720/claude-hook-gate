# feedback-gate for Codex

[English](README.md)

[feedback-gate](../../README_ja.md) を [Codex](https://developers.openai.com/codex) で使うためのプラグインです。Claude Code 版と同じルールファイルと同じ `gate.yaml` を読むので、両方のツールで触るプロジェクトは同じ検査を受けます。

- フィードバックルールを毎回のプロンプトに注入し、ツール呼び出し時と停止時に強制する。
- `gate.yaml` の品質ゲートを、ファイル編集後と停止時に走らせる。
- 承認待ちと停止をデスクトップ通知する（macOS）。

設定ディレクトリは `.agents/` を先に、次に `.claude/` を見ます（Claude Code は逆順）。

## インストール

```
gh api repos/nonchan7720/claude-hook-gate/contents/plugins/codex/scripts/setup.sh -H "Accept: application/vnd.github.raw" | bash
```

この 1 行が、プラグインの追加・更新とフックの導入を行い、以後のためのコマンド `feedback-gate-setup` を `~/.local/bin` に入れます。そのあと Codex を起動し、`/hooks` を開いてフックを信頼してください。

Codex はまだプラグイン同梱のフックを走らせません（[openai/codex#16430](https://github.com/openai/codex/issues/16430)）。そのためプラグインを入れるだけでは動かず、フックを `~/.codex/hooks.json` に写す必要があります。上のコマンドがそれを行います。

| やりたいこと | コマンド |
| --- | --- |
| プラグインとフックを更新する | `feedback-gate-setup`（更新後は `/hooks` で信頼し直す） |
| プロジェクトの `.codex/hooks.json` に入れる | `feedback-gate-setup --project` |
| プラグインは更新せず、フックだけ入れ直す | `feedback-gate-setup --no-update` |
| フックを外す | `feedback-gate-setup --remove` |
| 管理層（`/etc/codex/hooks.json`）に入れる | `feedback-gate-setup --system`（[管理層のフック](#管理層のフックだけが許可されている環境)） |

<details>
<summary>手で入れる場合</summary>

```
codex plugin marketplace add nonchan7720/claude-hook-gate
# /plugins から feedback-gate をインストールしてから
bash ~/.codex/plugins/cache/hook-gate/feedback-gate/<version>/plugins/codex/scripts/install-hooks.sh
```

`install-hooks.sh` のオプション（1 回につき 1 つ）:

| オプション | 動き |
| --- | --- |
| （なし） | `~/.codex/hooks.json` に足す |
| `--project [dir]` | `<dir>/.codex/hooks.json` に足す |
| `--to FILE` | 任意の `hooks.json` に足す |
| `--print` | 書かずに内容を表示する。`--to FILE` を添えると FILE にマージした結果を表示する |
| `--toml` | `requirements.toml` の `[hooks]` の形で表示する |
| `--remove` | プラグインのフックを外す |

ファイルにある他のフックは残し、このプラグインの分だけを置き換えます。プラグインを更新したりチェックアウトを移したりしたら、もう一度実行してください。

</details>

## フックが動かないとき

`/hooks` はフックの出どころと状態（信頼済み・無効・ポリシーで飛ばした）を、`codex features list` は機能フラグを表示します。

| 症状 | 対処 |
| --- | --- |
| `/hooks` にレビュー待ちと出る | 信頼する。フックを入れ直したあとは再度の信頼が要ります |
| `codex features list` で `hooks` が false | `config.toml` の `[features] hooks = false` を消す |
| `~/.codex/hooks.json` にこのプラグインのエントリが無い、または無くなったパスを指している | `feedback-gate-setup` を再実行する |
| 標準エラーに `could not install the feedback-gate ... binary (<reason>)` と出る | [前提](#前提)を満たす |
| `/hooks` でユーザーのフックがポリシーで飛ばされている | 下の「管理層のフックだけが許可されている環境」 |

### 管理層のフックだけが許可されている環境

組織の `requirements.toml`（MDM や ChatGPT ワークスペースからの配布も同じ）に `allow_managed_hooks_only = true` があると、Codex は管理層のフックだけを走らせます。`~/.codex/` やプロジェクトに書いたフックも、プラグイン同梱のフックも動きません。

- **マシンの管理者権限があるとき。** `feedback-gate-setup` を再実行します。`/etc/codex/requirements.toml` のポリシーを見つけると、`sudo` で `/etc/codex/hooks.json` に入れます。ポリシーが MDM やワークスペースから来ているときは `--system` を付けます。
- **管理者権限が無いとき。** 管理者に次のどちらかを渡します。
  - `install-hooks.sh --print` の出力（`/etc/codex/hooks.json` として置いてもらう）
  - `install-hooks.sh --toml` の出力（`requirements.toml` に貼ってもらう）

どちらの場合も、フックが指すこのリポジトリのチェックアウトを、Codex を使う全ユーザーが読める場所に置いておく必要があります。GitHub に出られないマシンでは、`FEEDBACK_GATE_BIN` でバイナリの場所を指定します。

## Codex のサンドボックスとルールの置き場所

Codex の `workspace-write` モードは、プロジェクトの `.agents/` と `.codex/` を読み取り専用にします。フック自身はサンドボックスの外で動くので影響を受けません。

| 置き場所 | Codex が編集できるか | 向いているもの |
| --- | --- | --- |
| `<project>/.claude/feedback/`、`<project>/.claude/gate.yaml` | できる | Codex 自身に育てさせるルール |
| `<project>/.agents/feedback/`、`<project>/.agents/gate.yaml` | 承認が要る | 自分だけが変えるべきルール |
| `~/.agents/feedback/`、`~/.claude/feedback/` | 承認が要る | 全プロジェクト共通のルール |

同じ名前のルールが両方にあれば、`.agents/` 側が使われます。

## 前提

| ツール | 必要な場面 |
| --- | --- |
| `bash`、`curl` か `wget`、`tar`、`sha256sum` か `shasum` | Go 製バイナリ `feedback-gate` を、バージョンごとに 1 回ダウンロードするとき |
| `terminal-notifier` | macOS のデスクトップ通知（任意） |
| `dogwood` | ゲートのポリシー判定（任意。[前提](../../docs/ja/install.md#前提)） |

対応は Linux と macOS の amd64 / arm64 です。バイナリの入手先と、取得できないときの挙動は [組織管理の環境](../../docs/ja/managed-environments.md) と同じです。

## Claude Code との違い

イベントごとの動きは [フック](../../docs/ja/hooks.md) の表と同じです。違いは次のとおりです。

| 項目 | Codex では |
| --- | --- |
| ファイルの編集 | `apply_patch` の 1 つのパッチをファイルごとに分けて検査する。ゲートはパッチ全体で 1 回走る。`*** Delete File` は検査しない |
| `ask`（確認） | Codex に `ask` が無いので拒否になる。同じ対象への同じルールは次から警告に落ちるので、直してやり直せる |
| 警告 | Codex は標準エラーを表示しないので、モデルへのコンテキストとして渡す |
| `files` 付きのルール | `Read` ツールが無いので、編集したときにだけ届く |
| 確認待ちの通知 | `Notification` の代わりに `PermissionRequest` で出す。承認の判断には関与しない |
| エージェント起動ガード | `spawn_agent` / `send_input` に対して働く |
| 停止時のブロック理由 | 会話に表示されるので、失敗したコマンドの出力は末尾 60 行とログのパスだけにする |
| `stop_review` | 見直しは行われるが、effort は切り替わらない |
| Esc やタイムアウト | フックが止められると、実行中のゲートのコマンドも一緒に止める |

## 設定

設定画面が無いので、`codex` を起動する環境の環境変数で渡します。

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `FEEDBACK_GATE_LANG` | OS の言語 | `ja` / `en` |
| `FEEDBACK_GATE_AUTO_COUNT` | 有効 | `false` で `count` の自動引き上げを止める |
| `FEEDBACK_GATE_AGENT_LAUNCH_GUARD` | 無効 | `true` でエージェント起動ガードを有効にする |
| `FEEDBACK_GATE_ASK_AGENT_TYPES` | `code-implementer` | 起動ガードが確認するエージェント種別（`,` か `;` 区切り） |
| `FEEDBACK_GATE_ALLOW_RECIPIENTS` | `git-operator` | 確認なしで送ってよい宛先 |
| `FEEDBACK_GATE_RULES_FILE` | `~/{.agents,.claude}/feedback-gate/feedback_rules.md` | 毎回注入する共通ルールファイル |

`CLAUDE_FEEDBACK_DIR` と `DOGWOOD_BIN` は Claude Code と同じように効きます。

## 構成

```
.codex-plugin/plugin.json       # Codex のマニフェスト（リポジトリのルート）
plugin.json                     # Agent Plugins のマニフェスト（リポジトリのルート）
.agents/plugins/marketplace.json
plugins/codex/
├── hooks/hooks.json            # 全イベントの command hook
├── scripts/hook.sh             # 入口: feedback-gate を探すかダウンロードして実行する
├── scripts/setup.sh            # ワンライナーの入口（feedback-gate-setup）
└── scripts/install-hooks.sh    # hooks.json を Codex が読む場所に写す
```

プラグインのルートはリポジトリそのもので、`rules/` などは Claude Code 版と共有します。検査の実装は `internal/hookgate`、ホストごとの違いは `host_codex.go` にあります（[開発](../../docs/ja/development.md)）。
