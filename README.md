# feedback-gate

[日本語](README_ja.md)

A Claude Code plugin made of function hooks. It does three things:

- Injects your feedback rules (`~/{.claude,.agents}/feedback/*.md`) into each prompt and enforces them on tool calls and when Claude stops.
- Runs per-project quality gates (lint, tests, etc.) defined in `{.claude,.agents}/gate.yaml` after file edits and when Claude stops.
- Sends a desktop notification when Claude waits for you or stops (macOS).

## Hooks

The hooks are registered in `src/register.ts` (bundled into `hooks/register.js` by CI; that bundle is what Claude Code loads) and call the TypeScript modules under `src/`. The same checks are also run by command hooks in `hooks/hooks.json` (the Go binary `feedback-gate`, see below), for environments where an organization guard skips the mod hooks; see [Settings hooks for managed environments](#settings-hooks-for-managed-environments).

| Event | Module | Role | Settings hook |
| --- | --- | --- | --- |
| SessionStart | `src/reset-gate.ts` | Clears this session's gate state on `startup` / `clear`; keeps it on resume / compact. | Same (see below) |
| UserPromptSubmit | `src/rules-file.ts` + `src/feedback-inject.ts` | Adds the rules file (your `rulesFile` if it exists, otherwise the bundled `rules/feedback_rules.md`, or `rules/feedback_rules.en.md` when the language is English) and the confirmed feedback rules (`count >= 3`) to the context. | Same (see below) |
| PreToolUse (Bash / Edit / Write / MultiEdit) | `src/feedback-guard.ts` | Evaluates `pre_bash` / `pre_edit` enforce entries; denies, asks or warns by `count`. | Same (see below) |
| PostToolUse (Write / Edit / MultiEdit) | `src/record-changes.ts`, `src/feedback-post-edit.ts`, then `src/stop-test-gate.ts` (`rules`) | Records changed files, evaluates `post_edit` enforce entries against the edited file as a whole (blocks or warns by `count`), then runs the matching rules of `{.claude,.agents}/gate.yaml` (via `src/gate.ts`). | Same (see below) |
| PreToolUse (Bash) | `src/bash-changes.ts` (`bashStarted`), before `feedback-guard` | Notes when the command started (`bash_started.<session>--<tool_use_id>.json`): under `.claude/.gate-status/` when the project has `{.claude,.agents}/gate.yaml`; otherwise under `~/.claude/feedback/.bash_started/` (the feedback state directory, next to `.ask_state`), and only when an active feedback rule has a `post_edit` / `pre_edit` enforce entry, so a project without `gate.yaml` gets no state files in its working tree. | Same (see below) |
| PostToolUse (Bash) | `src/bash-changes.ts`, `src/feedback-bash-edit.ts`, then `src/stop-test-gate.ts` (`rules`) | Finds the files the command actually rewrote (git-modified or untracked files, and files of commits made during the command, whose mtime is at or after the command start; in the cwd's working tree and in each worktree under `.claude/worktrees/` whose path (`worktrees/<name>`) appears in the command; other worktrees are not looked at, so files another Claude Code session is editing there meanwhile are not taken for this command's changes), so writing with a heredoc, `python`, `sed -i` and the like does not skip the checks that Edit / Write get. Each of those files is checked against the `post_edit` enforce entries as a whole file, like after Edit / Write, and against the `pre_edit` entries that can be judged afterwards (see below); the results of all files are merged into one block / warn. Then, only with `{.claude,.agents}/gate.yaml`, the files are recorded and the matching rules run if something was recorded. The feedback checks work without `gate.yaml`. Git history / working-tree operations (rebase / checkout / merge etc.) are never checked nor recorded. | Same (see below) |
| PreToolUse (Agent / SendMessage), opt-in | `src/agent-launch-guard.ts` | Only when `agentLaunchGuard` is `true`: asks before sending instructions to a subagent, showing the full text. | Same (see below) |
| Notification | `src/notification.ts` (`notify`) | Desktop notification when Claude waits for you (needs `terminal-notifier`, macOS). | Same (see below) |
| Stop | `src/all-stop.ts` | Runs, in order: the gate `checks` phase (reruns the rules that failed and were not fixed, then the reserved consistency checks), `src/feedback-stop-check.ts`, then the `stop` notification. | Same (see below) |
| SubagentStop | gate `checks` phase, `src/feedback-stop-check.ts`, then `src/subagent-report.ts` (`saveSubagentReport`) | Same gate and `stop_check` rules for subagents. The result is kept so it can be handed to the calling agent (see [Results of subagents](#results-of-subagents)). | Same (see below) |
| PostToolUse (Agent) | `src/subagent-report.ts` (`subagentReport`) | Adds the gate / `stop_check` result of the subagent that just finished to the calling agent's context. | Same (see below) |

### Settings hooks for managed environments

Where an organization manages Claude Code (Team / Enterprise login, or managed settings), the built-in guard `cc-plugin-sec-default` runs first and passes every `classic.*` event over the plugins you install (`/plugin` shows "Its hooks on classic.SessionStart, ... do not run here"). None of the mod hooks above run there. A `command` hook in `hooks/hooks.json` (a settings hook) is not skipped by the guard, and it receives the same classic events with the same stdin JSON and the same return conventions (exit 2 blocks, `permissionDecision`, `decision: block`, `additionalContext`). So `hooks/hooks.json` registers a command hook for each of SessionStart, UserPromptSubmit, PreToolUse (`Bash|Edit|Write|MultiEdit|Agent|SendMessage`), PostToolUse (`Bash|Edit|Write|MultiEdit|Agent|Task`), Notification, Stop and SubagentStop, and every row of the table above behaves the same through it.

- **How it runs.** Each hook is `bash "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" <Event>`, which runs `feedback-gate claude <Event>`: a single Go binary (`cmd/feedback-gate`; the checks are in `internal/hookgate`) published on this repository's GitHub Releases. It reads the classic JSON from stdin, runs the same checks as the mod hooks, and prints the result the way a classic command hook does. PostToolUse, Stop and SubagentStop have a 600 s `timeout`, since a gate command can take long.
- **Where the binary comes from.** `scripts/hook.sh` looks for it in this order: `FEEDBACK_GATE_BIN` (a path to an executable; for development and tests, and a way to skip the download); then `${FEEDBACK_GATE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/feedback-gate}/<version>/feedback-gate`, where `<version>` is the `version` in `.claude-plugin/plugin.json`; otherwise it downloads `https://github.com/nonchan7720/claude-hook-gate/releases/download/v<version>/feedback-gate_<os>_<arch>.tar.gz` (`os`: `linux` / `darwin`, `arch`: `amd64` / `arm64`) together with `checksums.txt`, verifies the SHA-256 (`sha256sum` or `shasum`; without either it installs nothing, since it cannot verify), unpacks it and moves the binary into the cache atomically. `FEEDBACK_GATE_RELEASE_BASE_URL` replaces the `https://github.com/nonchan7720/claude-hook-gate/releases/download` part (a `file://` directory works too, which is what the tests use; it needs `curl`, since `wget` cannot read `file://`). So the binary always matches the installed plugin version. Several plugin versions can share the cache (for example the Claude Code plugin and the Codex plugin at different versions): a version directory is touched whenever its binary is used, and after a fresh install only the other version directories not used for more than 30 days are removed (and download work directories older than 60 minutes, left by a hook that was killed).
- **First run.** The first hook after an install or an update (SessionStart) downloads the binary (a few MB) within that hook's timeout, once per version. To avoid that, point `FEEDBACK_GATE_BIN` at a prebuilt binary.
- **Needs `curl` or `wget` on the first run.** If the binary is not cached yet and the download is impossible (neither `curl` nor `wget`, neither `sha256sum` nor `shasum`, no network, a checksum mismatch, an unsupported OS or CPU), the command hook does nothing (exit 0) and writes one line to stderr, `feedback-gate: could not install the feedback-gate v<version> binary (<reason>); the hook did nothing`, where `<reason>` is one of `no-download-tool`, `no-sha256-tool`, `download-failed`, `checksum-mismatch`, `unsupported-platform`, `bad-version`, `extract-failed`, `cache-unwritable`, `no-cache-dir`. Only the mod hooks work then, which means nothing runs where the guard skips them. Once the binary is cached, nothing else is needed.
- **No double runs.** Every `classic.*` mod hook writes a marker file `~/{.claude,.agents}/feedback/.classic_seen/<session>` (`CLAUDE_FEEDBACK_DIR` is respected; `classic.Notification` rewrites it each time, and anything older than 24h is swept). `scripts/hook.sh` exits 0 when the marker of the session exists, so where the mod hooks run, the command hooks stay silent. Where the guard skips them, no marker is written and the command hooks do the work. (The mod hook and the command hook of one event start at the same time, so the first event of a session, SessionStart, can run both; its reset is idempotent, and from then on the marker is there.)
- **Plugin settings.** `language`, `agentLaunchGuard`, `autoCount` and `rulesFile` reach the command hook as the environment variables `CLAUDE_PLUGIN_OPTION_language`, `CLAUDE_PLUGIN_OPTION_agentLaunchGuard` (`true` / `false`), `CLAUDE_PLUGIN_OPTION_autoCount` and `CLAUDE_PLUGIN_OPTION_rulesFile`, and `feedback-gate` reads them.
- **Differences.** The status line while a check is evaluated (`$.ui.status`) is a feature of the mod and is not shown by the command hook. The band above the prompt (running gate commands) is drawn by the mod's `ui.render` from the same files under `.claude/.gate-status/running/`, which the command hook writes as usual; it is redrawn when the mod next renders.

### Files written by Bash

A Bash command cannot be checked by `pre_edit` before it runs, since what it will write is unknown until then. After the command, `src/feedback-bash-edit.ts` evaluates the `pre_edit` entries on each file it rewrote with the same conditions: `path` / `exclude_path`, `absent_sibling` / `absent_glob` (the test file must exist once the command is done, so writing the test in the same command is fine), and `when` / `unless` against the content the command wrote: for a file git tracks, the lines added relative to `HEAD` (or, when the command committed them, the lines added by the commits made since it started); for an untracked file (a new file, or a file outside git), the whole content, as with the `content` of Write. As the file is already written, `deny` / `ask` become a PostToolUse `block` (Claude is told to fix the file), and the message says the rule was only caught after the command. An `ask` already raised for the same rule and file in this session is downgraded to `warn`, as with Edit. Warnings and blocks carry the file path. The checks only see files git can list (tracked, or untracked and not ignored); files written outside a git working tree, or ignored by `.gitignore`, are not checked.

### Results of subagents

<a id="results-of-subagents"></a>The gate and `stop_check` results of a subagent's SubagentStop only reach the subagent itself (a block reason) or you (a `systemMessage`); the calling agent sees only the subagent's final message, and had to read the gate logs to know whether the checks passed. So on every SubagentStop the result of that round is kept in `.claude/.gate-status/subagent_report.<session>--<agent>.json` in the project, next to the other state files (without `gate.yaml`, only when `stop_check` found something), and on the calling agent's PostToolUse for `Agent` the file of the `agentId` in the tool result is added to its context and removed, e.g.

```
[feedback-gate] Results of the hooks run when subagent code-implementer (a1b2c3) stopped (gate checks and feedback stop_check). Use these instead of reading the gate logs or re-running the checks:
[gate] All checks passed: lint ✓ / typecheck ✓ / test ✓
```

What is handed over is the result of the last SubagentStop (the one that let the subagent stop): `[gate] All checks passed: ...`, the `checks` phase summary, or the give-up message with the failures after `MAX_ATTEMPTS`; and the `stop_check` warnings (or its give-up). The stop right after a success report runs no gate command, so it keeps the `All checks passed` of the round before. When nothing ran and nothing was found, nothing is added. A subagent started in the background finishes after its PostToolUse, so its result is not handed over; like the other state files, such files are removed by `reset-gate` at session start (`startup` / `clear`, or after 24 hours).

### Agent launch guard (optional)

`src/agent-launch-guard.ts` is active only when the `agentLaunchGuard` option (`userConfig`) is `true`. It is `false` by default. When enabled, it runs on PreToolUse for `Agent` and `SendMessage` and returns `ask`, putting the full text that would be sent into the confirmation reason so you can review it before the subagent receives it:

- `Agent`: asks when `subagent_type` is `code-implementer`, showing the `prompt`.
- `SendMessage`: asks for every recipient except `git-operator`, showing the `message`.

Anything else passes through to the normal permission flow. The default agent types and allowed recipients are the `ASK_AGENT_TYPES` and `ALLOW_RECIPIENTS` arrays at the top of `src/agent-launch-guard.ts` (`AskAgentTypes` / `AllowRecipients` in `internal/hookgate/agent_launch_guard.go`). For the command hooks (the `feedback-gate` binary) you can replace them with the environment variables `FEEDBACK_GATE_ASK_AGENT_TYPES` (the `subagent_type`s to ask about) and `FEEDBACK_GATE_ALLOW_RECIPIENTS` (the recipients that need no confirmation), each a list separated by `,` or `;` (spaces around the names are ignored; an unset or empty variable keeps the default), e.g. `FEEDBACK_GATE_ASK_AGENT_TYPES='code-implementer;worker'`.

To enable it, turn on `agentLaunchGuard` on the settings screen shown when you install the plugin with `/plugin`, or change it later in the `/config` menu (the plugin's `agentLaunchGuard` row).

### Automatic count increase

When a hook (`pre_bash` / `pre_edit` on PreToolUse, `post_edit` on PostToolUse, `stop_check` on Stop / SubagentStop) detects a feedback rule violation, it raises that rule's `count` by 1 at the same time it writes the violation log. Repeating the same violation escalates enforcement from warn to ask / block to deny, instead of the rule staying at `count: 1` forever. Violations found when PostToolUse(Bash) checks files written by Bash (heredoc, `python`, `sed -i`, ...; `post_edit` and the after-the-command `pre_edit` described in "Files written by Bash" above) count too, the same as for Edit / Write.

- Only the `count: N` line inside the frontmatter of the rule file actually used is rewritten (when the global and project directories both have a rule with that name, the project one). The line must be a plain number; a rule without a numeric `count` line is left alone. The new text is written to a temporary file in the same directory and moved into place with `mv`.
- Increases are limited per session and rule name: within one session a rule is raised at most once, however often it is violated (multiple matching `enforce` entries, repeated Stop blocks). A violation in a later session raises it again. The rules already raised are recorded in `~/.claude/feedback/.count_state/<session_id>.json`; calls without a `session_id` never raise a count.
- The cap is `5` (the count that means deny when no `severity` is given); counts at or above it are not raised.
- The current decision still uses the count from before the increase; the new enforcement applies from the next violation. When a count is raised, a line saying `count` went from N to N+1 is added to the deny / ask / block reason (or to stderr for warn), so the model sees it too.
- A failed write never stops the hook.

To turn it off, set `autoCount` in `userConfig` to `false` (default `true`; on the settings screen shown by `/plugin` at install time, or later in `/config`).

### Language of the messages

Everything the hooks print (the feedback rules injected into the context, the block / warn reasons, the gate results, the band and the status line, the desktop notifications, the `/correct` report and the bundled rules file) is available in English and Japanese. The `language` option (`userConfig`, set on the `/plugin` install screen or later in `/config`) chooses it:

- `auto` (default): follow the OS language. The hooks read `FEEDBACK_GATE_LANG` (a plugin-specific override, `ja` or `en`), then `LC_ALL`, `LC_MESSAGES` and `LANG`, and use the first one that has a value: Japanese when it starts with `ja` (e.g. `ja_JP.UTF-8`), English for anything else (`en_US.UTF-8`, `C`, `POSIX`, ...). When none of them is set, English.
- `ja` / `en`: always that language, whatever the environment.

The texts live in `locales/ja.yaml` and `locales/en.yaml` (one key per message, `{{name}}` for the values filled in at runtime; both files must have the same keys, which a test checks) and are looked up with [i18next](https://www.i18next.com/); the language resolution is in `src/i18n.ts`. To change a wording, edit the YAML. The examples below show the English texts; with Japanese you get the Japanese ones (e.g. `[gate] 実行中:` for `[gate] running:` and `[gate] 完了:` for `[gate] done:`). Your own `rulesFile` and the `message` of your feedback rules are shown as you wrote them, in any language.

```mermaid
flowchart LR
  P[UserPromptSubmit] --> I[feedback-inject]
  T[PreToolUse: Bash / Edit / Write / MultiEdit] --> G[feedback-guard]
  T2["PreToolUse: Agent / SendMessage<br/>(agentLaunchGuard = true)"] --> AL[agent-launch-guard]
  E[PostToolUse: Edit / Write / MultiEdit] --> R[record-changes]
  R --> PE[feedback-post-edit]
  PE --> S[stop-test-gate: rules]
  EB[PostToolUse: Bash] --> BC[bash-changes]
  BC --> BE["feedback-bash-edit<br/>(post_edit + pre_edit)"]
  BE --> S
  S --> SG[gate]
  X[Stop] --> A[all-stop]
  A --> C[stop-test-gate: checks]
  A --> F[feedback-stop-check]
  C --> SG
```

## Commands

### `/correct`

Fixes a repeated mistake at the layer that works best. It aggregates the feedback rules (`~/{.claude,.agents}/feedback/*.md` and `<project>/{.claude,.agents}/feedback/*.md`) and the violation log (`~/.claude/feedback/.violations.jsonl`), then proposes how to tighten them. The command is registered on `session.start` by `src/register.ts`; the logic is in `src/correct.ts`.

```
/correct [--window 30d] [--min 2] [apply]
```

- `--window`: how far back to count violations, `Nd` or `Nh` (default `30d`).
- `--min`: the minimum number of violations in the window before a proposal is made (default `2`).
- `apply`: write the `bump` proposals to the rule files (see below). Without it nothing is changed.

Unknown arguments are ignored. There are five kinds of proposals, listed in this order:

| Kind | When | Proposal |
| --- | --- | --- |
| `broken` | A rule file cannot be read, or an `enforce` entry in it is invalid (see [Broken rules](#broken-rules)). The rule name is the file name without `.md`. | Fix the file; the reason is shown. |
| `bump` | An active rule has at least `--min` violations in the window. | `count` 1-2: raise to 3 (confirmed rule). `count` 3-4 with at least `--min` `ask` / `block` violations in the window: raise to 5 (`deny`). `count` >= 5 is never proposed. |
| `enforce` | An active rule has `count >= 3` but no `enforce`, so no hook can detect it (and the violation log never sees it). | Add `enforce` entries; a template for the four events is shown. |
| `stale` | An active rule has `count >= 3` and `enforce`, but has never appeared in the violation log. | Check that the `enforce` works and the rule is not out of date. |
| `expired` | A rule file is inactive because of `expires`, `projects` or `when_exists`. | Delete or update it. |

`apply` rewrites only the `count:` line inside the frontmatter of the `bump` rules, and lists the changed files. Nothing else in the files is touched. `enforce` (and `stale` / `expired`) are proposals only: Claude is told to show them to you and to ask before editing any file.

With the automatic increase (`autoCount`) on, `count` goes up by 1 per session in which the rule is violated. A `bump` proposal instead jumps to 3 or 5 based on the violations in the window; it always starts from the current `count`, and `apply` only rewrites a file whose `count` still matches the proposal, so the two never add up twice.

## Install

```
/plugin marketplace add nonchan7720/claude-hook-gate
/plugin install feedback-gate@claude-hook-gate
```

The first command adds this repository as the `claude-hook-gate` marketplace; the second installs the `feedback-gate` plugin from it. Then choose the scope.

### Codex

The same hooks are also packaged as a [Codex](https://developers.openai.com/codex) plugin in [`plugins/codex/`](plugins/codex/README.md) (catalog: `.agents/plugins/marketplace.json`). It reads the same feedback rules and the same `gate.yaml` (looking in `.agents/` first, then `.claude/`), so a project used with both tools is checked the same way:

```
codex plugin marketplace add nonchan7720/claude-hook-gate
```

then install `feedback-gate` from `/plugins` and trust its hooks in `/hooks`. The plugin root is this repository (the Codex manifests `.codex-plugin/plugin.json` and `plugin.json` at the root point at `plugins/codex/hooks/hooks.json`), so `rules/`, `scripts/dogwood/` and `scripts/install-binary.sh` (the binary downloader) are shared, not copied. The checking logic is shared; what differs between the two hosts (Codex edits files with `apply_patch`, has `PermissionRequest` instead of `Notification`, and no `ask`) is isolated behind the `Host` interface of the Go binary (`Host` in `internal/hookgate/host.go`, implemented by `host_claude.go` and `host_codex.go` for `feedback-gate claude` / `feedback-gate codex`; `apply_patch.go` splits the patch). The TypeScript mod (`src/register.ts`) is Claude Code only and is unchanged. See the [plugin README](plugins/codex/README.md) for the differences and the environment variables that replace the plugin settings.

## Requirements

Nothing to install for the mod hooks: they are plain TypeScript, bundled into one JavaScript file that Claude Code runs itself (no Python, bash or jq).

- `curl` or `wget` and `bash` (optional): needed only by the settings hooks (`hooks/hooks.json`), once per plugin version, to download the `feedback-gate` binary (`tar` and `sha256sum` / `shasum` are required as well: without a hash tool nothing is installed). Without them, and while the binary is not cached, the settings hooks do nothing. `jq` is not required (used if present).

- `terminal-notifier` (optional, macOS): needed only for the desktop notifications.
- `dogwood` (optional; an AWS tool, source at <https://github.com/dogwood-policy/dogwood>). Build and install it with `cargo install --git https://github.com/dogwood-policy/dogwood amzn-dogwood-cli` (crate `amzn-dogwood-cli`, binary `dogwood`). The gate uses it to decide whether each `{.claude,.agents}/gate.yaml` command runs now or is deferred. It is looked up in `DOGWOOD_BIN`, `PATH`, `~/.cargo/bin/dogwood` and `~/.local/share/mise/shims/dogwood`, in that order. When it is not found, commands under the bundled default policy run every time, while commands under a `policy:` you set are skipped and deferred.

## What it reads

- `{.claude,.agents}/gate.yaml` in the project (opt-in: without it, the gate does nothing). The format is described by `scripts/gate.schema.json`; the default policy is in `scripts/dogwood/`.
- `~/{.claude,.agents}/feedback/*.md`: feedback rules with frontmatter (`name`, `description`, `type`, `count`, optional `enforce`, `expires`, `projects`, `when_exists`). Rules with `count >= 3` are injected and enforced. `expires` (`YYYY-MM-DD`, valid through the end of that day in UTC, or an ISO 8601 datetime) turns a rule off after that point; `projects` (a string or list of globs matched against the project directory's absolute path, a leading `~` expands to `HOME`) limits it to matching projects; `when_exists` (a string or list of globs relative to the project root) limits it to projects where at least one exists. A rule is active only when all three that are set are satisfied; an unparsable `expires` is ignored. These filters apply only to the merged global + project lookup, and an expired project rule also hides the global rule of the same name. Override the directory with `CLAUDE_FEEDBACK_DIR`. The project's `.claude/feedback/*.md` is read as well; when a project rule has the same `name` as a global one, the project rule takes precedence.
- <a id="broken-rules"></a>Broken rules: one broken rule file never turns off the other rules. A file whose frontmatter is not valid YAML is skipped on its own. An `enforce` that is not a list (for example a forgotten `- `) is treated as empty, and an `enforce` entry that is not a mapping (`- ` with nothing after it), or whose `when` / `unless` is not a usable regular expression, is dropped on its own; the rest of the rule still works. An entry that throws while being evaluated is skipped the same way. Regular expressions are written in Python's `re` syntax and run as JavaScript: a leading `(?i)` / `(?s)` / `(?m)`, `(?P<name>...)`, `(?P=name)`, and `\A` / `\Z` / `\z` (start / end of the whole text, also under the multiline flag used by `pre_edit` / `post_edit`) are translated; a leading `(?x)` and anything JavaScript rejects (an inline flag in the middle such as `x(?i)y`, `a*+`, `(?#...)`, `(?P>name)`) make that entry invalid. Each broken file or entry is recorded once, with the file and the reason, in `~/.claude/feedback/.errors.jsonl` (next to `.violations.jsonl`), and is listed at the top of the context injected on every prompt (`The following rule files could not be read and are disabled: ...`) until it is fixed; `/correct` reports it as a `broken` proposal. Internal errors that the feedback hooks swallow so as not to stop your work are recorded in the same file.
- The rules file, added to the context on every prompt. By default the bundled `rules/feedback_rules.md` (Japanese) or `rules/feedback_rules.en.md` (English) is used, by the language above. To replace it entirely, put your own file at the `rulesFile` path (default `~/.claude/feedback-gate/feedback_rules.md`, configurable in the plugin settings; a leading `~` is expanded). If that file exists it is used instead of the bundled one (never both, whatever the language). Avoid `~/.claude/rules/`: Claude Code loads that directory itself, so the rules would be injected twice.

The configuration directory is `.claude` or `.agents`: each file above is looked up in both, `.claude` first under Claude Code and `.agents` first under Codex. State files (changed files, attempt counters, command logs) are written under `.gate-status/` in the first of the two that exists (`.claude/` when neither does; `gate.yaml` stays directly under it). Symlinking one to the other is fine: a rule found through both paths is read once, and the state has one home. Add `.gate-status/` to the project's `.gitignore`. State files left by older versions directly under `.claude/` (and `.claude/hooks/logs/`) are removed automatically at session start. `bash_started.*.json` there (or under `~/.claude/feedback/.bash_started/` in a project without `gate.yaml`) holds the start time of the Bash command in flight, used to tell which files that command rewrote. It is keyed by the `tool_use_id` of the call, which both PreToolUse and PostToolUse carry, not by the session / agent id: the engine does not pass the agent id to `classic.PreToolUse`, while `classic.PostToolUse` has `agent_id`, so a key based on them would not match inside a subagent. Files left by commands that failed (no PostToolUse) are removed at the next Bash start once they are older than 2 hours.

While gate commands run, a band above the prompt shows what is running, one item per line, e.g.

```
[gate] running:
  typecheck ✓ (0.7s)
  lint ✗ (0.2s)
  test $ bun run test (8s)
```

Finished commands stay in start order with `✓` for success or `✗` for failure and their fixed duration; a running one shows `name $ cmd` and its elapsed seconds, refreshed every second. A multi-line command is folded to its first line, and a long one is cut with ` ...` so each line stays around 80 characters. The band yields to the engine's own band while a survey is shown.

The band is shared by the agents of one session (the main agent and its subagents): their running commands are merged into one list, e.g. `  lint $ bun lint (3s)` and `  test $ bun test waiting (2s)` under `[gate] running:`. `waiting` marks a command that is waiting for the same run in another agent (see below). The band disappears only when every agent of the session has finished; while another agent of the session is still running, its list stays. Other Claude Code sessions open on the same project (for example in another terminal) are not shown, and the one-line summary below is kept per session too.

When everything has finished, the band goes away and the result of that round is left on the one-line status line instead, as counts only, e.g. `[gate] done: ✓ 5 / ✗ 1 (81.0s)` (`✗` is left out when nothing failed, `✓` when nothing passed; the seconds run from the first start to the last finish, not the sum, since checks run in parallel; check names are not shown, see the Stop hook output for which one failed. The status line cannot hold line breaks or long text, so it stays short). It stays until the next gate command starts running and the band appears again. Feedback checks still use the status line while they run: `[feedback-guard] evaluating: <rule>` or `[feedback-stop-check] checking: <rule> (<file>)`, cleared when the hook finishes.

### Sharing runs between agents

When several agents (the main session and subagents) run the same command at the same time, the gate starts it once. A command is the same when the root, the cwd, the `cmd` and the environment passed to it all match; the variable that identifies the agent (`CLAUDE_AGENT_ID`) and the list of target files (`CLAUDE_GATE_FILES`) are ignored. The file list is handled separately because it can differ per agent. The agent that comes later looks at the runs in progress under the same conditions: if one of them targets every file of its own list (an empty list is contained in any), it does not start the command again but waits for that run and receives the same result (exit status, output, timeout). The result is then handled as if that agent had run it itself: it is recorded in its own trace and log directory, it consumes a deferred entry with the same key, and it counts for its phase result. A finished run is never reused; only overlapping runs are merged. Coordination goes through files under `.claude/.gate-status/shared/` (a lock directory per command and file list), because the hooks of different agents are not guaranteed to run in the same process.

When there is no run it can receive (its files are not covered, or the environment, root or cwd differ), the same command still runs only once at a time. The unit is the `name` (or the `cmd` when there is no name): while it is running in another agent, the gate does not start it but waits for that run to end, then looks again for a run to receive or runs it itself (the band shows it as waiting meanwhile). Running a heavy command such as `go test ./...` once per agent at the same time makes every run several times slower as they fight over the CPU. Different commands given the same `name` also run one at a time. This also holds between agents working in different git worktrees of the same repository: the locks live in `~/.claude/.gate-status/shared/<project_id>/`, where the project id is derived from the repository's common git directory (results are still received only within the same worktree, since the root and cwd differ). Whether a lock is alive is decided by the command's process: if the hook is stopped (for example with ESC) and leaves its lock behind, the next agent takes it over as soon as the command has exited, and waits for the command while it is still running. A lock is also treated as dead once the command's `timeout` has passed. A command with `share: false` is neither shared nor serialized; it always starts at once.

To opt a command out of sharing (and serializing), set `share: false` on its `run` element (`{cmd, name, timeout, share, files}`):

```yaml
run:
  - { cmd: "bun test", name: test, share: false }
```

A command that does not use the target files (such as `go test ./...`, which runs everything regardless of the list) can set `files: false`. Its file list is then treated as empty when deciding whether to share, so it is shared even when the agents changed different files. `CLAUDE_GATE_FILES` is still passed to the command as before. When combined with `share: false`, `share: false` wins and nothing is shared.

```yaml
run:
  - cmd: go test ./...
    name: test
    files: false
```

### Failures left unfixed

A failed rule in the `rules` phase (PostToolUse) does not stop the turn: the errors go back to Claude as feedback. The failed files are also kept in `.claude/.gate-status/gate_failed.<state>.txt`, and the next `checks` phase (Stop / SubagentStop) reruns their rules on the current contents before anything else. If a rule still fails, the stop is blocked like a failed consistency check (and no success report is given); once it passes, the file is handled as if the `rules` phase had passed. So a lint failure cannot be left behind by simply finishing the turn. After `MAX_ATTEMPTS` (5) blocked stops in a row, the gate gives up: the failures are dropped (the files stay in the changed list, so the next edit checks them again).

### Success report

When the `checks` phase (Stop / SubagentStop) actually ran at least one command and all of them passed, the gate blocks the stop once and returns a summary as the reason, e.g. `[gate] All checks passed: lint ✓ / typecheck ✓ / test ✓. Report this result to the user and finish.`, so the agent can report the result and finish instead of waiting for you to say it passed. The stop right after such a report (`stop_hook_active`) runs no gate command and passes. Nothing is reported when no command ran, when `stop_hook_active` is true (a continuation after a failure block), or when it is turned off with a top-level `report_success: false` in `{.claude,.agents}/gate.yaml` (default: on). Failures block as before.

## Security and permissions

What the plugin reads, runs, writes and decides, for reviewers and for anyone installing it.

- **Network**: the plugin's own code sends nothing over the network; it has no HTTP client. Data can leave your machine only through the programs it starts on your behalf (below): the commands you write in `{.claude,.agents}/gate.yaml` and in the `check` of your feedback rules, which run as you, and the macOS desktop notification.
- **Credentials**: it reads no tokens, keys or passwords, and needs none. The only environment variables it reads are `CLAUDE_FEEDBACK_DIR`, `DOGWOOD_BIN`, `FEEDBACK_GATE_LANG`, `HOME`, `LANG`, `LC_ALL`, `LC_MESSAGES`, `PATH`, `TERM_PROGRAM` and `__CFBundleIdentifier` (to find files, programs and the message language). Commands you put in `gate.yaml` or a rule's `check` run with your environment, like any command you run yourself.
- **What it reads from the conversation**: the tool input of Bash / Edit / Write / MultiEdit calls (the command, the file path and the new text), to check them against your feedback rules and to know which files changed; the prompt and message of `Agent` / `SendMessage` calls, only when `agentLaunchGuard` is on, to show them in the confirmation; and the text of the Notification event, to put it in the desktop notification. It does not read the transcript.
- **What it reads from disk**: your feedback rules (`~/{.claude,.agents}/feedback/*.md`, `<project>/{.claude,.agents}/feedback/*.md`), the rules file, `{.claude,.agents}/gate.yaml`, its own state files (below), the files Claude edited, and git's view of the working tree.
- **Programs it starts**:
  - `sh -c` with the commands in `{.claude,.agents}/gate.yaml` and the `check` of your feedback rules (written by you; the plugin does not ship any).
  - `git` (`rev-parse`, `ls-files`, `diff`, `log`; read-only) to find the repository root and the files a Bash command changed.
  - `sh`, `mkdir`, `mv`, `rm`, `rmdir`, `kill -0`, `sleep` for its own state files and locks under the directories listed below.
  - `dogwood` (optional) to decide whether a gate command runs now.
  - On macOS, for notifications: `osascript` (reads the name of the front window, so it does not notify about the project you are looking at) and `terminal-notifier` (shows the notification; clicking it runs `open -b <terminal app>` or `code -r <project>` to bring the window forward).
- **Files it writes**:
  - `<project>/{.claude,.agents}/.gate-status/`: gate state, command logs and locks (only when the project has `{.claude,.agents}/gate.yaml`).
  - `~/{.claude,.agents}/feedback/`: `.violations.jsonl`, `.errors.jsonl`, `.count_state/`, `.ask_state/`, `.bash_started/`, `.classic_seen/` (one empty marker per session; written by the mod's `classic.*` hooks, read by `scripts/hook.sh`).
  - The `count:` line in the frontmatter of your feedback rule files, which are instructions Claude follows: rewritten when a rule is violated with `autoCount` on (turn it off in the plugin settings), and by `/correct apply`. Nothing else in those files is changed.
  - It does not write settings, `CLAUDE.md`, build or start-up files, or hook configuration.
- **Permission decisions** (PreToolUse): the hook only ever returns `deny` or `ask`, never `allow`, so it can make a call stricter but never skip your own permission check. It decides for Bash / Edit / Write / MultiEdit when one of your feedback rules matches (`deny` or `ask` by the rule's `count` / `severity`), and for `Agent` / `SendMessage` only when `agentLaunchGuard` is on (`ask`, showing the full text). In every other case it passes the event on unchanged. It never changes the permission mode, settings, agents or Remote Control.
- **Context it adds**: on UserPromptSubmit it adds the rules file and your confirmed feedback rules (`count >= 3`) to the context. PostToolUse, Stop and SubagentStop give Claude the gate results and rule violations (as feedback or a block reason); PostToolUse(Agent) adds a finished subagent's results to the caller's context.
- **Settings hooks**: `hooks/hooks.json` registers a `command` hook for each event, which runs `scripts/hook.sh` and then `feedback-gate claude <Event>` (the Go binary) with the event's JSON on stdin. It runs the same checks as the mod hooks and returns the same things (deny / ask, block, added context), so the points above apply to it too. It exits without doing anything when the mod's marker for the session exists, or when the binary is neither cached nor downloadable. It reads the plugin settings from the `CLAUDE_PLUGIN_OPTION_*` environment variables.
- **Commands**: it registers `/correct` at session start, and its `command.run` hook answers only that command.
- **Bundled files**: `hooks/register.js` is built from `src/` by `scripts/build.ts` and is not minified. `hooks/vendor/yaml.js` and `hooks/vendor/i18next.js` are the npm packages [`yaml`](https://www.npmjs.com/package/yaml) and [`i18next`](https://www.npmjs.com/package/i18next) at the versions pinned in `package.json` / `bun.lock`, minified only to keep each file small. The getters, `Object.defineProperty` and promise checks (`typeof x.then === "function"`) that a scan reports are in these two libraries (yaml's document classes, i18next's async loading). The plugin's own code uses no `Proxy`, `eval` or `new Function`.

## Development

Requires [Bun](https://bun.sh) and [Go](https://go.dev) (1.27 or newer). With [mise](https://mise.jdx.dev/), `mise install` sets up everything `mise.toml` lists (bun, node, go, golangci-lint, goreleaser) and `mise run lint|fmt|test|build` are the entry points (see below). The hook module runs inside Claude Code, which only resolves relative imports and `claude-code`; so the source in `src/` (plus the `yaml` and `i18next` packages, and the `locales/*.yaml` message files, imported as text) is bundled into `hooks/register.js`, with `yaml` and `i18next` split out, minified, into `hooks/vendor/*.js` that the bundle imports by relative path. This keeps every file well under the 256 KiB per-file limit of the Claude plugin directory, while the plugin's own code stays readable. `hooks/hooks.json` points at the bundle. All file and process access goes through the engine's `$` API (`$.fs`, `$.process`, `$.env`, `$.session`), wrapped by the `Io` interface in `src/io.ts`; the tests run the same code against Node's `fs` / `child_process`.

The code is layered so that the checks do not depend on the host that runs them: the core takes the classic command-hook JSON as its input and returns an `Outcome`; the mod (`src/register.ts`) and the command-hook CLI call it. The command-hook CLI is the Go binary `feedback-gate` (`cmd/feedback-gate`, one `feedback-gate claude <Event>` / `feedback-gate codex <Event>` / `feedback-gate version` command; the checks live in `internal/hookgate`, one Go file per module of `src/`, and the message files in `locales/` are embedded): a `Host` (`options` from the environment, `normalize` host JSON → core event and payloads, `render` core `Outcome` → host output) is what differs between Claude Code and Codex. A tool that edits several files at once (Codex's `apply_patch`) is normalized to one payload per file; the core offers `preToolUseEdits` / `postToolUseEdits` for that.

```
mise install         # install the toolchain of mise.toml (bun, node, go, golangci-lint, goreleaser)
bun install          # install dev dependencies
mise run build       # go build -o bin/feedback-gate ./cmd/feedback-gate
mise run lint        # golangci-lint run ./... && bun run lint
mise run fmt         # golangci-lint fmt ./... && bun run format
mise run test        # go test ./... && bun run test

go test ./...        # Go unit tests (internal/hookgate, ports of the tests/*.spec.ts files)
bun run lint         # Biome (lint + format check); `bun run format` fixes
bun run typecheck    # tsc --noEmit
bun run test         # bun test (tests/*.spec.ts)
bun run build        # bundle src/register.ts -> hooks/register.js (+ hooks/vendor/*.js)
bun run test:plugin  # build, then run hooks/register.test.ts on the real engine
bun run validate:plugin  # claude plugin validate . --strict
```

The TypeScript integration tests (`tests/cli.spec.ts`, `tests/codex-cli.spec.ts`) spawn the Go binary as a child process and check its stdin / stdout / stderr / exit code; `tests/hook-script.spec.ts` and `tests/codex-hook-script.spec.ts` test `scripts/hook.sh` with a fake binary and a fake release directory (`FEEDBACK_GATE_RELEASE_BASE_URL=file://...`). The binary is `FEEDBACK_GATE_BIN` when set (CI builds it once), otherwise the tests run `go build` into `node_modules/.cache/feedback-gate/feedback-gate`.

The bundle (`hooks/register.js` and `hooks/vendor/`) is generated and committed by CI on the pull request; contributors do not commit it (it is not in the repository until CI adds it). The "Build bundle" workflow builds it on every pull request (same-repo branches) and pushes a `chore: build bundle` commit to the branch, adding the file or updating it if it changed. Run `bun run build` to produce it locally (e.g. for `bun run test:plugin`) and leave it uncommitted. Do not edit it by hand. `scripts/build.ts` fails the build if the bundle imports anything but relative paths and `claude-code`, or if any output file is 200 KiB or larger. It also writes invisible characters in the output as `\uXXXX` escapes, and fails if a parameter name of the `classic.PreToolUse` hook appears anywhere else in `hooks/register.js` (the plugin directory refuses a permission hook whose `next` it cannot trace). The CI workflow then runs `claude plugin validate . --strict` and `claude plugin test .` on the built bundle, using the Claude Code CLI from `devDependencies` (`@anthropic-ai/claude-code`, pinned by `bun.lock` and updated by Dependabot).

Dependencies have a 7-day freeze period: `bunfig.toml` sets `minimumReleaseAge` so `bun install` only resolves versions published at least 7 days ago, and Dependabot (`.github/dependabot.yml`) waits 7 days (`cooldown`) before proposing npm or GitHub Actions updates. Actions are pinned to commit SHAs.

### Releases

Versions are managed by [release-please](https://github.com/googleapis/release-please). Write commit messages (and PR titles) as [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `chore:`, ...): on every push to `main` the "Release Please" workflow opens or updates a release PR that bumps the version in `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json` and `plugin.json` and updates `CHANGELOG.md`; merging it tags the release (`vX.Y.Z`) and creates the GitHub release. The same workflow then runs [GoReleaser](https://goreleaser.com/) (`.goreleaser.yaml`) on the tag, which builds `feedback-gate` for linux / darwin / windows × amd64 / arm64 and attaches `feedback-gate_<os>_<arch>.tar.gz` (`.zip` for windows) and `checksums.txt` to that release (`release.mode: keep-existing`, since release-please owns the release notes). `scripts/hook.sh` downloads exactly those files for the plugin version, so a plugin version is usable only after its release has the binaries. The release-please job only builds them for releases it creates, so the version `plugin.json` already carries when the Go port is merged (`v0.9.0`) has none yet: after merging the Go port, run the "Release Please" workflow once by hand (Actions → Release Please → Run workflow, from `main`, with `tag` = `v0.9.0`, or `gh workflow run release-please.yml -f tag=v0.9.0`). That `workflow_dispatch` run skips release-please, builds the HEAD of the branch it was started from (the old tag has no Go code) with GoReleaser as that tag, and attaches the binaries to the existing release, so existing installs get a binary. The same can be used to re-attach binaries to any release. Both workflows use the default `GITHUB_TOKEN` (no personal access token), so commits made by the bot and the release-please PR do not trigger CI on their own. If you have required status checks, re-run them or push an empty commit by hand.
