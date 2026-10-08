# feedback-gate

[日本語](README_ja.md)

A Claude Code plugin made of function hooks. It does three things:

- Injects your feedback rules (`~/.claude/feedback/*.md`) into each prompt and enforces them on tool calls and when Claude stops.
- Runs per-project quality gates (lint, tests, etc.) defined in `.claude/gate.yaml` after file edits and when Claude stops.
- Sends a desktop notification when Claude waits for you or stops (macOS).

## Hooks

The hooks are registered in `src/register.ts` (bundled into `hooks/register.js` by CI; that bundle is what Claude Code loads) and call the TypeScript modules under `src/`.

| Event | Module | Role |
| --- | --- | --- |
| SessionStart | `src/reset-gate.ts` | Clears this session's gate state on `startup` / `clear`; keeps it on resume / compact. |
| UserPromptSubmit | `src/rules-file.ts` + `src/feedback-inject.ts` | Adds the rules file (your `rulesFile` if it exists, otherwise the bundled `rules/feedback_rules.md`) and the confirmed feedback rules (`count >= 3`) to the context. |
| PreToolUse (Bash / Edit / Write / MultiEdit) | `src/feedback-guard.ts` | Evaluates `pre_bash` / `pre_edit` enforce entries; denies, asks or warns by `count`. |
| PostToolUse (Write / Edit / MultiEdit) | `src/record-changes.ts`, then `src/stop-test-gate.ts` (`rules`) | Records changed files, then runs the matching rules of `.claude/gate.yaml` (via `src/gate.ts`). |
| PreToolUse (Agent / SendMessage), opt-in | `src/agent-launch-guard.ts` | Only when `agentLaunchGuard` is `true`: asks before sending instructions to a subagent, showing the full text. |
| Notification | `src/notification.ts` (`notify`) | Desktop notification when Claude waits for you (needs `terminal-notifier`, macOS). |
| Stop | `src/all-stop.ts` | Runs, in order: the gate `checks` phase, `src/feedback-stop-check.ts`, then the `stop` notification. |
| SubagentStop | gate `checks` phase, `src/feedback-stop-check.ts` | Same gate and `stop_check` rules for subagents. |

### Agent launch guard (optional)

`src/agent-launch-guard.ts` is active only when the `agentLaunchGuard` option (`userConfig`) is `true`. It is `false` by default. When enabled, it runs on PreToolUse for `Agent` and `SendMessage` and returns `ask`, putting the full text that would be sent into the confirmation reason so you can review it before the subagent receives it:

- `Agent`: asks when `subagent_type` is `code-implementer`, showing the `prompt`.
- `SendMessage`: asks for every recipient except `git-operator`, showing the `message`.

Anything else passes through to the normal permission flow. The target agent types and the allowed recipients are the `ASK_AGENT_TYPES` and `ALLOW_RECIPIENTS` arrays at the top of `src/agent-launch-guard.ts`.

