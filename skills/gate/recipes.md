# gate.yaml recipes by toolchain

Blocks to adapt. Replace the script / target names with the project's own (see
discovery.md); keep the shape. `$CLAUDE_GATE_FILES` is project-root-relative, so these
rules run from the root unless noted.

## TypeScript / JavaScript (single package)

```yaml
rules:
  - match:
      - "src/**/*.{ts,tsx,js,jsx}"
      - "tests/**/*.{ts,tsx}"
      - package.json
      - "tsconfig*.json"
      - biome.json            # or eslint.config.*, .prettierrc*
    run:
      - parallel:
          - { name: lint, cmd: "bun run lint" }                 # biome check . / eslint .
          - { name: typecheck, cmd: "bun run typecheck" }       # tsc --noEmit
          - { name: test, cmd: "bun run test", files: false }   # bun test / vitest run / jest
    run_checks: [verify]

consistency_checks:
  - name: verify
    run:
      - parallel:
          - { name: lint, cmd: "bun run lint" }
          - { name: typecheck, cmd: "bun run typecheck" }
          - { name: test, cmd: "bun run test", files: false }
      - { name: build, cmd: "bun run build", timeout: 600 }
```

File-scoped variants for the rules phase (faster on large repos):
`npx eslint $CLAUDE_GATE_FILES`, `npx biome check $CLAUDE_GATE_FILES`,
`npx prettier --check $CLAUDE_GATE_FILES`, `npx vitest related --run $CLAUDE_GATE_FILES`,
`npx jest --findRelatedTests $CLAUDE_GATE_FILES`. `tsc` ignores file arguments when a
`tsconfig.json` is used; keep it whole-package. Replace `npx` / `bun run` with `pnpm` /
`yarn` to match the lock file.

## pnpm / yarn / npm workspaces

```yaml
rules:
  - match: "packages/*/src/**/*.{ts,tsx}"
    per_file_dir: pattern_root            # root = packages/<pkg>
    run:
      - parallel:
          - { name: lint, cmd: "pnpm lint" }         # the package's own script
          - { name: typecheck, cmd: "pnpm typecheck" }
          - { name: test, cmd: "pnpm test", files: false }
    run_checks: [workspace]
  - match: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/*/package.json"]
    run: [{ name: install-check, cmd: "pnpm install --frozen-lockfile --offline || pnpm install --frozen-lockfile" }]
    run_checks: [workspace]

consistency_checks:
  - name: workspace
    timeout: 900
    run:
      - { name: build, cmd: "pnpm -r build" }        # or: pnpm turbo run build test
      - { name: test-all, cmd: "pnpm -r test", files: false }
```

## Python (uv / poetry / pip)

```yaml
rules:
  - match: ["src/**/*.py", "tests/**/*.py", "pyproject.toml"]
    run:
      - parallel:
          - { name: ruff, cmd: "uv run ruff check $CLAUDE_GATE_FILES" }
          - { name: format, cmd: "uv run ruff format --check $CLAUDE_GATE_FILES" }
          - { name: mypy, cmd: "uv run mypy src", timeout: 600 }        # or pyright
          - { name: test, cmd: "uv run pytest -q -x", files: false }
    run_checks: [full-tests]

consistency_checks:
  - name: full-tests
    run: [{ name: pytest, cmd: "uv run pytest -q", files: false, timeout: 900 }]
```

`poetry run ...` / `pipenv run ...` / plain `python -m ...` according to the lock file.
A project with `tests/test_<module>.py` convention can run only the related tests in the
rules phase: `uv run pytest -q $(for f in $CLAUDE_GATE_FILES; do t="tests/test_$(basename "${f%.py}").py"; [ -f "$t" ] && printf '%s ' "$t"; done) tests/conftest.py`.

## Go

```yaml
rules:
  - match: "**/*.go"
    per_file_dir: file                      # one directory = one package
    run:
      - { name: fmt, cmd: "test -z \"$(gofmt -l .)\"" }
      - { name: vet, cmd: "go vet ." }
      - { name: test, cmd: "go test ." }
    run_checks: [go-all]
  - match: ["go.mod", "go.sum", "go.work"]
    run: [{ name: mod, cmd: "go mod tidy -diff" }]   # Go >= 1.23; else: go mod verify
    run_checks: [go-all]

consistency_checks:
  - name: go-all
    timeout: 900
    run:
      - { name: build, cmd: "go build ./..." }
      - { name: lint, cmd: "golangci-lint run ./..." }      # when .golangci.yml exists
      - { name: test-all, cmd: "go test ./...", files: false }
```

