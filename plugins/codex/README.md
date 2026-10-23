# feedback-gate for Codex

[日本語](README_ja.md)

The [feedback-gate](../../README.md) hooks as a [Codex](https://developers.openai.com/codex) plugin. Same three things as the Claude Code plugin, with the same rule files and the same `gate.yaml`, so a project you work on with both tools is checked the same way:

- Injects your feedback rules (`~/{.claude,.agents}/feedback/*.md`, `<project>/{.claude,.agents}/feedback/*.md`) into each prompt and enforces them on tool calls and when Codex stops.
- Runs the per-project quality gates of `{.claude,.agents}/gate.yaml` after file edits and when Codex stops.
- Sends a desktop notification when Codex waits for your approval or stops (macOS, `terminal-notifier`).

Codex looks in `.agents/` first, then `.claude/` (Claude Code the other way round); state files go under `.gate-status/` in the first of the two that exists. Symlinking one directory to the other is fine. See [What it reads](../../README.md#what-it-reads).

## Install

```
codex plugin marketplace add nonchan7720/claude-hook-gate
```

This registers the repository as the `hook-gate` marketplace (`.agents/plugins/marketplace.json`). Install `feedback-gate` from `/plugins`, then trust its hooks when Codex reports "Hooks need review" (`/hooks`); plugin hooks do not run until trusted.

The plugin root is the repository itself: the Codex manifests at the root (`.codex-plugin/plugin.json`, `plugin.json`) point at `plugins/codex/hooks/hooks.json`, and `rules/`, `scripts/dogwood/` and `hooks/vendor/` are shared with the Claude Code plugin rather than copied.

### Where Codex does not run the plugin's hooks

Codex runs the hooks of `plugins/codex/hooks/hooks.json` only when its `plugin_hooks` feature is on and you trusted them in `/hooks`. Two settings outside the plugin's reach stop them. Both are the Codex counterpart of the organization guard that skips the Claude Code plugin's mod hooks ([Settings hooks for managed environments](../../README.md#settings-hooks-for-managed-environments)), with one difference: a Claude Code plugin can carry a settings hook that the guard does not skip, while nothing a Codex plugin bundles survives these policies. The hooks have to be registered in a config layer that Codex does read:

- **`plugin_hooks` off.** Current Codex builds keep plugin-bundled hooks behind the `plugin_hooks` feature (`codex features list` shows it as under development; [openai/codex#16430](https://github.com/openai/codex/issues/16430), discovery added by [openai/codex#19705](https://github.com/openai/codex/pull/19705)). The plugin installs and `/plugins` shows it, but `hooks/hooks.json` is never loaded. User and project hooks (`~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, or `[hooks]` in the `config.toml` next to them) do run, once trusted in `/hooks`.
- **`allow_managed_hooks_only = true`** in the administrator's `requirements.toml` (`/etc/codex/requirements.toml` on Linux / macOS, `%ProgramData%\OpenAI\Codex\requirements.toml` on Windows, an MDM profile, or the ChatGPT workspace's cloud requirements). Codex then skips user, project, session *and plugin* hooks and runs only managed hooks: the `[hooks]` tables of `requirements.toml` (scripts under its `managed_dir`), or the system layer's `hooks.json` (`/etc/codex/hooks.json`). Nothing a user writes under `~/.codex/` or the project runs either, so the hooks must be deployed by the administrator; they need no trust in `/hooks`.

`plugins/codex/scripts/install-hooks.sh` (the `install-hooks` subcommand of the `feedback-gate` binary, `internal/hookgate/codex_install_hooks.go`) writes the plugin's hooks where Codex reads them, with `${PLUGIN_ROOT}` replaced by the absolute path of the checkout or installed copy (`~/.codex/plugins/cache/hook-gate/feedback-gate/<version>`) it is run from:

```
bash plugins/codex/scripts/install-hooks.sh                  # add to ~/.codex/hooks.json ($CODEX_HOME/hooks.json)
bash plugins/codex/scripts/install-hooks.sh --project [dir]  # add to <dir>/.codex/hooks.json (default: the current directory)
bash plugins/codex/scripts/install-hooks.sh --to FILE        # add to any hooks.json
bash plugins/codex/scripts/install-hooks.sh --print          # print the hooks.json (for /etc/codex/hooks.json)
bash plugins/codex/scripts/install-hooks.sh --toml           # print [hooks] tables for requirements.toml
bash plugins/codex/scripts/install-hooks.sh --remove [...]   # take the plugin's hooks out of the target again
```

It merges: the other hooks and keys of the file are kept in their order, and the plugin's own groups (those whose commands run `plugins/codex/scripts/hook.sh`) are replaced, so running it again after moving the checkout or updating the plugin leaves one copy. The target must be valid JSON or absent; the file is written atomically. A copied hook needs the same trust in `/hooks` as any non-managed hook, and the first hook after that downloads the binary as described under [Requirements](#requirements) (`install-hooks.sh` itself needs the binary too, so it downloads it the same way; `FEEDBACK_GATE_BIN` skips that). For a managed deployment hand `--print` (as `/etc/codex/hooks.json`) or `--toml` (pasted into `requirements.toml`, with `[features].hooks = true` pinned so a user cannot turn hooks off) to the administrator, together with a checkout of this repository at the same path on every machine, readable by every user; Codex does not distribute hook scripts, and `scripts/hook.sh` finds the root from its own location when `PLUGIN_ROOT` is unset. The binary cache is per user (`~/.cache/feedback-gate`), so each user's first session downloads it once.

**No double runs.** Codex runs every matching hook of every file, so where plugin-bundled hooks do run and a copy is still installed, each event would run twice (two gate runs, two notifications). `scripts/hook.sh` tells the binary which layer called it (`FEEDBACK_GATE_HOOK_SOURCE`: `plugin` when Codex passed `PLUGIN_ROOT`, which it does only for plugin-bundled hooks; `config` otherwise). A plugin-layer call writes the marker `~/{.agents,.claude}/feedback/.codex_plugin_seen/<session_id>` (`CLAUDE_FEEDBACK_DIR` is respected) on every event, and a `config` call that finds the marker of its session exits 0 with no output (`CodexHookSourceAllows` in `internal/hookgate/host_codex.go`). Where the plugin-bundled hooks do not run (the two cases above, or not yet trusted), no marker exists and the copy does the work. The two can both run only on the first SessionStart of a session, whose reset is idempotent. Markers older than 24h are removed at session start, like `.classic_seen` of the Claude Code plugin. Nothing needs configuring; use `--remove` once a copy is no longer wanted.

### Rules and `gate.yaml` under the Codex sandbox

The hooks run as plain child processes of Codex, outside its sandbox, so what they write (`~/{.agents,.claude}/feedback/` state, `<project>/{.agents,.claude}/.gate-status/`, the `count` line of a rule, the binary cache) is not limited by the sandbox mode or by an organization's sandbox policy. What the sandbox limits is Codex itself: in `workspace-write` mode, `<writable_root>/.agents` and `<writable_root>/.codex` (like `.git`) are read-only, recursively. So when Codex is asked to add or edit a project rule under `.agents/feedback/` or `.agents/gate.yaml`, the write needs an approval (or `danger-full-access`), which an organization's requirements can forbid. `.claude/` is not protected: for a project whose rules Codex should be able to maintain itself, keep them in `<project>/.claude/feedback/` and `<project>/.claude/gate.yaml`, which this plugin reads as well (`.agents/` first, then `.claude/`; a rule of the same name in `.agents/` wins). The global `~/.agents/feedback/` and `~/.claude/feedback/` are outside the project's writable roots either way, so Codex edits them only with approval. A rule that only you should change is best kept under `.agents/`, where the sandbox enforces exactly that.

## Requirements

- `bash`, and `curl` or `wget` on the first run: the hooks run the Go binary `feedback-gate`, which `scripts/hook.sh` downloads from this repository's GitHub Releases (`feedback-gate_<os>_<arch>.tar.gz` for the plugin version, SHA-256 checked against `checksums.txt`; `tar` and `sha256sum` / `shasum` are required too: without a hash tool nothing is installed) into `${FEEDBACK_GATE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/feedback-gate}/<version>/feedback-gate`. The download (a few MB) happens on the first hook after an install or an update (SessionStart), within that hook's timeout, once per version; after that nothing is needed. If the binary is not cached and cannot be downloaded, the hooks do nothing (exit 0) and write one line to stderr (`feedback-gate: could not install the feedback-gate v<version> binary (<reason>); the hook did nothing`). `FEEDBACK_GATE_BIN` (path of an executable, e.g. a prebuilt binary to avoid the download) skips the lookup and `FEEDBACK_GATE_RELEASE_BASE_URL` replaces the download location (a `file://` directory works too, with `curl`; `wget` cannot read `file://`). Cache directories of other versions are removed only after 30 days without use. Linux and macOS, amd64 and arm64.
- `terminal-notifier` (optional, macOS): desktop notifications.
- `dogwood` (optional): the gate's policy engine; see the [main README](../../README.md#requirements).

## Hooks

Every event is a command hook `bash "${PLUGIN_ROOT}/plugins/codex/scripts/hook.sh" <Event>` in `hooks/hooks.json`, which runs `feedback-gate codex <Event>` (the Go binary built from `cmd/feedback-gate`; the checks are in `internal/hookgate`). Codex sends the same event names and stdin JSON as Claude Code's command hooks and reads the same output (`permissionDecision`, `decision: block`, `additionalContext`, exit code 2), so the table of the [main README](../../README.md#hooks) applies, with these differences:

| Codex event | What runs | Difference from Claude Code |
| --- | --- | --- |
| SessionStart | `reset-gate` | None. |
| UserPromptSubmit | rules file + `feedback-inject` | None. |
| PreToolUse (`Bash`) | `bash-changes` (`bashStarted`), `feedback-guard` (`pre_bash`) | None. |
| PreToolUse (`apply_patch`) | `feedback-guard` (`pre_edit`) per file | Codex edits files with one patch (`tool_input.command`, the `*** Begin Patch` format). The patch is split into its files (`internal/hookgate/apply_patch.go`): `*** Add File` is checked like `Write` (the whole content), `*** Update File` like `Edit` (the added lines), a `*** Move to` at its destination path; `*** Delete File` is not checked. `deny` if any file is denied, else `ask`. |
| PreToolUse (`spawn_agent` / `send_input`), opt-in | `agent-launch-guard` | Only with `FEEDBACK_GATE_AGENT_LAUNCH_GUARD=true`. `spawn_agent` is treated as `Agent` (`agent_type` → `subagent_type`, `message` → `prompt`), `send_input` as `SendMessage` (`agent_id` → `to`). |
| PostToolUse (`Bash`) | `bash-changes`, `feedback-bash-edit`, gate `rules` | None. |
| PostToolUse (`apply_patch`) | `record-changes` + `feedback-post-edit` per file, then gate `rules` once | Same split; the gate runs once for the whole patch. |
| PostToolUse (`spawn_agent`) | `subagent-report` | The agent id is read from `tool_response.agentId` or `agent_id` (also from a JSON string). |
| PermissionRequest | `notification` (`notify`) | Codex has no `Notification` event; the "waiting for you" notification is sent when a tool call waits for your approval. The hook returns nothing, so the approval stays with the normal dialog. |
| Stop | `all-stop` (gate `checks`, `stop_check`, `stop` notification) | None. |
| SubagentStop | gate `checks`, `stop_check`, `saveSubagentReport` | None. |

Two differences in the output:

- **`ask` becomes `deny`.** Codex's PreToolUse has no `ask` (returning it fails the hook and the tool runs). A rule with `severity: ask` (or `count` 3-4 without `severity`) denies the call and the reason says so. As in Claude Code, the same rule on the same target is downgraded to `warn` from the next call in the session, so Codex can fix the call and retry.
- **Warnings reach the model.** Claude Code shows what a hook prints on stderr; Codex does not. On PreToolUse (when nothing is denied) and PostToolUse they are added as `additionalContext`, on Stop / SubagentStop as `systemMessage`. They are still printed on stderr.

## Settings

Codex plugins have no settings screen, so the options of the Claude Code plugin are environment variables of the process that runs `codex` (`CLAUDE_PLUGIN_OPTION_<key>` is read too):

| Variable | Claude Code option | Values |
| --- | --- | --- |
| `FEEDBACK_GATE_LANG` | `language` | `ja` / `en`; unset follows `LC_ALL` / `LC_MESSAGES` / `LANG`. |
| `FEEDBACK_GATE_AGENT_LAUNCH_GUARD` | `agentLaunchGuard` | `true` to enable (default off). |
| `FEEDBACK_GATE_ASK_AGENT_TYPES` | (none) | Agent types (`agent_type`) the launch guard asks about, separated by `,` or `;` (default `code-implementer`). |
| `FEEDBACK_GATE_ALLOW_RECIPIENTS` | (none) | Recipients (`agent_id`) of `send_input` that need no confirmation, separated by `,` or `;` (default `git-operator`). |
| `FEEDBACK_GATE_AUTO_COUNT` | `autoCount` | `false` to disable (default on). |
| `FEEDBACK_GATE_RULES_FILE` | `rulesFile` | Path of the rules file injected into every prompt (default `~/{.agents,.claude}/feedback-gate/feedback_rules.md`; the bundled `rules/feedback_rules.md` when none exists). |

`CLAUDE_FEEDBACK_DIR` and `DOGWOOD_BIN` work as in Claude Code. Codex session ids are the session keys of the state files.

## Layout

Same shape as the Claude Code settings hooks (`hooks/hooks.json` → `scripts/hook.sh` → `feedback-gate`), minus the mod (`register.js`), which Codex has no equivalent of:

```
.codex-plugin/plugin.json       # Codex manifest (repository root), hooks -> plugins/codex/hooks/hooks.json
plugin.json                     # portable Agent Plugins manifest (repository root), same hooks
.agents/plugins/marketplace.json
plugins/codex/
├── hooks/hooks.json            # command hooks for every event
├── scripts/hook.sh             # entry: finds or downloads feedback-gate (see ../../scripts/install-binary.sh), runs `feedback-gate codex <Event>`
├── scripts/install-hooks.sh    # copies hooks/hooks.json into ~/.codex/hooks.json etc. where Codex does not run plugin hooks (`feedback-gate codex install-hooks`)
└── README.md, README_ja.md
```

Source: `cmd/feedback-gate` (the binary) and `internal/hookgate` (the checks, with `Host` for the per-host differences: `host.go`, `host_codex.go`, `host_claude.go`); the binary is built and published by GoReleaser (`.goreleaser.yaml`) when release-please tags a release. Adding another host means implementing `Host` and adding a subcommand; the checks are not touched.
