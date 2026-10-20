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

If your Codex build does not run plugin-bundled hooks (see [openai/codex#16430](https://github.com/openai/codex/issues/16430)), copy the events of `hooks/hooks.json` into `~/.codex/hooks.json` (or the project's `.codex/hooks.json`) with `${PLUGIN_ROOT}` replaced by the path of a checkout or of the installed copy (`~/.codex/plugins/cache/hook-gate/feedback-gate/<version>`). `scripts/hook.sh` also finds the root from its own location when `PLUGIN_ROOT` is unset:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|apply_patch|spawn_agent|send_input",
        "hooks": [{ "type": "command", "command": "bash /path/to/claude-hook-gate/plugins/codex/scripts/hook.sh PreToolUse" }]
      }
    ]
  }
}
```

## Requirements

- `node` (or `bun`) on `PATH` and `bash`: the hooks run `plugins/codex/hooks/cli.js`. Without a runtime they do nothing (exit 0).
- `terminal-notifier` (optional, macOS): desktop notifications.
- `dogwood` (optional): the gate's policy engine; see the [main README](../../README.md#requirements).

## Hooks

Every event is a command hook `bash "${PLUGIN_ROOT}/plugins/codex/scripts/hook.sh" <Event>` in `hooks/hooks.json`, which runs `hooks/cli.js <Event>` (built from `src/codex-cli.ts`). Codex sends the same event names and stdin JSON as Claude Code's command hooks and reads the same output (`permissionDecision`, `decision: block`, `additionalContext`, exit code 2), so the table of the [main README](../../README.md#hooks) applies, with these differences:

| Codex event | What runs | Difference from Claude Code |
| --- | --- | --- |
| SessionStart | `reset-gate` | None. |
| UserPromptSubmit | rules file + `feedback-inject` | None. |
| PreToolUse (`Bash`) | `bash-changes` (`bashStarted`), `feedback-guard` (`pre_bash`) | None. |
| PreToolUse (`apply_patch`) | `feedback-guard` (`pre_edit`) per file | Codex edits files with one patch (`tool_input.command`, the `*** Begin Patch` format). The patch is split into its files (`src/apply-patch.ts`): `*** Add File` is checked like `Write` (the whole content), `*** Update File` like `Edit` (the added lines), a `*** Move to` at its destination path; `*** Delete File` is not checked. `deny` if any file is denied, else `ask`. |
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
| `FEEDBACK_GATE_AUTO_COUNT` | `autoCount` | `false` to disable (default on). |
| `FEEDBACK_GATE_RULES_FILE` | `rulesFile` | Path of the rules file injected into every prompt (default `~/{.agents,.claude}/feedback-gate/feedback_rules.md`; the bundled `rules/feedback_rules.md` when none exists). |

`CLAUDE_FEEDBACK_DIR` and `DOGWOOD_BIN` work as in Claude Code. Codex session ids are the session keys of the state files.

## Layout

Same shape as the Claude Code settings hooks (`hooks/hooks.json` → `scripts/hook.sh` → `hooks/cli.js`), minus the mod (`register.js`), which Codex has no equivalent of:

```
.codex-plugin/plugin.json       # Codex manifest (repository root), hooks -> plugins/codex/hooks/hooks.json
plugin.json                     # portable Agent Plugins manifest (repository root), same hooks
.agents/plugins/marketplace.json
plugins/codex/
├── hooks/hooks.json            # command hooks for every event
├── hooks/cli.js                # built from src/codex-cli.ts (CI commits it); imports ../../../hooks/vendor/
├── scripts/hook.sh             # entry: runs hooks/cli.js with node or bun
└── README.md, README_ja.md
```

Source (`src/`): `host.ts` (the `Host` interface: `options` / `normalize` / `render`, `runCore`, `cliMain`), `host-codex.ts` (this plugin), `host-claude.ts` (Claude Code's settings hooks), `apply-patch.ts`, `codex-cli.ts`. Adding another host means implementing `Host` and bundling a `cliMain(host)` entry; the checks are not touched.
