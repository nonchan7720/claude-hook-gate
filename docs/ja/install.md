# インストール

[← README](../../README_ja.md) · [English](../install.md)

```
/plugin marketplace add nonchan7720/claude-hook-gate
/plugin install feedback-gate@claude-hook-gate
```

1 行目でこのリポジトリを `claude-hook-gate` マーケットプレイスとして追加し、2 行目でそこから `feedback-gate` プラグインをインストールします。その後スコープを選択します。

### Codex

同じフックを [Codex](https://developers.openai.com/codex) のプラグインとしても [`plugins/codex/`](../../plugins/codex/README_ja.md) に置いています（カタログは `.agents/plugins/marketplace.json`）。同じフィードバックルールと同じ `gate.yaml`（`.agents/` を先に、次に `.claude/` を見ます）を読むので、両方のツールで使うプロジェクトは同じ検査を受けます。

```
codex plugin marketplace add nonchan7720/claude-hook-gate
```

続けて `/plugins` から `feedback-gate` をインストールし、`install-hooks.sh` を 1 回実行して（後述）、`/hooks` でそのフックを信頼してください。プラグインのルートはこのリポジトリです（ルートの Codex 用マニフェスト `.codex-plugin/plugin.json` と `plugin.json` が `plugins/codex/hooks/hooks.json` を指します）。そのため `rules/`、`scripts/dogwood/`、`scripts/install-binary.sh`（バイナリのダウンローダ）はコピーせず共有します。検査のロジックは共有で、ホストごとの違い（Codex は `apply_patch` でファイルを編集する、`Notification` の代わりに `PermissionRequest` がある、`ask` が無い）は Go バイナリの `Host` インターフェース（`internal/hookgate/host.go` の `Host`。`feedback-gate claude` / `feedback-gate codex` に対応する実装が `host_claude.go` と `host_codex.go`、パッチの分割は `apply_patch.go`）の後ろに閉じ込めています。TypeScript の mod（`src/register.ts`）は Claude Code 専用で、変わりません。違いと、プラグイン設定の代わりになる環境変数は[プラグインの README](../../plugins/codex/README_ja.md) を参照。Codex はまだプラグイン同梱のフックを走らせない（`plugin_hooks` の機能が開発中）ので、インストール後に `plugins/codex/scripts/install-hooks.sh` を引数なしで 1 回実行してください（ワンライナー `gh api repos/nonchan7720/claude-hook-gate/contents/plugins/codex/scripts/setup.sh -H "Accept: application/vnd.github.raw" | bash` なら、インストール済みの最新バージョンを探してそのインストーラを実行し、プラグインの更新とフックの更新を一度に行う `feedback-gate-setup` コマンドも入れます。[インストール](../../plugins/codex/README_ja.md#インストール)を参照）。同じフックを `~/.codex/hooks.json` に書き、プラグイン自身のフックが動くようになればその写しはマーカーで黙ります。組織の `requirements.toml` が `allow_managed_hooks_only` を設定している環境（[組織管理の環境向けの settings hook](managed-environments.md#組織管理の環境向けの-settings-hook) で述べたガードの Codex 版）では管理層のフックだけが動くので、自分が管理するマシンならセットアップコマンドがポリシーを判定して `sudo` で `/etc/codex/hooks.json` に入れ（ポリシーが MDM やワークスペースから来るときは `--system`）、そうでなければ `--print` / `--toml` でその材料を出して管理者に渡します。また Codex のサンドボックスは Codex 自身がプロジェクトの `.agents/` と `.codex/` の下に書くのを止めるので、Codex に育てさせるルールは `.claude/` に置きます。[インストール](../../plugins/codex/README_ja.md#インストール)、[それでもフックが動かないとき](../../plugins/codex/README_ja.md#それでもフックが動かないとき)、[管理層に自分でフックを置く](../../plugins/codex/README_ja.md#管理層に自分でフックを置く)、[Codex のサンドボックスとルール・`gate.yaml` の編集](../../plugins/codex/README_ja.md#codex-のサンドボックスとルールgateyaml-の編集)を参照。

### Claude Cowork

Claude デスクトップアプリの Cowork でも、同じマーケットプレイスからインストールできます。Cowork の **Customize → Plugins → Add marketplace** で `nonchan7720/claude-hook-gate` を追加し、一覧から `feedback-gate` をインストールしてください（Cowork で入れたプラグインは Claude Code 2.1.273 以降にも同期されます）。

Cowork はプラグインの `hooks/hooks.json` の command hook を読み込みますが、mod（`hooks.json` の `modules` の `register.js`）を動かす場所としては文書化されていません。そのため Cowork で検査を行うのは、[組織管理の環境向けの settings hook](managed-environments.md#組織管理の環境向けの-settings-hook) と同じ `scripts/hook.sh` → `feedback-gate claude <Event>`（Go 製のバイナリ）の経路です。判定（deny / ask、block、追加する context）は mod と同じで、違いは次のとおりです。

- **コマンド**: `/correct` と `/hook-list` は mod が登録するコマンドなので出ません。一覧は[スキル](commands-and-skills.md#スキル)の `/feedback-gate:hook-list`、ルールの作成・棚卸しは `/feedback-gate:feedback` を使ってください。スキルは Cowork でもそのまま使えます。
- **プラグイン設定**: Cowork は `userConfig` の値を尋ねません。バイナリは `CLAUDE_PLUGIN_OPTION_*` が無ければ既定値（`language: auto`、`agentLaunchGuard: false`、`autoCount: true`、`rulesFile` は `~/{.claude,.agents}/feedback-gate/feedback_rules.md`、無ければ同梱のルールファイル）で動きます。言語は `FEEDBACK_GATE_LANG` か OS の言語で決まります。
- **バイナリの取得**: 初回（とバージョンが上がったとき）に `scripts/install-binary.sh` が GitHub のリリースから `feedback-gate_<os>_<arch>.tar.gz` と `checksums.txt` をダウンロードします。`bash`、`curl` か `wget`、`tar`、`sha256sum` か `shasum` と、`github.com` とリリースのファイルの転送先（`release-assets.githubusercontent.com`、以前は `objects.githubusercontent.com`）への HTTPS が必要です。どれかが欠けるとフックは何もせず、標準エラーに理由を 1 行出すだけです（作業は止めません）。組織が Cowork の通信先を絞っている場合は、これらのホストを許可してもらうか、`FEEDBACK_GATE_BIN` にバイナリの場所を指定してください。
- **Windows**: Cowork は Git for Windows が無いとフックを PowerShell で動かすので、`bash` を前提にする `scripts/hook.sh` は動きません。また `install-binary.sh` が扱うのは Linux と macOS（amd64 / arm64）だけなので、Windows では今のところフックは何もしません。
- **ルールと `gate.yaml` の書き込み**: Cowork は渡したフォルダの `.claude/` の下への書き込みを「保護された場所」として止めるので、Claude に `<project>/.claude/feedback/` へルールを作らせることができません。フックは `<project>/.agents/feedback/`（`.claude/feedback/` の次に読みます。同じ `name` なら `.claude/` 側が勝ちます）と `<project>/.agents/gate.yaml`（`.claude/gate.yaml` が無いとき）も読むので、Cowork ではこちらに置きます。毎回注入するルールファイル（`rules/feedback_rules.md`）と、スキル `/feedback-gate:feedback`・`/feedback-gate:gate` は、`.claude/` への書き込みが拒否されたらこの場所を使うよう指示しています。グローバルの `~/.claude/feedback/` は Cowork が作業するフォルダの外なので、そこに置くルールは自分でコピーしてください。
- **読むファイル**: フィードバックルール（`~/{.claude,.agents}/feedback/*.md`）と `{.claude,.agents}/gate.yaml` は、フックが動くマシンのホームディレクトリと、Cowork に渡したフォルダから読みます。Cowork は Claude Code CLI の `~/.claude` の設定やプラグインは読みませんが、フックのプロセスが自分でファイルを読むのには影響しません。

Cowork が `hooks.json` のどのイベント（SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Notification、Stop、SubagentStop）を発火させるかは、公式の文書に一覧がありません。インストールしたら、`count: 3` の確定ルールを 1 つ置いてプロンプトに注入されるか（UserPromptSubmit）、`gate.yaml` のあるフォルダでファイルを編集してゲートが走るか（PostToolUse / Stop）を確かめてください。動かないイベントがあれば issue で教えてください。

## 前提

mod のフックにはインストールするものはありません。フックは素の TypeScript で、1 つの JavaScript にバンドルして Claude Code が直接実行します（Python・bash・jq は不要）。

- `curl` または `wget` と `bash`（任意）: settings hook（`hooks/hooks.json`）だけが、プラグインのバージョンごとに 1 回、`feedback-gate` バイナリをダウンロードするために必要とします（`tar` と `sha256sum` / `shasum` も必要です。ハッシュのコマンドが無ければ何も入れません）。無く、かつバイナリがキャッシュに無ければ、settings hook は何もしません。`jq` は必須ではありません（あれば使います）。

- `terminal-notifier`（任意、macOS）: デスクトップ通知にだけ必要です。
- `dogwood`（任意。AWS のツールで、ソースは <https://github.com/dogwood-policy/dogwood>）。`cargo install --git https://github.com/dogwood-policy/dogwood amzn-dogwood-cli` でビルド・インストールできます（crate 名は `amzn-dogwood-cli`、バイナリ名は `dogwood`）。`{.claude,.agents}/gate.yaml` の各コマンドを今実行するか後回しにするかの判定に使います。`DOGWOOD_BIN`、`PATH`、`~/.cargo/bin/dogwood`、`~/.local/share/mise/shims/dogwood` の順に探します。見つからない場合、同梱の既定ポリシーが適用されるコマンドは毎回実行され、`policy:` を指定したコマンドは実行されずに後回しになります。
