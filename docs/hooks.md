# Hooks

[← README](../README.md) · [日本語](ja/hooks.md)

What runs on each event. In managed environments and Cowork a Go binary does the same work (see [Managed environments](managed-environments.md)).

| Event | What it does |
| --- | --- |
| SessionStart | On a new session and on `/clear`, clears this session's gate state (kept on resume / compact). Then runs the [`session_start`](gate.md#session_start) commands of `gate.yaml` |
| UserPromptSubmit | Adds the shared rules file and the confirmed rules (`count >= 3`) to the context |
| PreToolUse (Bash / Edit / Write / MultiEdit) | Evaluates `pre_bash` / `pre_edit` and denies, asks or warns according to `count` |
| PostToolUse (Read) | Adds the confirmed rules whose `files` match the file that was read |
| PostToolUse (Edit / Write / MultiEdit / Bash) | Records the changed files, evaluates `post_edit`, and runs the matching `rules` of `gate.yaml` |
| PreToolUse (Agent / SendMessage) | Only with [`agentLaunchGuard`](settings.md#agent-launch-guard): shows the text to be sent and asks |
| Notification | Desktop notification when Claude waits for you |
| Stop | Runs, in order: the gate's stop-time checks, `stop_check`, [`stop_review`](gate.md#stop_review), the "done" notification |
| SubagentStop | The same checks for a subagent; the result is handed to the caller |
| PostToolUse (Agent) | Adds a finished subagent's check results to the caller's context |

When Claude tries to create a new rule (a new `*.md` in a feedback directory), the first attempt is stopped and the existing rules are listed, so that a rule about the same correction is updated instead of duplicated.

## Files written by Bash

A file written with Bash instead of Edit / Write gets the same checks.

| How it is written | When it is checked |
| --- | --- |
| A heredoc whose target and body are in the command text (`cat > path <<'EOF'`, `tee path <<EOF`, ...) | Before it runs, with `pre_edit` (like Write) |
| Anything else (`python`, `sed -i`, a heredoc whose target is only known at run time, ...) | After it runs, with `post_edit` and `pre_edit` |

- After the command has run the write already happened, so a deny or ask becomes "blocked until fixed".
- The files picked up afterwards are those git sees as changed or untracked and whose modification time is at or after the start of the command. Ignored files and files outside the working tree are not checked.
- Read-only commands (`ls`, `cat`, `grep`, `git log`, ...) and git history operations (rebase / checkout / merge, ...) are not checked. An unknown command is treated as one that may write.

## File-scoped rules

<a id="file-scoped-rules"></a>A rule that only matters for one language or kind of file can carry `files` in its frontmatter. It is then injected only when such a file is touched.

```yaml
files: ['**/*.go']
exclude_files: ['**/*_test.go']   # optional
```

- It is not added to every prompt. It is added right after a matching file is read or edited, once per rule per turn.
- The rule's `pre_edit` / `post_edit` entries use `files` when they have no `path`.
- `expires` / `projects` / `when_exists` still decide separately whether the rule is active.
- Codex has no `Read` tool, so there the rule arrives only on an edit.

## Several sessions in one working tree

The Bash change detection only sees modification times, so it cannot tell a file another session wrote in the same working tree from its own. To reduce mix-ups:

- No detection runs for read-only commands.
- A file another session already holds as its own change is not recorded.

If two sessions edit at the same time, give them separate worktrees (`.claude/worktrees/<name>`).

## Results of subagents

<a id="results-of-subagents"></a>The gate and `stop_check` results from a subagent's stop are added to the result of the caller's `Agent` call, so the caller does not have to read logs or run the checks again.

```
[feedback-gate] Results of the hooks run when subagent code-implementer (a1b2c3) stopped (gate checks and feedback stop_check). ...
[gate] All checks passed: lint ✓ / typecheck ✓ / test ✓
```

The results of a subagent started in the background are not handed over.

The overall flow is shown in the [sequence diagram in the README](../README.md#how-it-flows).
