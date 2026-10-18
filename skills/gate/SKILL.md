---
name: gate
description: Create, update or review a project's `.claude/gate.yaml`, the per-project quality gate of feedback-gate (lint, format check, typecheck, tests, build) that runs after Claude edits files and before it stops. Discovers the project's languages, package manager, task runner (Makefile, package.json scripts, justfile, Taskfile, mise tasks) and CI workflows (GitHub Actions, GitLab CI, ...) and turns the checks CI already runs into gate rules and consistency checks. Use when the user asks to set up, generate, configure, tune, review or fix gate.yaml, or to have Claude run the project's lint / tests automatically after changes.
argument-hint: "[init|update|review]"
---

# gate: write `.claude/gate.yaml` for this project

`.claude/gate.yaml` is opt-in: without it the gate does nothing. With it, feedback-gate
runs the project's own checks in two phases:

- **`rules`** (PostToolUse, after Edit / Write / MultiEdit and after a Bash command that
  rewrote files): each rule whose `match` globs hit a changed file runs its `run`
  commands. Failures come back to Claude as feedback and are rerun at stop; they do not
  block the turn by themselves.
- **`consistency_checks`** (Stop / SubagentStop): named checks that run only when a rule
  that matched referenced them in `run_checks`. A failure blocks the stop until fixed
  (up to 5 times). When everything passed, the agent is told to report the result.

Field semantics are in [reference.md](reference.md) (the authoritative schema is
`${CLAUDE_PLUGIN_ROOT}/scripts/gate.schema.json`; read it when a detail matters). How to
find what the project runs is in [discovery.md](discovery.md). Ready-made blocks per
toolchain are in [recipes.md](recipes.md).

Arguments: `$ARGUMENTS`. `init` writes a new file (ask before overwriting an existing
one); `update` edits the existing file for a change the user describes or a drift from
CI; `review` reports what the current file does, what CI runs that it does not, and what
to change, without editing. Without an argument: `init` when no file exists, else `update`.

## 1. Discover (do not guess the commands)

Follow discovery.md. In short, read: the existing `.claude/gate.yaml`; manifests
(`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `build.gradle*`,
`pom.xml`, `*.csproj`, `mix.exs`, ...); the task runner (`Makefile`, `justfile`,
`Taskfile.yml`, `mise.toml` tasks, `package.json` scripts, `composer.json` scripts); CI
(`.github/workflows/*.yml`, `.gitlab-ci.yml`, `.circleci/config.yml`, `Jenkinsfile`,
`bitbucket-pipelines.yml`, `azure-pipelines.yml`); lint / format / typecheck configs;
the repository layout (single package, workspace, one-directory-one-package). Write down
the exact commands CI runs for lint, format check, typecheck, unit tests, build, and
which directory each runs in.

## 2. Design

- **Mirror CI, through the task runner.** Use the same script or target CI calls
  (`bun run lint`, `make test`, `just check`) so the gate and CI cannot drift. Fall back
  to the raw tool command only when there is no target. Drop CI-only parts: coverage
  upload, caching, matrix dimensions, artifact steps, release steps.
- **rules = fast and scoped.** Lint / format check / typecheck for the changed files;
  tests of the package that owns them. Pass the changed files where the tool accepts
  them: `$CLAUDE_GATE_FILES` holds the matched paths, project-root-relative, shell-quoted
  and space-separated (`eval "set -- $CLAUDE_GATE_FILES"` if paths may contain spaces;
  when the command runs in a subdirectory via `dir` / `per_file_dir`, the paths are still
  relative to the project root, so either run such a command from the root or prefix
  with `$CLAUDE_PROJECT_DIR`).
- **consistency_checks = whole project, blocking.** The full test suite, the build, the
  cross-package typecheck: things a change in one place can break elsewhere. Every rule
  whose files can break other packages must list the check in `run_checks`; a rule
  without `run_checks` is forgotten once it passes.
- **Layout.** One rule per language or package group. Monorepo with one package per
  directory (Go, Terraform modules) → `per_file_dir: file`; packages with nested sources
  (pnpm / cargo / uv workspaces) → `per_file_dir: pattern_root` with the `**` placed at
  the package boundary (`packages/*/src/**/*.ts` → root `packages/<pkg>`). Include the
  manifests and lock files (`package.json`, `go.mod`, `Cargo.toml`, `tsconfig*.json`,
  lint configs) in a `match` so dependency and config changes rerun the checks.
- **Commands.** Give every command a short stable `name` (shown in the band and the
  logs; also the unit of serialization between agents). Put independent commands in one
  `parallel` block. Use check modes, never auto-fix (`prettier --check`, `ruff format
  --check`, `cargo fmt -- --check`, `gofmt -l`). Never include: deploys, anything needing
  secrets or the network beyond a package registry, watch / interactive modes, commands
  that edit files, e2e suites that take minutes (unless the user asks; then a long
  `timeout` and `files: false`).
- **Timing.** `timeout` (seconds, default 300) ≈ 3 × the measured duration, at least
  60. `files: false` on whole-project commands (`go test ./...`, `pytest`) so agents
  that changed different files share one run. The bundled policy runs the same `name`
  at most once per 2 minutes and pauses it after 3 failures in 10 minutes; tell the user
  about `policy: false` if they want every edit checked, and that `dogwood` is optional
  (without it, the default policy runs every time and custom policies defer commands).
- **Skip** generated code, vendored dependencies, build outputs and the `.claude/`
  directory: do not match them.

## 3. Write

- Path `.claude/gate.yaml` at the project root (the git root, or the worktree root).
  Compare against reference.md: only the listed keys exist (`additionalProperties:
  false`); `rules` is required; every `run_checks` name exists in `consistency_checks`;
  `dir` is root-relative with no `..`; `parallel` is not nested.
- Comments in the file: one line per rule saying where the command comes from (`# same
  as CI job "lint"`), so the next person can check drift.
- Ensure `.gitignore` contains `.claude/.gate-status/` (the gate's state and logs). Add
  it if missing.
- Do not put machine-specific paths (such as the plugin's schema path) in the file.

## 4. Verify before handing over

1. Run every command once, from the directory the gate would use, on the current tree,
   and note the duration. A command that fails on a clean tree means the command is
   wrong or the tree is already red; fix the command, or tell the user which check is
   red today. Never ship a gate that is red on an untouched tree.
2. Dry-run the matching: pick two or three files the user edits often and say which
   rules and checks would run for them; make sure the manifests match something.
3. If the plugin is installed, make a trivial edit to a matched file and watch the
   `[gate] running:` band; the result lands in the Stop output. Revert the edit.

## 5. Report

Tell the user, in a few lines: which rules run on which files, which checks run at stop,
the measured durations and timeouts, what CI runs that the gate deliberately leaves out
(and why), and how to tune it (`policy: false`, `share: false`, `report_success: false`,
`timeout`). For `review`, the same plus the drift list and a proposed diff.
