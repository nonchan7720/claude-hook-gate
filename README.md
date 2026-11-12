# feedback-gate

[日本語](README_ja.md)

A Claude Code plugin that keeps Claude from repeating a mistake you already corrected, and from finishing before the checks pass.

- **Feedback rules**: a correction you gave once is kept as a Markdown rule and injected into every prompt. A hook stops the commands and edits that break it.
- **Quality gate**: the lint and tests you list in the project's `gate.yaml` run after each edit and when Claude stops. Claude cannot stop while they fail.
- **Review before stopping** (optional): before stopping, Claude reviews the files it changed, at a higher effort.
- **Notifications**: a desktop notification when Claude waits for you and when it is done (macOS).

Besides Claude Code it runs in [Codex](plugins/codex/README.md) and Claude Cowork, with the same rules and the same `gate.yaml`.

## Install

```
/plugin marketplace add nonchan7720/claude-hook-gate
/plugin install feedback-gate@claude-hook-gate
```

Installing it blocks nothing. It starts working once you add rules and a `gate.yaml`.

## Getting started

### 1. Give the project a quality gate

```
/feedback-gate:gate init
```

This reads the project's language, task runner and CI, writes `.claude/gate.yaml`, and runs each command once to check it. Written by hand it looks like this:

```yaml
# .claude/gate.yaml
rules:                      # run right after a file is edited
  - match: ['src/**/*.ts']
    run:
      - name: lint
        cmd: bun run lint
    run_checks: [verify]    # reserve a check for when Claude stops

consistency_checks:         # run on Stop / SubagentStop; a failure blocks the stop
  - name: verify
    run:
      - name: test
        cmd: bun run test

stop_review: true           # optional: review the changes before stopping
```

State files are written to `.claude/.gate-status/`; add it to `.gitignore`.

### 2. Turn a correction into a rule

After correcting Claude, ask for:

```
/feedback-gate:feedback create
```

It turns the correction into a general rule and saves it in `~/.claude/feedback/` (all projects) or `<project>/.claude/feedback/` (that project only). A rule is a file like this:

```markdown
---
name: no_force_push
description: Never force-push; rewrite history only when the user asks for it.
type: feedback
count: 3
enforce:
  - event: pre_bash
    when: 'git\s+push\b.*(\s--force\b|\s-f\b)'
    message: 'Do not force-push. Push a new commit, or ask the user first.'
---

Do not force-push a branch. Add commits instead.
```

`count` sets how strongly the rule is enforced. It goes up by 1 each time a violation is detected (once per session, up to 5).

| count | Injected into prompts | Before a command or edit | After an edit, on stop |
| --- | --- | --- | --- |
| 1-2 (provisional) | no | warn | warn |
| 3-4 (confirmed) | yes | ask | block |
| 5 or more | yes | deny | block |

`enforce` has four events: `pre_bash` (before a command runs), `pre_edit` (before a write), `post_edit` (the whole file after an edit) and `stop_check` (the changed files on stop). The format and examples are in [`skills/feedback/reference.md`](skills/feedback/reference.md) and [`examples.md`](skills/feedback/examples.md).

## What you see while it runs

- While gate commands run, a `[gate] running:` list appears above the prompt. When they finish, `[gate] done: ✓ 5 / ✗ 1 (81.0s)` stays in the status line.
- When the gate fails, Claude gets the failure and keeps fixing (it gives up after 5 failures in a row). When everything passes, Claude gets a summary and then stops.
- When a rule is broken, the call is warned about, asked about or denied according to `count`, and the rule's `message` goes back to Claude as the reason.
- With `stop_review` enabled, a `[stop-review]` instruction appears once right before stopping, and Claude reviews its changes before it stops.

## Commands and skills

| Invoke | Use |
| --- | --- |
| `/feedback-gate:gate [init\|update\|review]` | Create or update `gate.yaml`, or report how it differs from CI |
| `/feedback-gate:feedback [create\|update\|review]` | Create, update or audit rules |
| `/correct [--window 30d] [--min 2] [apply]` | Count the violation log and propose raising `count` or adding `enforce` |
| `/hook-list` | Show in the browser what runs in this project, and when |
| `/feedback-gate:effort-<level>` | Switch the effort of the rest of the turn (used by `stop_review`) |

Details: [Commands and skills](docs/commands-and-skills.md).

## Settings

Set them on the `/plugin` install screen, or later in `/config`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `language` | `auto` | Language of the messages (`ja` / `en`; `auto` follows the OS) |
| `autoCount` | `true` | Raise a rule's `count` by 1 when a violation is detected |
| `agentLaunchGuard` | `false` | Show the prompt and ask before sending instructions to a subagent |
| `rulesFile` | `~/.claude/feedback-gate/feedback_rules.md` | Replace the shared rules file that is injected into every prompt |

Details: [Settings](docs/settings.md).

## Where it runs

- **Claude Code**: nothing else to install.
- **Managed Claude Code (Team / Enterprise) and Claude Cowork**: the plugin's function hooks do not run there, so a Go binary, `feedback-gate`, that performs the same checks is downloaded from the GitHub release on first use. It needs `bash` and `curl` or `wget`. See [Managed environments](docs/managed-environments.md) and [Cowork](docs/install.md#claude-cowork).
- **Codex**: see the [Codex plugin README](plugins/codex/README.md).
- **Optional tools**: `terminal-notifier` (notifications on macOS) and `dogwood` (decides whether a gate command runs now). See [Requirements](docs/install.md#requirements).

## Security and permissions

- The plugin itself sends nothing over the network. Data leaves the machine only through the commands you put in `gate.yaml` or in a rule's `check` (in a managed environment it also contacts GitHub to download the binary).
- Its permission decisions are only `deny` and `ask`, never `allow`. It cannot skip your own permission prompts.
- It writes only `<project>/.claude/.gate-status/`, its state files under `~/.claude/feedback/`, and the `count:` line of a rule.
- The commands in `gate.yaml` are run as written. Read the `gate.yaml` of a repository you do not trust before you open it.

The full list of what it reads, runs and writes is in [Security and permissions](docs/security.md).

## Documentation

| Page | Contents |
| --- | --- |
| [Hooks](docs/hooks.md) | What runs on each event, files written by Bash, file-scoped rules, results of subagents |
| [gate.yaml phases and behavior](docs/gate.md) | `session_start`, `stop_review`, sharing runs between agents, failures and the success report |
| [What it reads](docs/files.md) | Where rules and state files live, broken rules, the running display |
| [Commands and skills](docs/commands-and-skills.md) | `/correct`, `/hook-list`, the bundled skills |
| [Settings](docs/settings.md) | Agent launch guard, automatic count increase, language |
| [Install](docs/install.md) | Codex, Claude Cowork, requirements |
| [Managed environments](docs/managed-environments.md) | Settings hooks and the `feedback-gate` binary |
| [Security and permissions](docs/security.md) | What it reads, runs, writes and decides |
| [Development](docs/development.md) | Build, test, release |

Every `gate.yaml` key is in [`scripts/gate.schema.json`](scripts/gate.schema.json) and [`skills/gate/reference.md`](skills/gate/reference.md).

## License

[MIT](LICENSE)
