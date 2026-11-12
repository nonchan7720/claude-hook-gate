# Security and permissions

[← README](../README.md) · [日本語](ja/security.md)

What this plugin reads, runs, writes and decides. The same holds for the Go binary used in managed environments.

## Network and credentials

- The plugin itself sends nothing over the network. Data leaves the machine only through the commands you put in `gate.yaml` or in a rule's `check`.
- The exception is downloading the binary in managed environments and Cowork (from the GitHub release, with a checksum check).
- It reads no tokens, keys or passwords. The environment variables it reads only locate files and programs and pick the language (`HOME`, `PATH`, `LANG`, `CLAUDE_FEEDBACK_DIR`, `DOGWOOD_BIN`, `FEEDBACK_GATE_LANG`, ...).

## What it reads

| From | What |
| --- | --- |
| The conversation | The input of Bash / Edit / Write / MultiEdit calls (command, path, new content). With `agentLaunchGuard`, the text of Agent / SendMessage. The text of notifications. It does not read the transcript |
| The disk | Rules, the shared rules file, `gate.yaml`, its own state files, the files Claude edited, and git's view of the working tree |

## What it runs

| Program | Purpose |
| --- | --- |
| `sh -c` | The commands in `gate.yaml` and the `check` of a rule (both written by you) |
| `git` (read-only) | Finds the repository root and the files a Bash command changed |
| `sh`, `mkdir`, `mv`, `rm`, `rmdir`, `kill -0`, `sleep` | Handle its own state files and locks |
| `dogwood` (optional) | Decides whether a gate command runs now |
| `osascript`, `terminal-notifier` (macOS) | Desktop notifications |

## What it writes

- `<project>/.claude/.gate-status/`: gate state, command logs, locks.
- `~/.claude/feedback/`: the violation log, the error log, per-session state.
- The `count:` line of a rule file (with `autoCount`, and on `/correct apply`). Nothing else in the file changes.
- It writes no settings files, no `CLAUDE.md` and no hook configuration.

## Decisions and context

- **Permission decisions.** Only `deny` and `ask`, never `allow`. It can make a call stricter but cannot skip your own permission prompts. It does not change the permission mode or settings.
- **Context it adds.** The shared rules file and the confirmed rules, gate results and rule violations, and the check results of subagents.
- **`stop_review`.** When enabled, it returns review instructions that include the paths of the changed files and the `prompt` from `gate.yaml`. `prompt` reaches Claude as instructions.
- **The `effort-<level>` skills.** They only switch the effort of the rest of the turn. They add no tools or permissions.

## Untrusted repositories

The commands in `gate.yaml` are run as written, and `stop_review.prompt` becomes instructions to Claude. Read `gate.yaml` and `.claude/feedback/` before you open a repository you do not trust.

## Bundled files

- `hooks/register.js` is the bundle built from `src/`; it is not minified.
- `hooks/vendor/yaml.js` and `hooks/vendor/i18next.js` are the npm packages (versions pinned in `bun.lock`), minified.
- The plugin's own code uses no `Proxy`, `eval` or `new Function`.
