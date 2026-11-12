# 開発

[← README](../../README_ja.md) · [English](../development.md)

[Bun](https://bun.sh) と [Go](https://go.dev)（1.27 以上）が必要です。[mise](https://mise.jdx.dev/) を使うなら、`mise install` で `mise.toml` に書いた道具（bun、node、go、golangci-lint、goreleaser）がすべて入り、`mise run lint|fmt|test|build` が入口になります（下記）。フックのモジュールは Claude Code の中で動き、相対 import と `claude-code` しか解決できないため、`src/` のソース（と `yaml`・`i18next` パッケージ、文字列として取り込む `locales/*.yaml`）を `hooks/register.js` にバンドルします。`yaml` と `i18next` は minify して `hooks/vendor/*.js` に切り出し、バンドルから相対パスで import します。Claude のプラグインディレクトリの「1 ファイル 256 KiB 未満」という制限に余裕を持って収めつつ、プラグイン自身のコードは読める形で残すためです。`hooks/hooks.json` はこのバンドルを指します。ファイルやプロセスへのアクセスはすべてエンジンの `$` API（`$.fs`、`$.process`、`$.env`、`$.session`）を、`src/io.ts` の `Io` インターフェース越しに使います。テストは同じコードを Node の `fs` / `child_process` の上で動かします。

コードは、検査が「それを動かすホスト」に依存しないように層を分けています。中核は classic コマンド hook の JSON を入力に取り、`Outcome` を返します。mod（`src/register.ts`）と command hook の CLI はこれを呼びます。command hook の CLI は Go 製のバイナリ `feedback-gate`（`cmd/feedback-gate`。`feedback-gate claude <Event>` / `feedback-gate codex <Event>` / `feedback-gate version` の 3 つのコマンド）で、検査は `internal/hookgate`（`src/` のモジュール 1 つにつき Go のファイル 1 つ）にあり、`locales/` のメッセージファイルは埋め込んでいます。Claude Code と Codex で違うのは `Host`（環境変数からの `options`、ホストの JSON → 中核のイベントと payload の `normalize`、中核の `Outcome` → ホストの出力の `render`）です。1 回で複数ファイルを編集するツール（Codex の `apply_patch`）はファイルごとの payload に正規化し、中核はそのために `preToolUseEdits` / `postToolUseEdits` を用意しています。

```
mise install         # mise.toml の道具（bun、node、go、golangci-lint、goreleaser）を入れる
bun install          # 開発用の依存を入れる
mise run build       # go build -o bin/feedback-gate ./cmd/feedback-gate
mise run lint        # golangci-lint run ./... && bun run lint
mise run fmt         # golangci-lint fmt ./... && bun run format
mise run test        # go test ./... && bun run test

go test ./...        # Go の単体テスト（internal/hookgate。tests/*.spec.ts を移植したもの）
bun run lint         # Biome（lint とフォーマットの検査）。`bun run format` で自動修正
bun run typecheck    # tsc --noEmit
bun run test         # bun test（tests/*.spec.ts）
bun run build        # src/register.ts を hooks/register.js にバンドル（+ hooks/vendor/*.js）
bun run test:plugin  # ビルドしてから、実エンジンで hooks/register.test.ts を実行
bun run validate:plugin  # claude plugin validate . --strict
bun scripts/ui-screenshots.ts out/  # /hook-list の画面を撮る（tests/fixtures/hook-list/ のサンプル）
```

TypeScript の統合テスト（`tests/cli.spec.ts`、`tests/codex-cli.spec.ts`）は Go のバイナリを子プロセスとして起動し、stdin / stdout / stderr / 終了コードを確かめます。`tests/hook-script.spec.ts` と `tests/codex-hook-script.spec.ts` は、偽のバイナリと偽のリリースのディレクトリ（`FEEDBACK_GATE_RELEASE_BASE_URL=file://...`）で `scripts/hook.sh` を確かめます。バイナリは、`FEEDBACK_GATE_BIN` があればそれを使い（CI が先に 1 度ビルドします）、無ければテストが `go build` で `node_modules/.cache/feedback-gate/feedback-gate` に作ります。

バンドル（`hooks/register.js` と `hooks/vendor/`）は、プルリクエスト上で CI が生成してコミットします。貢献者がコミットする必要はありません（CI が追加するまでリポジトリには入っていません）。「Build bundle」ワークフローが、プルリクエスト（同一リポジトリのブランチ）ごとにバンドルを作り、ファイルの追加または変更があれば `chore: build bundle` コミットをそのブランチへ push します。ローカルで必要なとき（`bun run test:plugin` など）は `bun run build` で作れますが、コミットしないでください。手で編集もしないでください。`scripts/build.ts` は、バンドルが相対パスと `claude-code` 以外を import していたとき、または出力ファイルのどれかが 200 KiB 以上になったときにビルドを失敗させます。また、出力に含まれる見えない文字を `\uXXXX` のエスケープに書き換えます。`classic.PreToolUse` フックの引数名が `hooks/register.js` のほかの場所に出てくるときも失敗させます（プラグインディレクトリは、`next` に渡るイベントを追えない権限フックを受け付けないため）。CI ワークフローは、作ったバンドルに対して `claude plugin validate . --strict` と `claude plugin test .` を実行します。Claude Code の CLI は `devDependencies` の `@anthropic-ai/claude-code` を使います（`bun.lock` で版を固定し、Dependabot が更新します）。

`/hook-list` の画面（`webui/hook-list.html`）は、「UI screenshots」ワークフローがプルリクエスト（同一リポジトリのブランチ）ごとに `tests/fixtures/hook-list/` のサンプルで撮り（`bun scripts/ui-screenshots.ts <出力先>`。ローカルでも同じ）、プルリクエストのコメントに貼ります（push のたびに同じコメントを更新）。画像は `ui-screenshots` ブランチの `pr-<番号>/` に置き、コミットの SHA を含む URL で参照します。撮る前に、JS のエラー・データの埋め込み漏れ・読み込めない画像・横スクロール・真っ白な画像のどれかがあれば失敗させ、コメントを書く前に、各画像の URL が撮ったものと同じ内容を返すことを確かめます（欠けた画像を貼らないため）。

依存には 7 日間のフリーズ期間を設けています。`bunfig.toml` の `minimumReleaseAge` により、`bun install` は公開から 7 日以上経ったバージョンだけを解決します。Dependabot（`.github/dependabot.yml`）も `cooldown` で、npm と GitHub Actions の更新を公開から 7 日経つまで提案しません。Actions はコミット SHA で固定しています。

### リリース

バージョンは [release-please](https://github.com/googleapis/release-please) で管理します。コミットメッセージ（と PR タイトル）は [Conventional Commits](https://www.conventionalcommits.org/ja/)（`feat:`、`fix:`、`refactor:`、`chore:` など）で書いてください。`main` への push ごとに「Release Please」ワークフローがリリース PR を作成・更新し、`package.json`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`.codex-plugin/plugin.json`、`plugin.json` のバージョンを上げて `CHANGELOG.md` を更新します。それをマージするとリリースのタグ（`vX.Y.Z`）が付き、GitHub のリリースが作られます。同じワークフローが続けてそのタグで [GoReleaser](https://goreleaser.com/)（`.goreleaser.yaml`）を実行し、`feedback-gate` を linux / darwin / windows × amd64 / arm64 向けにビルドして、`feedback-gate_<os>_<arch>.tar.gz`（windows は `.zip`）と `checksums.txt` をそのリリースに添付します（リリースノートは release-please が持つので `release.mode: keep-existing` です）。`scripts/hook.sh` はプラグインのバージョンに対応するこれらのファイルをダウンロードするので、リリースにバイナリが付いて初めて、そのバージョンのプラグインが使えます。ただし release-please のジョブがバイナリをビルドするのは、自分が作ったリリースだけです。Go 移植をマージした時点で `plugin.json` が既に持っているバージョン（`v0.9.1`）にはまだバイナリがありません。Go 移植をマージしたあと、「Release Please」ワークフローを 1 度だけ手動で実行してください（Actions → Release Please → Run workflow、`main` から、`tag` に `v0.9.1`。または `gh workflow run release-please.yml -f tag=v0.9.1`）。この `workflow_dispatch` の実行は release-please を飛ばし、実行したブランチの HEAD（古いタグには Go のコードが無いため）をそのタグとして GoReleaser でビルドし、既存のリリースにバイナリを添付します。これで既存のインストールもバイナリを入手できます。同じ方法で、任意のリリースにバイナリを付け直すこともできます。どちらのワークフローも既定の `GITHUB_TOKEN`（PAT は使いません）を使うため、bot が作ったコミットや release-please の PR では CI が自動では起動しません。必須ステータスチェックを設定している場合は、再実行するか空コミットを手で push してください。