With `go.work`, use `per_file_dir: pattern_root` and `match: services/*/**/*.go` so each
module runs its own `go test ./...`.

## Rust

```yaml
rules:
  - match: ["src/**/*.rs", "tests/**/*.rs", "Cargo.toml", "Cargo.lock"]
    run:
      - { name: fmt, cmd: "cargo fmt --all -- --check" }
      - { name: clippy, cmd: "cargo clippy --all-targets -- -D warnings", timeout: 900 }
    run_checks: [cargo-test]

consistency_checks:
  - name: cargo-test
    run: [{ name: test, cmd: "cargo test --workspace", files: false, timeout: 1200 }]
```

## Ruby (Rails / gems)

```yaml
rules:
  - match: ["app/**/*.rb", "lib/**/*.rb", "spec/**/*.rb", "config/**/*.rb", "Gemfile", "Gemfile.lock"]
    run:
      - { name: rubocop, cmd: "bundle exec rubocop $CLAUDE_GATE_FILES" }
    run_checks: [rspec]
  - match: "db/migrate/*.rb"
    run: [{ name: schema, cmd: "bundle exec rails db:migrate && git diff --exit-code db/schema.rb" }]
    run_checks: [rspec]

consistency_checks:
  - name: rspec
    run: [{ name: rspec, cmd: "bundle exec rspec", files: false, timeout: 900 }]
```

Related specs only in the rules phase: `bundle exec rspec $(for f in $CLAUDE_GATE_FILES;
do s="spec/${f#app/}"; s="${s%.rb}_spec.rb"; [ -f "$s" ] && printf '%s ' "$s"; done)`.

## JVM (Gradle / Maven)

```yaml
rules:
  - match: ["src/**/*.{java,kt}", "build.gradle.kts", "settings.gradle.kts", "gradle/**"]
    run:
      - { name: spotless, cmd: "./gradlew spotlessCheck --quiet", timeout: 600 }
    run_checks: [gradle-check]

consistency_checks:
  - name: gradle-check
    run: [{ name: check, cmd: "./gradlew check --quiet", files: false, timeout: 1800 }]
```

Maven: `./mvnw -q -B verify` in the check; `./mvnw -q spotless:check` in the rule.

## Terraform

```yaml
rules:
  - match: "**/*.tf"
    per_file_dir: file
    run:
      - { name: fmt, cmd: "terraform fmt -check" }
      - { name: validate, cmd: "terraform init -backend=false -input=false >/dev/null && terraform validate", timeout: 600 }
      - { name: tflint, cmd: "tflint" }             # when .tflint.hcl exists
```

## Shell, YAML, Markdown, GitHub Actions

```yaml
rules:
  - match: ["**/*.sh", "scripts/**"]
    run: [{ name: shellcheck, cmd: "shellcheck $CLAUDE_GATE_FILES" }]
  - match: ".github/workflows/*.yml"
    run: [{ name: actionlint, cmd: "actionlint $CLAUDE_GATE_FILES" }]
  - match: "**/*.md"
    run: [{ name: markdownlint, cmd: "markdownlint $CLAUDE_GATE_FILES" }]
```

## Makefile- / just-driven projects

When the task runner is the interface, call its targets and let it pick the tools:

```yaml
rules:
  - match: ["src/**", "tests/**", "Makefile"]
    run:
      - parallel:
          - { name: lint, cmd: "make lint" }
          - { name: test, cmd: "make test", files: false }
    run_checks: [ci]

consistency_checks:
  - name: ci
    run: [{ name: ci, cmd: "make ci", files: false, timeout: 1200 }]   # or: just check
```

## Options to mention to the user

```yaml
report_success: false   # no "All checks passed" block at stop
policy: false           # run every time; default policy throttles the same name to 1 per 2 min
```

and per command `share: false` (never wait for another agent's identical run), `files:
false` (share whole-project runs), `timeout`.
