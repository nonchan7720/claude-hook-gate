# Discovering what the project runs

Goal: a list of `(purpose, exact command, directory, typical duration)` rows taken from
the project, not invented. Purpose is one of lint, format, typecheck, unit test,
integration test, build, generate-check (e.g. `go generate` / codegen diff), schema or
migration check.

## 1. Existing gate

`.claude/gate.yaml` (also `.claude/gate.yaml` of worktrees). Keep what works; the user's
comments there explain past decisions.

## 2. Language and package manager

| Found | Stack | Package manager hints |
| --- | --- | --- |
| `package.json` | JavaScript / TypeScript | `bun.lock` / `bun.lockb` → bun; `pnpm-lock.yaml` → pnpm; `yarn.lock` → yarn; `package-lock.json` → npm. `workspaces` / `pnpm-workspace.yaml` → monorepo. |
| `pyproject.toml`, `setup.cfg`, `requirements*.txt` | Python | `uv.lock` → `uv run`; `poetry.lock` → `poetry run`; `Pipfile.lock` → `pipenv run`; `[tool.ruff]`, `[tool.mypy]`, `[tool.pytest.ini_options]` name the tools. |
| `go.mod`, `go.work` | Go | `go.work` → several modules; `.golangci.yml` → golangci-lint. |
| `Cargo.toml` | Rust | `[workspace]` → workspace. |
| `Gemfile` | Ruby | `.rubocop.yml`, `spec/` (rspec) or `test/` (minitest). |
| `build.gradle(.kts)`, `pom.xml` | JVM | `./gradlew` / `./mvnw` wrappers. |
| `*.csproj`, `*.sln` | .NET | `dotnet`. |
| `mix.exs` | Elixir | `mix`. |
| `composer.json` | PHP | `composer` scripts. |
| `*.tf` | Terraform | `terraform`, `tflint`, `tfsec`. |
| `Dockerfile`, `*.sh`, `*.yml` | Infra / scripts | `hadolint`, `shellcheck`, `yamllint`, `actionlint`. |

A project usually has several rows; make one rule per stack.

## 3. Task runner (prefer its targets over raw commands)

- `Makefile` / `GNUmakefile`: `grep -E '^[a-zA-Z0-9_.-]+:' Makefile`; read the recipes
  of `lint`, `fmt`, `check`, `test`, `build`, `ci`, `verify`.
- `justfile`: `just --list` or read the file.
- `Taskfile.yml`: `task --list` or read `tasks:`.
- `mise.toml` / `.mise.toml`: `[tasks]`.
- `package.json` `scripts` (also each workspace package's); `composer.json` `scripts`;
  `pyproject.toml` `[tool.poe.tasks]` / `[tool.pdm.scripts]`; `Rakefile`.
- `scripts/` or `bin/` directories with `lint.sh`, `test.sh`, `ci.sh`.

The target is the command to put in gate.yaml (`make lint`, `bun run test`), since it is
what both the developer and CI run.

## 4. CI configuration (the source of truth for what must pass)

| File | What to read |
| --- | --- |
| `.github/workflows/*.yml` | Each job's `steps[].run`; `working-directory`; `strategy.matrix` (pick one combination, the one closest to the developer machine); `services` (a step that needs a database is an integration test, not a rules-phase command). Ignore checkout, setup-*, cache, upload-artifact, codecov, release, deploy steps. Reusable workflows (`uses: ./.github/workflows/...`) and composite actions (`.github/actions/*/action.yml`) hide more `run` steps. |
| `.gitlab-ci.yml` | `script:` of each job; `stage`; `include:`d files. |
| `.circleci/config.yml` | `run:` steps; orbs may wrap commands. |
| `Jenkinsfile` | `sh '...'` steps. |
| `bitbucket-pipelines.yml`, `azure-pipelines.yml`, `.buildkite/*.yml`, `.drone.yml`, `cloudbuild.yaml` | Their `script` / `steps`. |
| `.pre-commit-config.yaml`, `lefthook.yml`, `.husky/`, `lint-staged` in `package.json` | Per-file hooks the project already runs on commit; these map directly to `rules` with `$CLAUDE_GATE_FILES`. |

For each CI step write: job name, command, directory, and whether it depends on
services, secrets or the network. Keep the names: `# CI job "lint"` comments in gate.yaml.

## 5. Mapping CI to the gate

| CI step | Gate placement |
| --- | --- |
| Linter / formatter check that accepts file arguments (eslint, biome, prettier, ruff, rubocop, golangci-lint, shellcheck, markdownlint) | `rules`, with `$CLAUDE_GATE_FILES`. |
| Typecheck of a whole package (`tsc --noEmit`, `mypy`, `pyright`) | `rules` when it takes a few seconds; otherwise `consistency_checks`. |
| Unit tests of one package | `rules` scoped by `dir` / `per_file_dir`; or related-tests mode (`vitest related`, `jest --findRelatedTests`, `pytest <test files>` picked by convention). |
| Whole-project tests, build, cross-package typecheck, codegen diff (`go generate && git diff --exit-code`) | `consistency_checks`, referenced from every rule whose files can break them. |
| Steps needing services (databases, browsers), secrets, deploy, release, publish | Leave out; mention them in the report. |
| Coverage thresholds | Keep the test command, drop the upload; keep a threshold flag only if the developer runs it locally too. |

## 6. Repository layout

- Single package: `dir` omitted, globs like `src/**/*.ts`.
- One directory = one package (Go packages, Terraform modules, Bazel-style): rules with
  `per_file_dir: file` and commands that run in `.` (`go test .`, `terraform validate`).
- Workspaces with nested sources (pnpm / yarn / npm workspaces, cargo / uv workspaces,
  Gradle multi-project): `per_file_dir: pattern_root` with `match: packages/*/src/**/*.ts`
  (the `**` right after the package directory), commands run in the package root
  (`pnpm test`, `cargo test`). Whole-workspace commands (`pnpm -r build`, `cargo build
  --workspace`, `turbo run test`) go to `consistency_checks`.
- Generated / vendored directories (`vendor/`, `node_modules/`, `dist/`, `*_pb.go`,
  `*.generated.ts`, `migrations/*.sql` if generated): do not match them.

## 7. Measure

Run each candidate command once from its directory and note wall time (`time cmd`). Use
it to set `timeout` (≈ 3 ×, minimum 60) and to decide rules (seconds) vs checks (longer).
Note which commands download dependencies on first run; a first run that takes minutes
for downloads is not the steady-state duration.
