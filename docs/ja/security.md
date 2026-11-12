# セキュリティと権限

[← README](../../README_ja.md) · [English](../security.md)

レビューする人とインストールする人向けに、このプラグインが何を読み、何を実行し、何を書き、何を判定するかをまとめます。

- **ネットワーク**: プラグイン自身のコードはネットワークに何も送りません（HTTP クライアントを持ちません）。データがマシンの外に出るのは、プラグインが代わりに起動するプログラム（下記）を通したときだけです。つまり、あなたが `{.claude,.agents}/gate.yaml` やフィードバックルールの `check` に書いたコマンド（あなたの権限で動きます）と、macOS のデスクトップ通知です。
- **認証情報**: トークン・鍵・パスワードは読まず、必要ともしません。読む環境変数は `CLAUDE_FEEDBACK_DIR`、`DOGWOOD_BIN`、`FEEDBACK_GATE_LANG`、`HOME`、`LANG`、`LC_ALL`、`LC_MESSAGES`、`PATH`、`TERM_PROGRAM`、`__CFBundleIdentifier` だけです（ファイルやプログラムの場所、メッセージの言語を決めるため）。`gate.yaml` やルールの `check` に書いたコマンドは、あなたが自分で実行するコマンドと同じく、あなたの環境で動きます。
- **会話から読むもの**: Bash / Edit / Write / MultiEdit の呼び出しの入力（コマンド、ファイルパス、新しい内容）。フィードバックルールとの照合と、変更されたファイルの把握に使います。`Agent` / `SendMessage` の prompt と message は、`agentLaunchGuard` が有効なときだけ、確認画面に表示するために読みます。Notification イベントの文面は、デスクトップ通知に載せるために読みます。トランスクリプトは読みません。
- **ディスクから読むもの**: フィードバックルール（`~/{.claude,.agents}/feedback/*.md`、`<project>/{.claude,.agents}/feedback/*.md`）、ルールファイル、`{.claude,.agents}/gate.yaml`、自分の状態ファイル（下記）、Claude が編集したファイル、git から見た作業ツリーの状態。
- **起動するプログラム**:
  - `sh -c` で、`{.claude,.agents}/gate.yaml` のコマンドとフィードバックルールの `check`（どちらもあなたが書くもので、プラグインは同梱しません）。
  - `git`（`rev-parse`、`ls-files`、`diff`、`log`。読み取りのみ）で、リポジトリのルートと、Bash のコマンドが変更したファイルを調べます。
  - `sh`、`mkdir`、`mv`、`rm`、`rmdir`、`kill -0`、`sleep` で、下記ディレクトリにある自分の状態ファイルとロックを扱います。
  - `dogwood`（任意）で、gate のコマンドを今実行するかどうかを決めます。
  - macOS の通知用に `osascript`（前面ウィンドウの名前を読み、今見ているプロジェクトなら通知しないため）と `terminal-notifier`（通知を表示します。クリックすると `open -b <ターミナルアプリ>` か `code -r <プロジェクト>` でウィンドウを前面に出します）。
- **書き込むファイル**:
  - `<project>/{.claude,.agents}/.gate-status/`: gate の状態、コマンドのログ、ロック（プロジェクトに `{.claude,.agents}/gate.yaml` があるときだけ）。
  - `~/{.claude,.agents}/feedback/`: `.violations.jsonl`、`.errors.jsonl`、`.count_state/`、`.ask_state/`、`.new_rule_state/`、`.bash_started/`、`.classic_seen/`（セッションごとの空のマーカー）。
  - フィードバックルールのファイル（Claude が従う指示）の frontmatter にある `count:` の行。`autoCount` が有効なときにルール違反があると書き換えます（プラグインの設定で無効にできます）。`/correct apply` でも書き換えます。ファイルのそれ以外の部分は変えません。
  - 設定ファイル、`CLAUDE.md`、ビルドや起動のファイル、フックの設定は書きません。
- **権限の判定**（PreToolUse）: 返すのは `deny` か `ask` だけで、`allow` は返しません。呼び出しを厳しくすることはあっても、あなた自身の権限確認を飛ばすことはありません。判定するのは、Bash / Edit / Write / MultiEdit でフィードバックルールに一致したとき（ルールの `count` / `severity` により `deny` か `ask`）と、`agentLaunchGuard` が有効なときの `Agent` / `SendMessage`（全文を見せて `ask`）だけです。それ以外はイベントをそのまま次へ渡します。権限モード、設定、エージェント、Remote Control は変えません。
- **追加するコンテキスト**: UserPromptSubmit で、ルールファイルと確定したフィードバックルール（`count >= 3`）をコンテキストに加えます。PostToolUse・Stop・SubagentStop では、gate の結果とルール違反を Claude に返します（フィードバックかブロックの理由として）。PostToolUse(Agent) では、終わったサブエージェントの結果を呼び出し元のコンテキストに加えます。`gate.yaml` で [stop_review](gate.md#stop_review) を有効にしているときは、Stop / SubagentStop で見直しの指示（そのセッションが変更したファイルのパスと、`gate.yaml` の `stop_review.prompt` の文面を含む）もブロックの理由として返し、同梱スキル `effort-<level>` を呼ぶよう Claude に伝えます。`prompt` の文面は Claude への指示として届くので、信頼していないリポジトリの `gate.yaml` は、そのコマンドと同じように中身を確かめてください。
- **同梱スキルと effort**: `effort-<level>` スキルは、呼び出したターンの残りの effort（推論の量。使用量に影響します）を切り替えるだけです。`allowed-tools`・`model`・`hooks` は宣言せず、ツールや権限は増やさず、セッションの設定も変えません。
- **settings hook**: `hooks/hooks.json` はイベントごとに `command` hook を登録しており、`scripts/hook.sh` を経由して、イベントの JSON を stdin で渡した `feedback-gate claude <Event>`（Go 製のバイナリ）を実行します。mod のフックと同じ検査を行い、同じもの（deny / ask、block、追加する context）を返すので、上の各点はこちらにも当てはまります。セッションの mod のマーカーがあるとき、またはバイナリがキャッシュにも無くダウンロードもできないときは、何もせずに終わります。プラグイン設定は環境変数 `CLAUDE_PLUGIN_OPTION_*` から読みます。
- **コマンド**: セッション開始時に `/correct` を登録し、`command.run` のフックはこのコマンドにだけ応答します。
- **同梱ファイル**: `hooks/register.js` は `src/` から `scripts/build.ts` で作るもので、minify していません。メッセージの文面（`locales/<lang>.yaml`）は `hooks/vendor/locales-<lang>.js` に文字列のまま切り出しています（`register.js` の大きさを抑えるため）。`hooks/vendor/yaml.js` と `hooks/vendor/i18next.js` は npm パッケージの [`yaml`](https://www.npmjs.com/package/yaml) と [`i18next`](https://www.npmjs.com/package/i18next)（`package.json` / `bun.lock` で固定した版）で、ファイルを小さくするためだけに minify しています。検査で報告される getter、`Object.defineProperty`、Promise の判定（`typeof x.then === "function"`）は、この 2 つのライブラリ側のコードです（yaml のドキュメントのクラス、i18next の非同期読み込み）。プラグイン自身のコードは `Proxy`、`eval`、`new Function` を使っていません。
