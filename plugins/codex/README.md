# feedback-gate for Codex

[日本語](README_ja.md)

The [feedback-gate](../../README.md) hooks as a [Codex](https://developers.openai.com/codex) plugin. Same three things as the Claude Code plugin, with the same rule files and the same `gate.yaml`, so a project you work on with both tools is checked the same way:

- Injects your feedback rules (`~/{.claude,.agents}/feedback/*.md`, `<project>/{.claude,.agents}/feedback/*.md`) into each prompt and enforces them on tool calls and when Codex stops.
- Runs the per-project quality gates of `{.claude,.agents}/gate.yaml` after file edits and when Codex stops.
- Sends a desktop notification when Codex waits for your approval or stops (macOS, `terminal-notifier`).

Codex looks in `.agents/` first, then `.claude/` (Claude Code the other way round); state files go under `.gate-status/` in the first of the two that exists. Symlinking one directory to the other is fine. See [What it reads](../../README.md#what-it-reads).

## Install

1. Register the repository as the `hook-gate` marketplace (`.agents/plugins/marketplace.json`) and install `feedback-gate` from `/plugins`:

   ```
   codex plugin marketplace add nonchan7720/claude-hook-gate
   ```

2. **Write the hooks where Codex reads them.** Codex does not yet run the hooks a plugin bundles (its `plugin_hooks` feature is still under development, [openai/codex#16430](https://github.com/openai/codex/issues/16430)), so the plugin installs but nothing runs until its `hooks/hooks.json` is copied into `~/.codex/hooks.json`. Run the installer once, from the installed copy or from a checkout of this repository, without arguments:

   ```
   bash ~/.codex/plugins/cache/hook-gate/feedback-gate/<version>/plugins/codex/scripts/install-hooks.sh
   ```

   It downloads the `feedback-gate` binary for the plugin version (see [Requirements](#requirements)) and adds the hooks to `~/.codex/hooks.json`, pointing at the directory it was run from (`${PLUGIN_ROOT}` replaced by that absolute path). Other hooks already in the file are kept. Run it again after updating the plugin or moving the checkout; it replaces its own entries instead of adding a second copy. Nothing else to configure: the day Codex runs plugin-bundled hooks, the copy goes silent by itself (see [No double runs](#no-double-runs)); `--remove` takes it out.

3. Start Codex. It reports that hooks need review; open `/hooks` and trust them. Non-managed hooks never run before that.

4. The first hook of the session (SessionStart) uses the binary downloaded in step 2; from then on nothing is downloaded.

The plugin root is the repository itself: the Codex manifests at the root (`.codex-plugin/plugin.json`, `plugin.json`) point at `plugins/codex/hooks/hooks.json`, and `rules/`, `scripts/dogwood/` and `hooks/vendor/` are shared with the Claude Code plugin rather than copied.

Options of the installer, for the other places Codex reads hooks from (one target per run):

```
bash plugins/codex/scripts/install-hooks.sh                  # add to ~/.codex/hooks.json ($CODEX_HOME/hooks.json): the normal case
bash plugins/codex/scripts/install-hooks.sh --project [dir]  # add to <dir>/.codex/hooks.json instead (default: the current directory)
bash plugins/codex/scripts/install-hooks.sh --to FILE        # add to any hooks.json
bash plugins/codex/scripts/install-hooks.sh --print          # print the hooks.json instead of writing; with --to FILE, print FILE merged with the hooks (see below)
bash plugins/codex/scripts/install-hooks.sh --toml           # print [hooks] tables for requirements.toml (see below)
bash plugins/codex/scripts/install-hooks.sh --remove [...]   # take the plugin's hooks out of the target again
```

It is the `install-hooks` subcommand of the `feedback-gate` binary (`internal/hookgate/codex_install_hooks.go`). The target must be valid JSON or absent, the other hooks and keys of the file keep their order, only this plugin's groups (those whose commands run `plugins/codex/scripts/hook.sh`) are replaced, and the file is written atomically. A project copy (`--project`) runs only in a project whose `.codex/` layer Codex trusts. `FEEDBACK_GATE_BIN` points the installer (and the hooks) at a prebuilt binary instead of downloading one.

### If the hooks still do not run

Check in this order. `/hooks` in Codex lists every hook source it found and whether it is trusted, disabled or skipped; `codex features list` shows the feature flags.

1. **Not trusted.** `/hooks` shows the hooks as needing review: trust them (step 3). Codex records trust against the hook's hash, so after `install-hooks.sh` was run again (a new version, a moved checkout) they need trusting again.
2. **Hooks turned off.** `codex features list` shows `hooks` as false (`[features] hooks = false` in a `config.toml`): turn it on, or remove the line.
3. **The copy is missing or stale.** `~/.codex/hooks.json` has no `plugins/codex/scripts/hook.sh` entries, or they point at a path that no longer exists (a removed version directory, a moved checkout): run `install-hooks.sh` again from the current location.
4. **The binary could not be installed.** The hooks exit 0 and write one line to stderr, `feedback-gate: could not install the feedback-gate v<version> binary (<reason>); the hook did nothing` (`no-download-tool`, `no-sha256-tool`, `download-failed`, ...): see [Requirements](#requirements). `install-hooks.sh` prints the same line and exits 1 in that case, so step 2 above shows it right away.
5. **Managed hooks only.** `/hooks` shows the user (and plugin) hooks as skipped by policy, or the administrator's `requirements.toml` (`/etc/codex/requirements.toml` on Linux / macOS, `%ProgramData%\OpenAI\Codex\requirements.toml` on Windows; an MDM profile or the ChatGPT workspace's cloud requirements can set the same) contains `allow_managed_hooks_only = true`. Codex then skips user, project, session *and plugin* hooks and runs only managed hooks: the `[hooks]` tables of `requirements.toml` (scripts under its `managed_dir`) or the system layer's `hooks.json` (`/etc/codex/hooks.json`). This is the Codex counterpart of the organization guard that skips the Claude Code plugin's mod hooks ([Settings hooks for managed environments](../../README.md#settings-hooks-for-managed-environments)), with one difference: a Claude Code plugin can carry a settings hook that the guard does not skip, while nothing a Codex plugin bundles survives this policy. Nothing you write under `~/.codex/` or the project runs either, so the hooks have to be deployed by the administrator (managed hooks need no trust in `/hooks`). Hand them the ready-made pieces:

   - `bash plugins/codex/scripts/install-hooks.sh --print > hooks.json`, to be placed as `/etc/codex/hooks.json` (`--print --to /etc/codex/hooks.json` when there already is one, so its hooks are kept); or
   - `bash plugins/codex/scripts/install-hooks.sh --toml`, to be pasted into `requirements.toml` together with `[features] hooks = true` (so a user cannot turn hooks off);
   - and a checkout of this repository at the path the output names, on every machine, readable by every user (Codex does not distribute hook scripts; `scripts/hook.sh` finds its root from its own location, so no `PLUGIN_ROOT` is needed). The binary cache is per user (`~/.cache/feedback-gate`), so each user's first session downloads it once; where machines have no access to GitHub, put the binary at a shared path and set `FEEDBACK_GATE_BIN` for everyone, or `FEEDBACK_GATE_RELEASE_BASE_URL` to a mirror of the release files.

### Putting the hooks in the managed layer yourself

Under `allow_managed_hooks_only` Codex decides by the *source* of a hook, not by who wrote it: a hook is run when it comes from a managed layer and skipped otherwise. No file under `~/.codex/` or in the project is managed, so there is nothing to tune there. The managed layer that is a plain file on the machine is the system config folder, `/etc/codex/` on Linux and macOS: a `hooks.json` there (or `[hooks]` in the `config.toml` there) is managed, runs for every user without a trust prompt, and is not skipped by the policy, whether that policy comes from `/etc/codex/requirements.toml`, an MDM profile or the ChatGPT workspace. Writing there needs administrator rights on the machine (`sudo`). If you have them, do what the administrator would do:

```
bash plugins/codex/scripts/install-hooks.sh --print --to /etc/codex/hooks.json > /tmp/feedback-gate-hooks.json
sudo install -D -m 0644 /tmp/feedback-gate-hooks.json /etc/codex/hooks.json
```

The first line runs as yourself: it downloads the binary into your cache and prints what `/etc/codex/hooks.json` should contain, that is the hooks the administrator already put there (if the file exists; it only has to be readable) merged with this plugin's, and writes nothing. The second line, the only one that needs root, puts it in place. Run the same two lines again after updating the plugin or moving the checkout; the plugin's entries are replaced, the others kept. `--print --remove --to /etc/codex/hooks.json` prints the file without the plugin's hooks, for taking them out the same way. The checkout the hooks point at (the directory `install-hooks.sh` was run from) must stay where it is and be readable by every user who runs Codex. Restart Codex; `/hooks` then lists the hooks as managed. If the policy also pins `[hooks] managed_dir` in `requirements.toml`, the `--toml` output pasted there by the administrator is the only form; without administrator rights on the machine, that administrator is the only route, and the `--print` / `--toml` outputs above are what to hand them.

### No double runs

Codex runs every matching hook of every file, so where plugin-bundled hooks do run (a Codex build with `plugin_hooks` on, hooks trusted) and the copy of step 2 is still installed, each event would run twice (two gate runs, two notifications). `scripts/hook.sh` tells the binary which layer called it (`FEEDBACK_GATE_HOOK_SOURCE`: `plugin` when Codex passed `PLUGIN_ROOT`, which it does only for plugin-bundled hooks; `config` otherwise). A plugin-layer call writes the marker `~/{.agents,.claude}/feedback/.codex_plugin_seen/<session_id>` (`CLAUDE_FEEDBACK_DIR` is respected) on every event, and a `config` call that finds the marker of its session exits 0 with no output (`CodexHookSourceAllows` in `internal/hookgate/host_codex.go`). Where the plugin-bundled hooks do not run (the cases above, or not yet trusted), no marker exists and the copy does the work. The two can both run only on the first SessionStart of a session, whose reset is idempotent. Markers older than 24h are removed at session start, like `.classic_seen` of the Claude Code plugin. Nothing needs configuring; use `--remove` once a copy is no longer wanted.

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
| PostToolUse (`apply_patch`) | `feedback-file-inject` + `record-changes` + `feedback-post-edit` per file, then gate `rules` once | Same split; the gate runs once for the whole patch. Codex has no `Read` tool, so `files`-scoped feedback rules arrive here (and on heredoc targets of `Bash`), not before the first edit. |
| PostToolUse (`spawn_agent`) | `subagent-report` | The agent id is read from `tool_response.agentId` or `agent_id` (also from a JSON string). |
| PermissionRequest | `notification` (`notify`) | Codex has no `Notification` event; the "waiting for you" notification is sent when a tool call waits for your approval. The hook returns nothing, so the approval stays with the normal dialog. |
| Stop | `all-stop` (gate `checks`, `stop_check`, `stop` notification) | None. |
| SubagentStop | gate `checks`, `stop_check`, `saveSubagentReport` | None. |

Differences in the output and in process handling:

- **`ask` becomes `deny`.** Codex's PreToolUse has no `ask` (returning it fails the hook and the tool runs). A rule with `severity: ask` (or `count` 3-4 without `severity`) denies the call and the reason says so. As in Claude Code, the same rule on the same target is downgraded to `warn` from the next call in the session, so Codex can fix the call and retry.
- **Warnings reach the model.** Claude Code shows what a hook prints on stderr; Codex does not. On PreToolUse (when nothing is denied) and PostToolUse they are added as `additionalContext`, on Stop / SubagentStop as `systemMessage`. They are still printed on stderr.
- **Killed hooks take the gate commands with them.** Codex sends SIGKILL to the hook's process group on Esc or timeout. The gate runs each command in its own process group, so it detects the hook's death and kills those groups too; no test run is left behind.

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
├── scripts/install-hooks.sh    # copies hooks/hooks.json into ~/.codex/hooks.json etc., since Codex does not run plugin hooks yet (`feedback-gate codex install-hooks`)
└── README.md, README_ja.md
```

Source: `cmd/feedback-gate` (the binary) and `internal/hookgate` (the checks, with `Host` for the per-host differences: `host.go`, `host_codex.go`, `host_claude.go`); the binary is built and published by GoReleaser (`.goreleaser.yaml`) when release-please tags a release. Adding another host means implementing `Host` and adding a subcommand; the checks are not touched.
