# 開発

[← README](../../README_ja.md) · [English](../development.md)

[Bun](https://bun.sh) と [Go](https://go.dev)（1.27 以上）が必要です。[mise](https://mise.jdx.dev/) を使うなら `mise install` で道具がすべて入ります。

```
mise install             # bun、node、go、golangci-lint、goreleaser を入れる
bun install              # 開発用の依存を入れる

mise run lint            # golangci-lint run ./... && bun run lint
mise run fmt             # golangci-lint fmt ./... && bun run format
mise run test            # go test ./... && bun run test
mise run build           # go build -o bin/feedback-gate ./cmd/feedback-gate

bun run typecheck        # tsc --noEmit
bun run build            # src/ を hooks/register.js にバンドル
bun run test:plugin      # ビルドして、実エンジンで hooks/register.test.ts を実行
bun run validate:plugin  # claude plugin validate . --strict
```

## 構成

同じ検査を 2 つの実装で持っています。片方を変えたら、もう片方とそのテストも揃えてください。

| 場所 | 役割 |
| --- | --- |
| `src/` | TypeScript の実装。`src/register.ts` が Claude Code の関数 hook（mod）として登録する |
| `internal/hookgate/` | Go の実装。`src/` のモジュール 1 つにつきファイル 1 つ |
| `cmd/feedback-gate/` | Go のバイナリ。`feedback-gate claude <Event>` / `codex <Event>` |
| `locales/` | メッセージの文面（`ja.yaml` と `en.yaml`。キーは一致させる） |
| `tests/`、`internal/hookgate/*_test.go` | テスト。Go 側は `tests/*.spec.ts` の移植 |
| `skills/`、`rules/` | 同梱スキルと共通ルールファイル |
| `plugins/codex/` | Codex プラグイン |

- 中核は、command hook の JSON を受けて判定を返します。Claude Code と Codex の違いは Go 側の `Host`（`host_claude.go`、`host_codex.go`）に閉じています。
- ファイルやプロセスへのアクセスは `src/io.ts` の `Io` インターフェース越しに行います。テストは同じコードを Node の上で動かします。
- TypeScript の統合テスト（`tests/cli.spec.ts` など）は Go のバイナリを子プロセスで起動します。`FEEDBACK_GATE_BIN` が無ければテストがビルドします。

## バンドル

- `hooks/register.js` と `hooks/vendor/` は、プルリクエスト上で CI（Build bundle）が作ってコミットします。手でコミットや編集をしないでください。
- `scripts/build.ts` は、バンドルが相対パスと `claude-code` 以外を import したとき、出力が 200 KiB 以上になったときにビルドを失敗させます。

## CI

- **CI**: lint、テスト、バンドル、`claude plugin validate`、`claude plugin test`。
- **UI screenshots**: `/hook-list` の画面を撮ってプルリクエストのコメントに貼ります。
- bot が作ったコミット（バンドルのコミット、リリース PR）では、ワークフローの実行に承認が要ることがあります。
- 依存は公開から 7 日経ったバージョンだけを使います（`bunfig.toml` の `minimumReleaseAge`、Dependabot の `cooldown`）。Actions はコミット SHA で固定しています。

## リリース

バージョンは [release-please](https://github.com/googleapis/release-please) で管理します。コミットメッセージと PR タイトルは [Conventional Commits](https://www.conventionalcommits.org/ja/) で書いてください。接頭辞は `feat:`、`fix:`、`docs:`、`chore:` などです。

1. `main` への push ごとに、リリース PR が作成・更新されます（バージョンと `CHANGELOG.md`）。
2. それをマージすると、タグ `vX.Y.Z` と GitHub のリリースが作られます。
3. 続けて [GoReleaser](https://goreleaser.com/) が各 OS 向けのバイナリと `checksums.txt` をリリースに添付します。

`scripts/hook.sh` はプラグインのバージョンに対応するバイナリを取りに行くので、リリースにバイナリが付いて初めて、そのバージョンが組織管理の環境で使えます。
