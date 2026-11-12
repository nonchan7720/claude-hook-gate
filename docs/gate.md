# gate.yaml phases and behavior

[← README](../README.md) · [日本語](ja/gate.md)

When each phase of `gate.yaml` runs and what a failure does. Every key is listed in [`skills/gate/reference.md`](../skills/gate/reference.md) and [`scripts/gate.schema.json`](../scripts/gate.schema.json).

| Key | Runs | On failure |
| --- | --- | --- |
| `rules` | Right after a file is edited; every rule whose `match` hits | The turn goes on. Rerun when Claude stops; a rule that still fails blocks the stop |
| `consistency_checks` | When Claude stops; only the ones a matched rule named in `run_checks` | Claude cannot stop until it is fixed (gives up after 5 in a row) |
| `session_start` | When a session starts | The session is not stopped |
| `stop_review` | When Claude stops, after the checks above passed | (Runs no command; asks for one review) |

Commands get the files concerned in the environment variable `CLAUDE_GATE_FILES` (for example `rubocop $CLAUDE_GATE_FILES`). The default timeout is 300 seconds.

## When something fails

- **After an edit (`rules`).** The result only goes back to Claude as feedback; the turn continues. The failed files are remembered and the rule is rerun, on the current content, when Claude stops. If it still fails the stop is blocked, so a lint failure cannot be left behind.
- **On stop.** The failed commands and their log paths are returned as the reason and Claude fixes them. After 5 blocks in a row it gives up.
- **Output stays in the log.** The feedback carries no command output, only a `[gate] fail: ...` line and the log path (`.claude/.gate-status/logs/...`), to keep the conversation small.

## Success report

When at least one command ran on stop and all of them passed, the stop is blocked once with a summary:

```
[gate] All checks passed: lint ✓ / typecheck ✓ / test ✓. Report this result to the user and finish.
```

Claude then reports and stops. Put `report_success: false` at the top level of `gate.yaml` to turn it off.

## session_start

Runs commands when a session starts and adds their stdout to the context (a code-graph summary, for example). Main session only.

```yaml
session_start:
  - name: depgraph
    cmd: "command -v depgraph >/dev/null || exit 0; depgraph hook session-start --format text"
    timeout: 10                             # seconds; default 10, at most 600
    on: [startup, resume, clear, compact]   # default: all
    background: false                       # true: start it and do not wait
```

- The commands run in parallel. The output of each one that exits 0 is added in declaration order under `[gate] session_start: <name>`. The total is capped at 8 KiB.
- A failure or timeout does not stop the session; the exit status and log path are reported once.
- The output of a `background: true` command goes to the log only, not into the context.
- Commands get `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID` and `CLAUDE_SESSION_SOURCE`.

## stop_review

Right before stopping, Claude reviews the files it changed. Off by default.

```yaml
stop_review: true          # enabled with all defaults
# or
stop_review:
  effort: xhigh            # low / medium / high / xhigh / max; false leaves the effort alone
  match: ['src/**', '**/*.go']   # changed files to review (default: all)
  max_rounds: 1            # how often fixes made during a review are reviewed again (at most 5)
  subagents: true          # also when a subagent stops
  prompt: |                # project-specific things to check (at most 2000 characters)
    When you add a migration, check the down migration too.
```

- **When.** On stop, after the gate and `stop_check` passed, and only if files were changed since the last review. A turn that only answered a question is not touched.
- **What it asks for.** It blocks the stop once and returns the list of changed files and the steps: re-read the diff from the real files; check that the request is met, the logic, tests and docs that were not updated, leftover changes, and whether it was actually run; then fix, or report briefly what was checked and stop.
- **Switching the effort.** A hook cannot change the effort itself, so the first step has Claude invoke the bundled skill [`effort-<level>`](commands-and-skills.md#feedback-gateeffort-level). It lasts for the rest of that turn. When Claude does not invoke it, or where a skill's `effort` is not honored (Codex, for example), the effort stays as it was and only the review happens.
- **No loop.** Fixes made during a review are reviewed again at most `max_rounds` times. With the default of 1 there is one review per turn.
- **Untrusted repositories.** `max_rounds` is capped at 5 and `prompt` at 2000 characters. `prompt` is printed under a heading that names `gate.yaml` as its source.

## Sharing runs between agents

When the main agent and subagents want to run the same command at the same time, a heavy command does not run once per agent.

| Situation | What happens |
| --- | --- |
| The same command (same place, same environment) is running and its files include yours | It is not started again; you get its result |
| A command with the same `name` is running but its result cannot be taken | You wait for it to finish, then run (shown as `waiting`) |
| Several agents wait for the same `name` | Their files are combined into one run, and all of them get that result |

- At most `max_parallel` (default 2) gate commands run at once in the whole project, including other worktrees of the same repository.
- In a combined run, a failure in another agent's file is a failure for everyone who took the result.
- Finished results are never reused; only overlapping runs are merged.

```yaml
max_parallel: 2            # false: no limit

rules:
  - match: ['**/*.go']
    run:
      - { cmd: "go test ./...", name: test, files: false }   # runs the whole project whatever the file list
      - { cmd: "bun test", name: unit, share: false }        # never shared, never waits
```

- `files: false`: shared even when the file lists differ.
- `share: false`: never shared; always runs at once.
