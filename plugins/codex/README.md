# feedback-gate for Codex

[日本語](README_ja.md)

The [feedback-gate](../../README.md) hooks packaged as a [Codex](https://developers.openai.com/codex) plugin. It does the same three things as the Claude Code plugin, with the same rule files and the same `.claude/gate.yaml`, so a project you work on with both tools is checked the same way:

- Injects your feedback rules (`~/.claude/feedback/*.md`, `<project>/.claude/feedback/*.md`) into each prompt and enforces them on tool calls and when Codex stops.
- Runs the per-project quality gates of `.claude/gate.yaml` after file edits and when Codex stops.
- Sends a desktop notification when Codex waits for your approval or stops (macOS, `terminal-notifier`).

The checking logic (`src/hooks.ts` and the modules it calls) is shared with the Claude Code plugin and is not changed for Codex. What differs between the two hosts is isolated in the `Host` interface of `src/host.ts`: `src/host-claude.ts` for Claude Code's settings hooks and `src/host-codex.ts` for Codex. See [Layout](#layout).

## Install

```
codex plugin marketplace add nonchan7720/claude-hook-gate
```

This registers the repository as the `hook-gate` marketplace (its catalog is `.agents/plugins/marketplace.json`, which points at this directory). Then install `feedback-gate` from the plugin list in Codex (`/plugins`), and when Codex reports "Hooks need review", trust the hooks of the plugin (`/hooks`); plugin hooks do not run until they are trusted.

Codex loads the hooks of an installed plugin from `hooks/hooks.json`. If your Codex build does not run plugin-bundled hooks yet (see [openai/codex#16430](https://github.com/openai/codex/issues/16430)), point your own `~/.codex/hooks.json` (or `.codex/hooks.json` in the project) at the installed copy instead. The hook commands take the plugin root from `CLAUDE_PLUGIN_ROOT` (also `PLUGIN_ROOT`), and `scripts/hook.sh` finds it from its own location when neither is set, so the same `hooks/hooks.json` works with the variable replaced by the path of the plugin, e.g. `~/.codex/plugins/cache/hook-gate/feedback-gate/<version>` or a checkout of this repository:

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

(Copy every event from `hooks/hooks.json` the same way.)

## Requirements

- `node` (or `bun`) on `PATH`: the hooks run `hooks/cli.js` with it. Without either, the hooks do nothing (exit 0).
- `bash`.
- `terminal-notifier` (optional, macOS): desktop notifications.
- `dogwood` (optional): the gate's policy engine; see the [main README](../../README.md#requirements).

## Hooks

Every event is a command hook `bash "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" <Event>` in `hooks/hooks.json`, which runs `hooks/cli.js <Event>` (built from `src/codex-cli.ts`). Codex sends the same event names and the same stdin JSON as Claude Code's command hooks, and reads the same output (`permissionDecision`, `decision: block`, `additionalContext`, exit code 2), so the table of the [main README](../../README.md#hooks) applies, with these differences:

| Codex event | What runs | Difference from Claude Code |
| --- | --- | --- |
| SessionStart | `reset-gate` | None. |
| UserPromptSubmit | rules file + `feedback-inject` | None. |
| PreToolUse (`Bash`) | `bash-changes` (`bashStarted`), `feedback-guard` (`pre_bash`) | None. |
| PreToolUse (`apply_patch`) | `feedback-guard` (`pre_edit`) per file | Codex edits files with one patch (`tool_input.command`, the `*** Begin Patch` format). The patch is split into its files (`src/apply-patch.ts`): `*** Add File` is checked like `Write` (the whole content), `*** Update File` like `Edit` (the added lines), a `*** Move to` is checked at its destination path, `*** Delete File` is not checked. The results are merged: `deny` if any file is denied, else `ask`. |
| PreToolUse (`spawn_agent` / `send_input`), opt-in | `agent-launch-guard` | Only with `FEEDBACK_GATE_AGENT_LAUNCH_GUARD=true`. `spawn_agent` is treated as `Agent` (`agent_type` → `subagent_type`, `message` → `prompt`), `send_input` as `SendMessage` (`agent_id` → `to`). |
| PostToolUse (`Bash`) | `bash-changes`, `feedback-bash-edit`, gate `rules` | None. |
| PostToolUse (`apply_patch`) | `record-changes` + `feedback-post-edit` per file, then gate `rules` once | Same split as above; the gate runs once for the whole patch. |
| PostToolUse (`spawn_agent`) | `subagent-report` | The agent id is read from `tool_response.agentId` or `agent_id` (also when the response is a JSON string). |
| PermissionRequest | `notification` (`notify`) | Codex has no `Notification` event; the "waiting for you" notification is sent when a tool call waits for your approval. The hook returns nothing, so the approval stays with the normal dialog. |
| Stop | `all-stop` (gate `checks`, `stop_check`, `stop` notification) | None. |
| SubagentStop | gate `checks`, `stop_check`, `saveSubagentReport` | None. |

Two more differences in the output:

- **`ask` becomes `deny`.** Codex's PreToolUse has no `ask` (returning it fails the hook and the tool runs). A rule with `severity: ask` (or `count` 3-4 without `severity`) denies the call, and the reason says so. As in Claude Code, the same rule on the same target is downgraded to `warn` from the next call in the session, so Codex can fix the call and retry.
- **Warnings reach the model.** Claude Code shows the warnings a hook prints on stderr; Codex does not. On PreToolUse (when nothing is denied) and PostToolUse they are added as `additionalContext`, on Stop / SubagentStop as `systemMessage`. They are still printed on stderr.

## Settings

Codex plugins have no settings screen, so the options of the Claude Code plugin are environment variables of the process that runs `codex` (the Claude Code names `CLAUDE_PLUGIN_OPTION_<key>` are read too):

| Variable | Claude Code option | Values |
| --- | --- | --- |
| `FEEDBACK_GATE_LANG` | `language` | `ja` / `en`; unset follows `LC_ALL` / `LC_MESSAGES` / `LANG`. |
| `FEEDBACK_GATE_AGENT_LAUNCH_GUARD` | `agentLaunchGuard` | `true` to enable (default off). |
| `FEEDBACK_GATE_AUTO_COUNT` | `autoCount` | `false` to disable (default on). |
| `FEEDBACK_GATE_RULES_FILE` | `rulesFile` | Path of the rules file injected into every prompt (default `~/.claude/feedback-gate/feedback_rules.md`; the bundled `rules/feedback_rules.md` when it does not exist). |

`CLAUDE_FEEDBACK_DIR` and `DOGWOOD_BIN` work as in Claude Code. The state files stay under `.claude/.gate-status/` and `~/.claude/feedback/` so that a project used with both tools shares one set of rules, gates and counts; Codex session ids are used as the session keys.

## Layout

Same shape as the Claude Code plugin (`hooks/hooks.json` → `scripts/hook.sh` → `hooks/cli.js`), minus the mod (`register.js`), which Codex has no equivalent of:

```
plugins/codex/
├── .codex-plugin/plugin.json   # Codex manifest (compatibility layout)
├── plugin.json                 # portable Agent Plugins manifest
├── hooks/
│   ├── hooks.json              # command hooks for every event
│   ├── cli.js                  # built from src/codex-cli.ts (CI commits it)
│   └── vendor/                 # yaml / i18next (built)
├── scripts/
│   ├── hook.sh                 # entry: runs hooks/cli.js with node or bun
│   ├── dogwood/                # copied from scripts/dogwood/ at build time
│   └── gate.schema.json        # copied from scripts/ at build time
└── rules/                      # copied from rules/ at build time
```

`hooks/cli.js`, `hooks/vendor/`, `rules/`, `scripts/dogwood/` and `scripts/gate.schema.json` are generated by `bun run build` and committed by the "Build bundle" workflow; edit the originals at the repository root.

The source is in `src/` of the repository:

- `src/host.ts`: the `Host` interface (`normalize`: host event + stdin JSON → the core's event and payload(s); `render`: the core's `Outcome` + warnings → the host's stdout JSON; `options`: plugin settings from the environment), `runCore` (calls `src/hooks.ts`) and `cliMain` (reads stdin, writes stdout / stderr / exit code).
- `src/host-codex.ts`: the Codex host (this plugin); `src/host-claude.ts`: the Claude Code host (settings hooks, `hooks/cli.js` at the root).
- `src/apply-patch.ts`: the `apply_patch` parser.
- `src/codex-cli.ts`: `cliMain(codexHost)`.

Adding another host means implementing `Host` and bundling a `cliMain(host)` entry; the checks themselves are not touched.
