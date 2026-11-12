# Development

[← README](../README.md) · [日本語](ja/development.md)

You need [Bun](https://bun.sh) and [Go](https://go.dev) (1.27 or later). With [mise](https://mise.jdx.dev/), `mise install` installs every tool.

```
mise install             # bun, node, go, golangci-lint, goreleaser
bun install              # dev dependencies

mise run lint            # golangci-lint run ./... && bun run lint
mise run fmt             # golangci-lint fmt ./... && bun run format
mise run test            # go test ./... && bun run test
mise run build           # go build -o bin/feedback-gate ./cmd/feedback-gate

bun run typecheck        # tsc --noEmit
bun run build            # bundle src/ into hooks/register.js
bun run test:plugin      # build, then run hooks/register.test.ts on the real engine
bun run validate:plugin  # claude plugin validate . --strict
```

## Layout

The same checks exist in two implementations. When you change one, change the other and its tests too.

| Place | Role |
| --- | --- |
| `src/` | The TypeScript implementation. `src/register.ts` registers it as Claude Code function hooks (the mod) |
| `internal/hookgate/` | The Go implementation, one file per module of `src/` |
| `cmd/feedback-gate/` | The Go binary: `feedback-gate claude <Event>` / `codex <Event>` |
| `locales/` | Message texts (`ja.yaml` and `en.yaml`; keep the keys identical) |
| `tests/`, `internal/hookgate/*_test.go` | Tests. The Go ones are ports of `tests/*.spec.ts` |
| `skills/`, `rules/` | Bundled skills and the shared rules file |
| `plugins/codex/` | The Codex plugin |

- The core takes the JSON of a command hook and returns a decision. What differs between Claude Code and Codex is kept in `Host` on the Go side (`host_claude.go`, `host_codex.go`).
- Files and processes are reached through the `Io` interface in `src/io.ts`. Tests run the same code on Node.
- The TypeScript integration tests (`tests/cli.spec.ts` and others) start the Go binary as a child process. Without `FEEDBACK_GATE_BIN` the tests build it.

## The bundle

- `hooks/register.js` and `hooks/vendor/` are built and committed by CI (Build bundle) on the pull request. Do not commit or edit them by hand.
- `scripts/build.ts` fails the build when the bundle imports anything other than relative paths and `claude-code`, or when an output file reaches 200 KiB.

## CI

- **CI**: lint, tests, the bundle, `claude plugin validate`, `claude plugin test`.
- **UI screenshots**: captures the `/hook-list` page and posts it as a comment on the pull request.
- On commits made by a bot (the bundle commit, the release PR), workflow runs may need approval.
- Dependencies are only taken 7 days after publication (`minimumReleaseAge` in `bunfig.toml`, `cooldown` in Dependabot). Actions are pinned by commit SHA.

## Releases

Versions are managed by [release-please](https://github.com/googleapis/release-please). Write commit messages and PR titles as [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, ...).

1. Each push to `main` creates or updates the release PR (versions and `CHANGELOG.md`).
2. Merging it creates the tag `vX.Y.Z` and the GitHub release.
3. [GoReleaser](https://goreleaser.com/) then attaches the binaries for each OS and `checksums.txt` to the release.

`scripts/hook.sh` downloads the binary that matches the plugin version, so a version only works in managed environments once its release has the binaries attached.
