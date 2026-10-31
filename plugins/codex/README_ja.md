# feedback-gate for Codex

[English](README.md)

[feedback-gate](../../README_ja.md) のフックを [Codex](https://developers.openai.com/codex) のプラグインにしたものです。Claude Code 版と同じ 3 つのことを、同じルールファイルと同じ `gate.yaml` で行うので、両方のツールで触るプロジェクトは同じ検査を受けます。

- フィードバックルール（`~/{.claude,.agents}/feedback/*.md`、`<project>/{.claude,.agents}/feedback/*.md`）を毎回のプロンプトに注入し、ツール呼び出し時と Codex の停止時に強制する。
- `{.claude,.agents}/gate.yaml` のプロジェクト別の品質ゲートを、ファイル編集後と Codex の停止時に走らせる。
- Codex が承認待ちになったときと停止したときにデスクトップ通知を出す（macOS、`terminal-notifier`）。

Codex は `.agents/` を先に、次に `.claude/` を見ます（Claude Code は逆順）。状態ファイルは両者のうち先に存在する方の `.gate-status/` に置きます。一方を他方へのシンボリックリンクにしても構いません。[読み込むもの](../../README_ja.md#読み込むもの)を参照。

## インストール

1. このリポジトリを `hook-gate` マーケットプレイス（`.agents/plugins/marketplace.json`）として登録し、`/plugins` から `feedback-gate` をインストールします。

   ```
   codex plugin marketplace add nonchan7720/claude-hook-gate
   ```

2. **フックを Codex が読む場所に書きます。** Codex はまだプラグイン同梱のフックを走らせません（`plugin_hooks` の機能が開発中のため。[openai/codex#16430](https://github.com/openai/codex/issues/16430)）。そのためプラグインは入っても、`hooks/hooks.json` を `~/.codex/hooks.json` に写すまで何も動きません。インストール先かこのリポジトリのチェックアウトから、インストーラを引数なしで 1 回実行してください。

   ```
   bash ~/.codex/plugins/cache/hook-gate/feedback-gate/<version>/plugins/codex/scripts/install-hooks.sh
   ```

   プラグインのバージョンの `feedback-gate` バイナリをダウンロードし（[前提](#前提)）、実行したディレクトリを指す形（`${PLUGIN_ROOT}` をその絶対パスに置き換えたもの）でフックを `~/.codex/hooks.json` に足します。ファイルに既にある他のフックは残ります。プラグインを更新したりチェックアウトを移したりしたら、もう一度実行してください。2 組目を足すのではなく自分の分を置き換えます。ほかに設定は要りません。Codex がプラグイン同梱のフックを走らせるようになった日には、写しは自分で黙ります（[二重に走らせない](#二重に走らせない)）。外すときは `--remove` です。

3. Codex を起動します。フックのレビューが必要だと表示されるので、`/hooks` を開いて信頼してください。管理層以外のフックは、信頼するまで動きません。

4. セッション最初のフック（SessionStart）が手順 2 で取ったバイナリを使います。以後ダウンロードはありません。

プラグインのルートはリポジトリそのものです。ルートの Codex 用マニフェスト（`.codex-plugin/plugin.json`、`plugin.json`）が `plugins/codex/hooks/hooks.json` を指し、`rules/`、`scripts/dogwood/`、`hooks/vendor/` は Claude Code 版とコピーせず共有します。

インストーラのオプション（Codex がフックを読む他の場所向け。1 回につき 1 つ）:

```
bash plugins/codex/scripts/install-hooks.sh                  # ~/.codex/hooks.json（$CODEX_HOME/hooks.json）に足す: 通常はこれ
bash plugins/codex/scripts/install-hooks.sh --project [dir]  # 代わりに <dir>/.codex/hooks.json に足す（既定は現在のディレクトリ）
bash plugins/codex/scripts/install-hooks.sh --to FILE        # 任意の hooks.json に足す
bash plugins/codex/scripts/install-hooks.sh --print          # 書かずに hooks.json の内容を表示。--to FILE を添えると FILE にマージした結果を表示（後述）
bash plugins/codex/scripts/install-hooks.sh --toml           # requirements.toml の [hooks] の形で表示（後述）
bash plugins/codex/scripts/install-hooks.sh --remove [...]   # 写しからプラグインのフックを外す
```

実体は `feedback-gate` バイナリの `install-hooks` サブコマンド（`internal/hookgate/codex_install_hooks.go`）です。対象は正しい JSON か存在しないファイルである必要があり、ファイルの他のフックとキーは順序ごと残し、このプラグインのグループ（command が `plugins/codex/scripts/hook.sh` を動かすもの）だけを置き換え、書き込みはアトミックです。プロジェクトへの写し（`--project`）は、Codex がその `.codex/` 層を信頼したプロジェクトでだけ動きます。`FEEDBACK_GATE_BIN` を指定すると、インストーラ（とフック）はダウンロードせずそのバイナリを使います。

### それでもフックが動かないとき

次の順で確かめてください。Codex の `/hooks` は見つけたフックの出どころと、信頼済み・無効・ポリシーで飛ばした、を一覧にします。`codex features list` は機能フラグを表示します。

1. **未信頼。** `/hooks` にレビュー待ちと出ている: 信頼してください（手順 3）。Codex はフックのハッシュに対して信頼を記録するので、`install-hooks.sh` をもう一度実行したあと（新しいバージョン、移したチェックアウト）は再び信頼が要ります。
2. **フックが無効。** `codex features list` で `hooks` が false（どこかの `config.toml` に `[features] hooks = false`）: 有効にするか、その行を消してください。
3. **写しが無い、または古い。** `~/.codex/hooks.json` に `plugins/codex/scripts/hook.sh` のエントリが無い、または既に無いパス（消えたバージョンのディレクトリ、移したチェックアウト）を指している: 現在の場所から `install-hooks.sh` を再実行してください。
4. **バイナリを入れられなかった。** フックは exit 0 で、標準エラーに 1 行 `feedback-gate: could not install the feedback-gate v<version> binary (<reason>); the hook did nothing`（`no-download-tool`、`no-sha256-tool`、`download-failed` など）を出します: [前提](#前提)を参照。`install-hooks.sh` も同じ行を出して exit 1 するので、上の手順 2 の時点で分かります。
5. **管理層のフックだけが動く。** `/hooks` でユーザー（とプラグイン）のフックがポリシーで飛ばされていると出る、または管理者の `requirements.toml`（Linux / macOS は `/etc/codex/requirements.toml`、Windows は `%ProgramData%\OpenAI\Codex\requirements.toml`。MDM のプロファイルや ChatGPT ワークスペースのクラウド配布の requirements でも同じ設定ができます）に `allow_managed_hooks_only = true` がある。このとき Codex はユーザー・プロジェクト・セッション・*プラグイン*のフックをすべて飛ばし、管理層のフック、つまり `requirements.toml` の `[hooks]`（スクリプトは `managed_dir` の下）かシステム層の `hooks.json`（`/etc/codex/hooks.json`）だけを走らせます。Claude Code 版で組織のガードが mod のフックを飛ばす状況（[組織管理の環境向けの settings hook](../../README_ja.md#組織管理の環境向けの-settings-hook)）の Codex 版ですが、違いが 1 つあります。Claude Code のプラグインはガードが飛ばさない settings hook を同梱できるのに対し、Codex のプラグインに同梱できるものはこのポリシーを越えられません。`~/.codex/` やプロジェクトに書いたものも動かないので、フックは管理者が配る必要があります（管理層のフックは `/hooks` での信頼が要りません）。渡すものは用意してあります。

   - `bash plugins/codex/scripts/install-hooks.sh --print > hooks.json` を `/etc/codex/hooks.json` として置いてもらう（既にあるなら `--print --to /etc/codex/hooks.json` で、そこのフックを残したまま）。または
   - `bash plugins/codex/scripts/install-hooks.sh --toml` の出力を `requirements.toml` に貼ってもらう（ユーザーがフックを切れないよう `[features] hooks = true` も一緒に）。
   - 加えて、出力が指すパスに置いた、全ユーザーが読めるこのリポジトリのチェックアウトを全マシンに（Codex はフックのスクリプトを配布しません。`scripts/hook.sh` は自分の場所からルートを求めるので `PLUGIN_ROOT` は不要です）。バイナリのキャッシュはユーザーごと（`~/.cache/feedback-gate`）なので、各ユーザーの最初のセッションが 1 回ダウンロードします。GitHub に出られないマシンでは、バイナリを共有のパスに置いて全員の `FEEDBACK_GATE_BIN` に指定するか、リリースのファイルのミラーを `FEEDBACK_GATE_RELEASE_BASE_URL` に指定してください。

### 管理層に自分でフックを置く

`allow_managed_hooks_only` の下で Codex が見るのはフックの*出どころ*であって、誰が書いたかではありません。管理層から来たフックは走らせ、それ以外は飛ばします。`~/.codex/` の下やプロジェクトのファイルはどれも管理層ではないので、そこで何を調整しても動きません。マシン上の素のファイルとして存在する管理層はシステムの設定フォルダ、Linux と macOS では `/etc/codex/` です。そこの `hooks.json`（またはそこの `config.toml` の `[hooks]`）は管理層のフックとして全ユーザーに対して信頼の確認なしに走り、ポリシーが `/etc/codex/requirements.toml` から来ていても、MDM のプロファイルや ChatGPT ワークスペースから来ていても、飛ばされません。そこに書くにはマシンの管理者権限（`sudo`）が要ります。それがあるなら、管理者がやることを自分でやります。

```
bash plugins/codex/scripts/install-hooks.sh --print --to /etc/codex/hooks.json > /tmp/feedback-gate-hooks.json
sudo install -D -m 0644 /tmp/feedback-gate-hooks.json /etc/codex/hooks.json
```

1 行目は自分として動きます。バイナリを自分のキャッシュに取り、`/etc/codex/hooks.json` に入るべき内容、つまり管理者が既に置いたフック（ファイルがあれば。読めれば十分です）にこのプラグインのフックをマージしたものを表示するだけで、何も書きません。2 行目が root の要る唯一の行で、それを配置します。プラグインを更新したりチェックアウトを移したりしたら同じ 2 行をもう一度実行してください。プラグインの分だけが置き換わり、他は残ります。外すときは `--print --remove --to /etc/codex/hooks.json` が、プラグインのフックを除いた内容を表示するので、同じ手順で配置します。フックが指すチェックアウト（`install-hooks.sh` を実行したディレクトリ）はそのままの場所に置き、Codex を使う全ユーザーが読めるようにしておいてください。Codex を再起動すると、`/hooks` にそのフックが管理層のものとして並びます。ポリシーが `requirements.toml` の `[hooks] managed_dir` まで固定している場合は、管理者が `--toml` の出力をそこに貼る形だけが使えます。マシンの管理者権限が無ければ、その管理者だけが経路で、渡すものは上の `--print` / `--toml` の出力です。

### 二重に走らせない

Codex は一致したフックを全ファイル分すべて走らせるので、プラグイン同梱のフックが動く環境（`plugin_hooks` が有効な Codex で、フックを信頼済み）に手順 2 の写しが残っていると、各イベントが 2 回ずつ走ります（gate の実行も通知も 2 回）。`scripts/hook.sh` は、どの層から呼ばれたかをバイナリに伝えます（`FEEDBACK_GATE_HOOK_SOURCE`: Codex が `PLUGIN_ROOT` を渡していれば `plugin`。Codex がこれを渡すのはプラグイン同梱のフックだけです。それ以外は `config`）。プラグイン層の呼び出しは毎イベント、マーカー `~/{.agents,.claude}/feedback/.codex_plugin_seen/<session_id>`（`CLAUDE_FEEDBACK_DIR` を尊重します）を書き、`config` の呼び出しは自分のセッションのマーカーがあれば何も出さず exit 0 します（`internal/hookgate/host_codex.go` の `CodexHookSourceAllows`）。プラグイン同梱のフックが動かない環境（上の各場合、または未信頼）ではマーカーが無いので、写しが働きます。両方が走りうるのはセッション最初の SessionStart だけで、その reset は冪等です。24 時間より古いマーカーはセッション開始時に消します（Claude Code 版の `.classic_seen` と同じ）。設定は要りません。写しが不要になったら `--remove` で外してください。

### Codex のサンドボックスとルール・`gate.yaml` の編集

フックは Codex の素の子プロセスとしてサンドボックスの外で動くので、フックが書くもの（`~/{.agents,.claude}/feedback/` の状態、`<project>/{.agents,.claude}/.gate-status/`、ルールの `count` 行、バイナリのキャッシュ）はサンドボックスのモードにも組織のサンドボックス方針にも制限されません。制限されるのは Codex 自身です。`workspace-write` モードでは `<writable_root>/.agents` と `<writable_root>/.codex` が（`.git` と同じく）再帰的に読み取り専用になります。そのため Codex に `.agents/feedback/` のプロジェクトのルールや `.agents/gate.yaml` の追加・編集を頼むと、その書き込みには承認（か `danger-full-access`）が要り、組織の requirements がそれを禁じていることもあります。`.claude/` は保護されません。Codex 自身にルールを育てさせたいプロジェクトでは、`<project>/.claude/feedback/` と `<project>/.claude/gate.yaml` に置いてください。このプラグインはそちらも読みます（`.agents/` が先、次に `.claude/`。同名のルールは `.agents/` 側が勝ちます）。グローバルの `~/.agents/feedback/` と `~/.claude/feedback/` はどちらにせよプロジェクトの書き込み可能なルートの外なので、Codex は承認があるときだけ編集します。自分だけが変えるべきルールは `.agents/` に置くのが向いています。サンドボックスがまさにそれを強制するからです。

## 前提

- `bash`、および初回は `curl` または `wget`: フックは Go 製のバイナリ `feedback-gate` を動かします。`scripts/hook.sh` が、このリポジトリの GitHub Releases からプラグインのバージョンの `feedback-gate_<os>_<arch>.tar.gz` をダウンロードし（SHA-256 を `checksums.txt` で照合します。`tar` と `sha256sum` / `shasum` も必要で、ハッシュのコマンドが無ければ何も入れません）、`${FEEDBACK_GATE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/feedback-gate}/<version>/feedback-gate` に置きます。ダウンロード（数 MB）は、インストールや更新のあとの最初のフック（SessionStart）で、そのフックの `timeout` の中で、バージョンごとに 1 回だけ行い、その後は何も要りません。バイナリがキャッシュに無く、ダウンロードもできなければ、フックは何もせず（exit 0）、標準エラーに 1 行だけ出します（`feedback-gate: could not install the feedback-gate v<version> binary (<reason>); the hook did nothing`）。`FEEDBACK_GATE_BIN`（実行ファイルのパス。ビルド済みのバイナリを指定すればダウンロードを避けられます）を指定すると探索を省き、`FEEDBACK_GATE_RELEASE_BASE_URL` でダウンロード先を差し替えられます（`file://` のディレクトリも使えますが `curl` が必要です。`wget` は `file://` を読めません）。ほかのバージョンのキャッシュのディレクトリは、30 日使われなかった場合にだけ削除します。対応は Linux と macOS の amd64 と arm64 です。
- `terminal-notifier`（任意、macOS）: デスクトップ通知。
- `dogwood`（任意）: gate のポリシーエンジン。[メインの README](../../README_ja.md#前提) を参照。

## フック

すべてのイベントが `hooks/hooks.json` の command hook `bash "${PLUGIN_ROOT}/plugins/codex/scripts/hook.sh" <Event>` で、`feedback-gate codex <Event>`（`cmd/feedback-gate` から作る Go 製のバイナリ。検査は `internal/hookgate`）を走らせます。Codex は Claude Code の command hook と同じイベント名・同じ stdin の JSON を送り、同じ出力（`permissionDecision`、`decision: block`、`additionalContext`、終了コード 2）を読むので、[メインの README の表](../../README_ja.md#フック) がそのまま当てはまります。違いは次のとおりです。

| Codex のイベント | 走るもの | Claude Code との違い |
| --- | --- | --- |
| SessionStart | `reset-gate` | なし。 |
| UserPromptSubmit | rules ファイル + `feedback-inject` | なし。 |
| PreToolUse（`Bash`） | `bash-changes`（`bashStarted`）、`feedback-guard`（`pre_bash`） | なし。 |
| PreToolUse（`apply_patch`） | ファイルごとの `feedback-guard`（`pre_edit`） | Codex はファイル編集を 1 つのパッチ（`tool_input.command`、`*** Begin Patch` 形式）で行います。パッチをファイルごとに分け（`internal/hookgate/apply_patch.go`）、`*** Add File` は `Write`（全文）、`*** Update File` は `Edit`（追加行）として検査します。`*** Move to` は移動先のパスで検査し、`*** Delete File` は検査しません。deny が 1 つでもあれば deny、無ければ ask です。 |
| PreToolUse（`spawn_agent` / `send_input`）、任意 | `agent-launch-guard` | `FEEDBACK_GATE_AGENT_LAUNCH_GUARD=true` のときだけ。`spawn_agent` は `Agent`（`agent_type` → `subagent_type`、`message` → `prompt`）、`send_input` は `SendMessage`（`agent_id` → `to`）として扱います。 |
| PostToolUse（`Bash`） | `bash-changes`、`feedback-bash-edit`、gate の `rules` | なし。 |
| PostToolUse（`apply_patch`） | ファイルごとの `feedback-file-inject` + `record-changes` + `feedback-post-edit`、その後 gate の `rules` を 1 回 | 上と同じ分け方。gate はパッチ全体で 1 回だけ走ります。Codex には `Read` ツールが無いので、`files` 付きのフィードバックルールはここ（と `Bash` の heredoc の書き先）で届き、最初の編集より前には届きません。 |
| PostToolUse（`spawn_agent`） | `subagent-report` | エージェント ID は `tool_response.agentId` か `agent_id` から読みます（JSON 文字列でも可）。 |
| PermissionRequest | `notification`（`notify`） | Codex には `Notification` イベントが無いので、ツール呼び出しが承認待ちになったときに「確認待ち」の通知を出します。フックは何も返さないので、承認の判断は通常のダイアログに残ります。 |
| Stop | `all-stop`（gate の `checks`、`stop_check`、`stop` 通知） | なし。 |
| SubagentStop | gate の `checks`、`stop_check`、`saveSubagentReport` | なし。 |

出力とプロセスの扱いの違いは次のとおりです。

- **`ask` は `deny` になる。** Codex の PreToolUse には `ask` が無く、返すとフックが失敗扱いになってツールがそのまま動きます。`severity: ask`（または `severity` 無しの `count` 3〜4）のルールは呼び出しを拒否し、理由にその旨を添えます。Claude Code と同じく、同じセッション・同じ対象への同じルールは次の呼び出しから `warn` に落ちるので、Codex は呼び出しを直してやり直せます。
- **warn がモデルに届く。** Claude Code はフックが stderr に出した warn を表示しますが、Codex は表示しません。PreToolUse（拒否しないとき）と PostToolUse では `additionalContext` として、Stop / SubagentStop では `systemMessage` として渡します。stderr にも従来どおり出します。
- **hook が kill されても gate のコマンドは道連れになる。** Codex は Esc や timeout で hook のプロセスグループに SIGKILL を送ります。gate は各コマンドを独立したプロセスグループで走らせるので、hook の死を検知してそのグループも kill し、テストの実行が孤児として残りません。

## 設定

Codex のプラグインには設定画面が無いので、Claude Code 版のオプションは `codex` を起動するプロセスの環境変数で渡します（`CLAUDE_PLUGIN_OPTION_<key>` も読みます）。

| 変数 | Claude Code のオプション | 値 |
| --- | --- | --- |
| `FEEDBACK_GATE_LANG` | `language` | `ja` / `en`。未設定なら `LC_ALL` / `LC_MESSAGES` / `LANG` に従う。 |
| `FEEDBACK_GATE_AGENT_LAUNCH_GUARD` | `agentLaunchGuard` | `true` で有効（既定は無効）。 |
| `FEEDBACK_GATE_ASK_AGENT_TYPES` | （なし） | launch guard が確認するエージェント種別（`agent_type`）。`,` または `;` 区切り（既定 `code-implementer`）。 |
| `FEEDBACK_GATE_ALLOW_RECIPIENTS` | （なし） | `send_input` で確認なしに送ってよい宛先（`agent_id`）。`,` または `;` 区切り（既定 `git-operator`）。 |
| `FEEDBACK_GATE_AUTO_COUNT` | `autoCount` | `false` で無効（既定は有効）。 |
| `FEEDBACK_GATE_RULES_FILE` | `rulesFile` | 毎回のプロンプトに注入する rules ファイルのパス（既定 `~/{.agents,.claude}/feedback-gate/feedback_rules.md`。無ければ同梱の `rules/feedback_rules.md`）。 |

`CLAUDE_FEEDBACK_DIR` と `DOGWOOD_BIN` は Claude Code と同じように効きます。状態ファイルのセッションの鍵には Codex のセッション ID を使います。

## 構成

Claude Code の settings hook と同じ形（`hooks/hooks.json` → `scripts/hook.sh` → `feedback-gate`）から、Codex に相当するものが無い mod（`register.js`）を除いたものです。

```
.codex-plugin/plugin.json       # Codex のマニフェスト（リポジトリのルート）。hooks -> plugins/codex/hooks/hooks.json
plugin.json                     # ポータブルな Agent Plugins のマニフェスト（リポジトリのルート）。同じ hooks
.agents/plugins/marketplace.json
plugins/codex/
├── hooks/hooks.json            # 全イベントの command hook
├── scripts/hook.sh             # 入口: feedback-gate を探すかダウンロードし（../../scripts/install-binary.sh）、`feedback-gate codex <Event>` を動かす
├── scripts/install-hooks.sh    # Codex はまだプラグインのフックを走らせないので hooks/hooks.json を ~/.codex/hooks.json などに写す（`feedback-gate codex install-hooks`）
└── README.md, README_ja.md
```

ソース: `cmd/feedback-gate`（バイナリ）と `internal/hookgate`（検査。ホストごとの違いは `Host`: `host.go`、`host_codex.go`、`host_claude.go`）です。バイナリは、release-please がリリースにタグを付けたときに GoReleaser（`.goreleaser.yaml`）がビルドして公開します。別のホストを足すときは `Host` を実装してサブコマンドを足すだけで、検査そのものには触りません。
