# feedback-gate for Codex

[日本語](README_ja.md)

[feedback-gate](../../README.md) as a plugin for [Codex](https://developers.openai.com/codex). It reads the same rule files and the same `gate.yaml` as the Claude Code plugin, so a project you work on with both tools gets the same checks.

- Injects your feedback rules into every prompt and enforces them on tool calls and when Codex stops.
- Runs the quality gate of `gate.yaml` after file edits and when Codex stops.
- Sends a desktop notification when Codex waits for approval or stops (macOS).

It looks in `.agents/` first, then `.claude/` (Claude Code the other way round).

## Install

```
gh api repos/nonchan7720/claude-hook-gate/contents/plugins/codex/scripts/setup.sh -H "Accept: application/vnd.github.raw" | bash
```

This one line adds or updates the plugin, installs the hooks, and puts a command for later use, `feedback-gate-setup`, in `~/.local/bin`. Then start Codex, open `/hooks` and trust the hooks.

Codex does not run hooks bundled in a plugin yet ([openai/codex#16430](https://github.com/openai/codex/issues/16430)), so installing the plugin alone does nothing: the hooks have to be copied into `~/.codex/hooks.json`. The command above does that.

| To | Run |
| --- | --- |
| Update the plugin and the hooks | `feedback-gate-setup` (trust the hooks again in `/hooks` afterwards) |
| Install into the project's `.codex/hooks.json` | `feedback-gate-setup --project` |
| Reinstall the hooks without updating the plugin | `feedback-gate-setup --no-update` |
| Remove the hooks | `feedback-gate-setup --remove` |
| Install into the managed layer (`/etc/codex/hooks.json`) | `feedback-gate-setup --system` (see [managed hooks only](#where-only-managed-hooks-are-allowed)) |

<details>
<summary>Installing by hand</summary>

```
codex plugin marketplace add nonchan7720/claude-hook-gate
# install feedback-gate from /plugins, then
bash ~/.codex/plugins/cache/hook-gate/feedback-gate/<version>/plugins/codex/scripts/install-hooks.sh
```

Options of `install-hooks.sh` (one per run):

| Option | Effect |
| --- | --- |
| (none) | Add to `~/.codex/hooks.json` |
| `--project [dir]` | Add to `<dir>/.codex/hooks.json` |
| `--to FILE` | Add to any `hooks.json` |
| `--print` | Print the content without writing. With `--to FILE`, print the result of merging into FILE |
| `--toml` | Print it as the `[hooks]` of a `requirements.toml` |
| `--remove` | Remove the plugin's hooks |

Other hooks in the file are kept; only this plugin's are replaced. Run it again after updating the plugin or moving the checkout.

</details>

## If the hooks do not run

`/hooks` lists where each hook comes from and its state (trusted, disabled, skipped by policy). `codex features list` shows the feature flags.

| Symptom | Fix |
| --- | --- |
| `/hooks` says the hooks need review | Trust them. Reinstalling the hooks requires trusting them again |
| `codex features list` shows `hooks` as false | Remove `[features] hooks = false` from `config.toml` |
| `~/.codex/hooks.json` has no entry for this plugin, or one that points to a path that is gone | Run `feedback-gate-setup` again |
| stderr shows `could not install the feedback-gate ... binary (<reason>)` | Meet the [requirements](#requirements) |
| `/hooks` shows the user hooks as skipped by policy | See "Where only managed hooks are allowed" below |

### Where only managed hooks are allowed

When the organization's `requirements.toml` (or an MDM profile or ChatGPT workspace) sets `allow_managed_hooks_only = true`, Codex runs only the hooks of the managed layer. Hooks under `~/.codex/` or in a project do not run, and neither do the plugin's own.

- **You administer the machine.** Run `feedback-gate-setup` again. When it finds the policy in `/etc/codex/requirements.toml` it installs into `/etc/codex/hooks.json` with `sudo`. Add `--system` when the policy comes from MDM or a workspace.
- **You do not.** Give your administrator one of these:
  - the output of `install-hooks.sh --print` (to be placed as `/etc/codex/hooks.json`)
  - the output of `install-hooks.sh --toml` (to be pasted into `requirements.toml`)

In both cases the checkout of this repository that the hooks point to must stay where every Codex user can read it. On machines that cannot reach GitHub, set `FEEDBACK_GATE_BIN` to the location of the binary.

## The Codex sandbox and where rules go

In `workspace-write` mode Codex makes the project's `.agents/` and `.codex/` read-only. The hooks themselves run outside the sandbox and are not affected.

| Location | Can Codex edit it | Good for |
| --- | --- | --- |
| `<project>/.claude/feedback/`, `<project>/.claude/gate.yaml` | yes | Rules that Codex itself should maintain |
| `<project>/.agents/feedback/`, `<project>/.agents/gate.yaml` | needs approval | Rules only you should change |
| `~/.agents/feedback/`, `~/.claude/feedback/` | needs approval | Rules for all projects |

When both hold a rule with the same name, the one under `.agents/` is used.

## Requirements

| Tool | Needed for |
| --- | --- |
| `bash`, `curl` or `wget`, `tar`, `sha256sum` or `shasum` | Downloading the Go binary `feedback-gate` once per version |
| `terminal-notifier` | Desktop notifications on macOS (optional) |
| `dogwood` | The gate's policy decisions (optional; see [Requirements](../../docs/install.md#requirements)) |

Supported: Linux and macOS, amd64 and arm64. Where the binary comes from and what happens when it cannot be installed is the same as in [Managed environments](../../docs/managed-environments.md).

## Differences from Claude Code

What runs on each event is the same as the table in [Hooks](../../docs/hooks.md). The differences:

| Item | In Codex |
| --- | --- |
| File edits | The single patch of `apply_patch` is split per file and each file is checked. The gate runs once for the whole patch. `*** Delete File` is not checked |
| `ask` | Codex has no `ask`, so it becomes a deny. The same rule on the same target drops to a warning from the next call, so Codex can fix the call and retry |
| Warnings | Codex does not show stderr, so they are passed to the model as context |
| Rules with `files` | There is no `Read` tool, so they arrive only on an edit |
| "Waiting for you" notification | Sent on `PermissionRequest` instead of `Notification`. It takes no part in the approval decision |
| Agent launch guard | Applies to `spawn_agent` / `send_input` |
| Block reason on stop | It is shown in the conversation, so the output of a failed command is cut to its last 60 lines plus the log path |
| `stop_review` | The review happens, but the effort is not switched |
| Esc or timeout | When the hook is killed, the gate commands it was running are stopped with it |

## Settings

There is no settings screen; pass them as environment variables of the process that starts `codex`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FEEDBACK_GATE_LANG` | OS language | `ja` / `en` |
| `FEEDBACK_GATE_AUTO_COUNT` | on | `false` turns off the automatic `count` increase |
| `FEEDBACK_GATE_AGENT_LAUNCH_GUARD` | off | `true` turns on the agent launch guard |
| `FEEDBACK_GATE_ASK_AGENT_TYPES` | `code-implementer` | Agent types the launch guard asks about (separated by `,` or `;`) |
| `FEEDBACK_GATE_ALLOW_RECIPIENTS` | `git-operator` | Recipients that need no confirmation |
| `FEEDBACK_GATE_RULES_FILE` | `~/{.agents,.claude}/feedback-gate/feedback_rules.md` | The shared rules file injected into every prompt |

`CLAUDE_FEEDBACK_DIR` and `DOGWOOD_BIN` work as in Claude Code.

## Layout

```
.codex-plugin/plugin.json       # Codex manifest (repository root)
plugin.json                     # Agent Plugins manifest (repository root)
.agents/plugins/marketplace.json
plugins/codex/
├── hooks/hooks.json            # command hooks for every event
├── scripts/hook.sh             # entry point: finds or downloads feedback-gate and runs it
├── scripts/setup.sh            # entry point of the one-liner (feedback-gate-setup)
└── scripts/install-hooks.sh    # copies hooks.json to where Codex reads it
```

The plugin root is the repository itself, and `rules/` and the like are shared with the Claude Code plugin. The checks are implemented in `internal/hookgate`; what differs per host is in `host_codex.go` (see [Development](../../docs/development.md)).
