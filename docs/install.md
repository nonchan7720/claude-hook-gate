# Install

[← README](../README.md) · [日本語](ja/install.md)

## Claude Code

```
/plugin marketplace add nonchan7720/claude-hook-gate
/plugin install feedback-gate@claude-hook-gate
```

The first line adds this repository as a marketplace and the second installs the plugin from it. Then choose the scope.

## Codex

```
gh api repos/nonchan7720/claude-hook-gate/contents/plugins/codex/scripts/setup.sh -H "Accept: application/vnd.github.raw" | bash
```

This one line installs the plugin and the hooks. Then start Codex and trust the hooks in `/hooks`. Updating, what to do when the hooks do not run, and the differences from Claude Code are in the [Codex plugin README](../plugins/codex/README.md).

- Rules and `gate.yaml` are shared with Claude Code. Codex looks in `.agents/` first, then `.claude/`.
- The Codex sandbox stops writes to `.agents/` and `.codex/`, so rules that Codex should maintain go under `.claude/`.
- Where the organization allows managed hooks only, the setup command guides you to install into the managed layer (`/etc/codex/hooks.json`).

## Claude Cowork

In Cowork, add `nonchan7720/claude-hook-gate` under **Customize → Plugins → Add marketplace** and install `feedback-gate`. The checks are done by the Go binary (the same path as [managed environments](managed-environments.md)). The differences from Claude Code:

| Item | In Cowork |
| --- | --- |
| `/correct`, `/hook-list` | Not available. Use the skills `/feedback-gate:feedback` and `/feedback-gate:hook-list` |
| Plugin settings | Not asked for, so the defaults apply. The language comes from `FEEDBACK_GATE_LANG` or the OS language |
| The binary | Downloaded from the GitHub release on first use. Needs `bash`, `curl` or `wget`, `tar`, `sha256sum` or `shasum`, and HTTPS to `github.com` and `release-assets.githubusercontent.com` |
| Windows | The hooks do not run for now |
| Project rules and `gate.yaml` | Cowork stops writes under `.claude/`, so put them in `<project>/.agents/feedback/` and `<project>/.agents/gate.yaml` |
| Global rules | `~/.claude/feedback/` is outside the folder Cowork works in; copy the rules there yourself |

There is no official list of the events Cowork fires. After installing, check that a confirmed rule is injected and that the gate runs after an edit.

## Requirements

Claude Code needs nothing else installed.

| Tool | Needed for |
| --- | --- |
| `bash`, `curl` or `wget`, `tar`, `sha256sum` or `shasum` | Downloading the binary once per version, in managed environments and Cowork |
| `terminal-notifier` | Desktop notifications on macOS |
| `dogwood` | Deciding whether each gate command runs now or is deferred (optional) |

Install `dogwood` with `cargo install --git https://github.com/dogwood-policy/dogwood amzn-dogwood-cli`. It is looked up in `DOGWOOD_BIN`, `PATH`, `~/.cargo/bin/dogwood` and the mise shim, in that order. Without it, commands under the default policy run every time, and commands with their own `policy:` are deferred.