To enable it, turn on `agentLaunchGuard` on the settings screen shown when you install the plugin with `/plugin`, or change it later in the `/config` menu (the plugin's `agentLaunchGuard` row).

```mermaid
flowchart LR
  P[UserPromptSubmit] --> I[feedback-inject]
  T[PreToolUse: Bash / Edit / Write / MultiEdit] --> G[feedback-guard]
  T2["PreToolUse: Agent / SendMessage<br/>(agentLaunchGuard = true)"] --> AL[agent-launch-guard]
  E[PostToolUse] --> R[record-changes]
  R --> S[stop-test-gate: rules]
  S --> SG[gate]
  X[Stop] --> A[all-stop]
  A --> C[stop-test-gate: checks]
  A --> F[feedback-stop-check]
  C --> SG
```

## Install

```
/plugin install feedback-gate --marketplace nonchan7720/claude-hook-gate
```

Answer `y` to add the marketplace, then choose the scope.

## Requirements

Nothing to install: the hooks are plain TypeScript, bundled into one JavaScript file that Claude Code runs itself (no Python, bash or jq).

- `terminal-notifier` (optional, macOS): needed only for the desktop notifications.
- `dogwood` (optional; an AWS tool, source at <https://github.com/dogwood-policy/dogwood>). Build and install it with `cargo install --git https://github.com/dogwood-policy/dogwood amzn-dogwood-cli` (crate `amzn-dogwood-cli`, binary `dogwood`). The gate uses it to decide whether each `.claude/gate.yaml` command runs now or is deferred. It is looked up in `DOGWOOD_BIN`, `PATH`, `~/.cargo/bin/dogwood` and `~/.local/share/mise/shims/dogwood`, in that order. When it is not found, commands under the bundled default policy run every time, while commands under a `policy:` you set are skipped and deferred.

## What it reads

- `.claude/gate.yaml` in the project (opt-in: without it, the gate does nothing). The format is described by `scripts/gate.schema.json`; the default policy is in `scripts/dogwood/`.
- `~/.claude/feedback/*.md`: feedback rules with frontmatter (`name`, `description`, `type`, `count`, optional `enforce`). Rules with `count >= 3` are injected and enforced. Override the directory with `CLAUDE_FEEDBACK_DIR`.
- The rules file, added to the context on every prompt. By default the bundled `rules/feedback_rules.md` is used. To replace it entirely, put your own file at the `rulesFile` path (default `~/.claude/feedback-gate/feedback_rules.md`, configurable in the plugin settings; a leading `~` is expanded). If that file exists it is used instead of the bundled one (never both). Avoid `~/.claude/rules/`: Claude Code loads that directory itself, so the rules would be injected twice.

State files (changed files, attempt counters, command logs) are written under the project's `.claude/.gate-status/` directory (`gate.yaml` stays directly under `.claude/`). Add `.claude/.gate-status/` to the project's `.gitignore`. State files left by older versions directly under `.claude/` (and `.claude/hooks/logs/`) are removed automatically at session start.

While gate commands run, a band above the prompt shows what is running, one item per line, e.g.

```
[gate] 実行中:
  typecheck ✓ (0.7s)
  lint ✗ (0.2s)
  test $ bun run test (8s)
```

Finished commands stay in start order with `✓` for success or `✗` for failure and their fixed duration; a running one shows `name $ cmd` and its elapsed seconds, refreshed every second. A multi-line command is folded to its first line, and a long one is cut with ` ...` so each line stays around 80 characters. The band yields to the engine's own band while a survey is shown.

The band is shared by the agents of one session (the main agent and its subagents): their running commands are merged into one list, e.g. `  lint $ bun lint (3s)` and `  test $ bun test 待機中 (2s)` under `[gate] 実行中:`. `待機中` marks a command that is waiting for the same run in another agent (see below). The band disappears only when every agent of the session has finished; while another agent of the session is still running, its list stays. Other Claude Code sessions open on the same project (for example in another terminal) are not shown, and the one-line summary below is kept per session too.

When everything has finished, the band goes away and the result of that round is left on the one-line status line instead, as counts only, e.g. `[gate] 完了: ✓ 5 / ✗ 1 (81.0s)` (`✗` is left out when nothing failed, `✓` when nothing passed; the seconds run from the first start to the last finish, not the sum, since checks run in parallel; check names are not shown, see the Stop hook output for which one failed. The status line cannot hold line breaks or long text, so it stays short). It stays until the next gate command starts running and the band appears again. Feedback checks still use the status line while they run: `[feedback-guard] 評価中: <rule>` or `[feedback-stop-check] 検査中: <rule> (<file>)`, cleared when the hook finishes.

### Sharing runs between agents

When several agents (the main session and subagents) run the same command at the same time, the gate starts it once. A command is the same when the root, the cwd, the `cmd` and the environment passed to it (such as `CLAUDE_GATE_FILES`) all match; the variable that identifies the agent (`CLAUDE_AGENT_ID`) is ignored. The agent that comes later does not start it again: it waits for the running one and receives the same result (exit status, output, timeout). The result is then handled as if that agent had run it itself: it is recorded in its own trace and log directory, it consumes a deferred entry with the same key, and it counts for its phase result. A finished run is never reused; only overlapping runs are merged. Coordination goes through files under `.claude/.gate-status/shared/` (a lock directory per command; a lock older than the command's `timeout` is treated as dead and taken over), because the hooks of different agents are not guaranteed to run in the same process.

To opt a command out, set `share: false` on its `run` element (`{cmd, name, timeout, share}`):

```yaml
run:
  - { cmd: "bun test", name: test, share: false }
```

### Success report

When the `checks` phase (Stop / SubagentStop) actually ran at least one command and all of them passed, the gate blocks the stop once and returns a summary as the reason, e.g. `[gate] 検証がすべて通りました: lint ✓ / typecheck ✓ / test ✓。この結果をユーザーに報告して終了してください。`, so the agent can report the result and finish instead of waiting for you to say it passed. The stop right after such a report (`stop_hook_active`) runs no gate command and passes. Nothing is reported when no command ran, when `stop_hook_active` is true (a continuation after a failure block), or when it is turned off with a top-level `report_success: false` in `.claude/gate.yaml` (default: on). Failures block as before.

## Development

Requires [Bun](https://bun.sh). The hook module runs inside Claude Code, which only resolves relative imports and `claude-code`; so the source in `src/` (plus the `yaml` package) is bundled into `hooks/register.js`. `hooks/hooks.json` points at that bundle. All file and process access goes through the engine's `$` API (`$.fs`, `$.process`, `$.env`, `$.session`), wrapped by the `Io` interface in `src/io.ts`; the tests run the same code against Node's `fs` / `child_process`.

```
bun install          # install dev dependencies
bun run lint         # Biome (lint + format check); `bun run format` fixes
bun run typecheck    # tsc --noEmit
bun run test         # bun test (tests/*.spec.ts)
bun run build        # bundle src/register.ts -> hooks/register.js
bun run test:plugin  # build, then run hooks/register.test.ts on the real engine (needs the `claude` CLI)
```

The bundle `hooks/register.js` is generated and committed by CI on the pull request; contributors do not commit it (it is not in the repository until CI adds it). The "Build bundle" workflow builds it on every pull request (same-repo branches) and pushes a `chore: build bundle` commit to the branch, adding the file or updating it if it changed. Run `bun run build` to produce it locally (e.g. for `bun run test:plugin`) and leave it uncommitted. Do not edit it by hand. `scripts/build.ts` fails the build if the bundle imports anything but relative paths and `claude-code`.

Dependencies have a 7-day freeze period: `bunfig.toml` sets `minimumReleaseAge` so `bun install` only resolves versions published at least 7 days ago, and Dependabot (`.github/dependabot.yml`) waits 7 days (`cooldown`) before proposing npm or GitHub Actions updates. Actions are pinned to commit SHAs.

### Releases

Versions are managed by [release-please](https://github.com/googleapis/release-please). Write commit messages (and PR titles) as [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `chore:`, ...): on every push to `main` the "Release Please" workflow opens or updates a release PR that bumps the version in `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` and updates `CHANGELOG.md`; merging it tags the release. Both workflows use the default `GITHUB_TOKEN` (no personal access token), so commits made by the bot and the release-please PR do not trigger CI on their own. If you have required status checks, re-run them or push an empty commit by hand.
