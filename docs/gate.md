# gate.yaml phases and behavior

[← README](../README.md) · [日本語](ja/gate.md)

## session_start

<a id="session_start"></a>A third phase of `gate.yaml`, `session_start`, runs commands on SessionStart (main session only; a payload with an `agent_id` is skipped) and adds their stdout to the session context (`additionalContext`), e.g. to load a code-graph summary. It runs after the reset step.

```yaml
session_start:
  - name: depgraph
    cmd: "command -v depgraph >/dev/null || exit 0; depgraph hook session-start --format text"
    timeout: 10                        # seconds, default 10 (not 300)
    on: [startup, resume, clear, compact]   # optional; default: every source
    background: false                  # optional; true = start and do not wait
```

- `on` filters by the `source` of the SessionStart payload; the source is passed as `CLAUDE_SESSION_SOURCE`. Unknown values never match. A plain string item is shorthand for `{cmd: ...}`.
- Environment: `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID`, `CLAUDE_SESSION_SOURCE`, `CLAUDE_GATE_FILES` (empty); `CLAUDE_AGENT_ID` is unset.
- Commands run in parallel, bounded by `max_parallel`. The stdout of each command that exits 0 is joined in declaration order under a header `[gate] session_start: <name>`; empty output injects nothing. The output is plain text, or a SessionStart hook JSON object, from which only `hookSpecificOutput.additionalContext` is taken (a JSON object without a non-empty one injects nothing; a top-level `systemMessage` in it is shown to the user). The total is capped at 8 KiB (8192 characters), with a note when truncated.
- A failing or timed-out command never blocks the session: it is reported with its exit status and log path (`.claude/.gate-status/logs/<session>/<name>.<id>.log`) once on stderr and as a top-level `systemMessage` of the hook output (Claude Code does not show the stderr of an exit-0 hook), the hook still exits 0, and the other commands still run. A `timeout` above 600 is capped to 600; the SessionStart hook itself waits at most 600 s (`timeout: 600` in `hooks/hooks.json`) for the whole phase.
- `background: true` starts the command detached (output goes to the log only, nothing is injected) and the hook does not wait for it.
- No policy and no sharing: these commands are not deferred by dogwood and not shared between agents, because their output is needed now. Only the project root's `gate.yaml` is read.

## stop_review

<a id="stop_review"></a>Having the model check its own result improves accuracy, so this setting forces one "review what you changed" step right before stopping. It is off by default and only runs in projects whose `gate.yaml` enables it.

```yaml
stop_review: true          # enabled with all defaults
# or
stop_review:
  effort: xhigh            # low / medium / high / xhigh / max. Default xhigh. false leaves the effort alone
  match: ['src/**', '**/*.go']   # changed files to review (default: all)
  max_rounds: 1            # how many times in a row the fixes made during a review are reviewed again (default 1, at most 5)
  subagents: true          # also on SubagentStop (default true)
  prompt: |                # project-specific things to check, appended to the instructions
    When you add a migration, check the down migration too.
```

- **When.** On Stop / SubagentStop, after the gate `checks` phase and the feedback `stop_check` passed (not on a stop one of them blocked), and only when this session (or, for a subagent, that agent) changed files since the last review. A turn that changed nothing (answering a question) is not touched.
- **What it returns.** It blocks the stop once (`decision: block`) with these steps as the reason: first invoke `feedback-gate:effort-<effort>` with the Skill tool to switch the effort of the rest of the turn; re-read the diff of the changed files and the code around it from the real files; check that the request is fully met, logic and edge cases, callers / tests / docs that were not updated, leftover changes nobody asked for, and whether what can be run was run; fix what is found, or else report in 1-3 lines what was checked and stop. The list of changed files (up to 30) and `prompt` follow.
- **Switching the effort.** Hook output has no way to change the session's effort, so the bundled skills ([`/feedback-gate:effort-<level>`](commands-and-skills.md#feedback-gateeffort-level)) do it through their `effort` frontmatter. It lasts for the rest of the review turn only; the session setting is unchanged. The model is the one that invokes the skill, so when it does not, or where a skill's `effort` is not honored (Codex, for example), the effort stays as it was and only the review happens.
- **The list of changed files.** Files are added to `.claude/.gate-status/review_pending.<session>[--<agent>].txt` at the same moments as `changed_files` (Edit / Write / MultiEdit, and the files a Bash command rewrote). Unlike `changed_files` it is not emptied when the gate passes; it is emptied when a review is issued.
- **No loop.** Fixes made during the review are added to the list too, so the next Stop would ask for another review. That stops after `max_rounds` rounds (`review_rounds.<session>[--<agent>].txt`). With the default of 1 there is one review per turn, and its fixes go through (still checked by the gate and `stop_check`) without another review. The counter returns to 0 on a Stop with nothing to review and on the Stop that hit the limit. It only counts while the stop is continuing from a hook block (`stop_hook_active`), so a counter left behind by an interrupted turn does not make the next turn's Stop skip its review.
- **Limits.** `gate.yaml` is repository content, so an untrusted repository must not be able to hold the stop indefinitely or push long text into the conversation: `max_rounds` is at most 5 (a larger value counts as 5), `prompt` is at most 2000 characters (the rest is cut) and is printed under the heading "Project-specific checks (from stop_review.prompt in gate.yaml)". Each changed file path is cut at 300 characters, and a path containing a line break is left out of the list. An invalid `match` glob makes every changed file count.
- The state files are removed by `reset-gate` on SessionStart like the others (`startup` / `clear`, or older than 24 hours). The Stop that finally goes through after a review sends the `stop` notification.

## Sharing runs between agents

When several agents (the main session and subagents) run the same command at the same time, the gate starts it once. A command is the same when the root, the cwd, the `cmd` and the environment passed to it all match; the variable that identifies the agent (`CLAUDE_AGENT_ID`) and the list of target files (`CLAUDE_GATE_FILES`) are ignored. The file list is handled separately because it can differ per agent. The agent that comes later looks at the runs in progress under the same conditions: if one of them targets every file of its own list (an empty list is contained in any), it does not start the command again but waits for that run and receives the same result (exit status, output, timeout). The result is then handled as if that agent had run it itself: it is recorded in its own trace and log directory, it consumes a deferred entry with the same key, and it counts for its phase result. A finished run is never reused; only overlapping runs are merged. Coordination goes through files under `.claude/.gate-status/shared/` (a lock directory per command and file list), because the hooks of different agents are not guaranteed to run in the same process.

When there is no run it can receive (its files are not covered, or the environment, root or cwd differ), the same command still runs only once at a time. The unit is the `name` (or the `cmd` when there is no name): while it is running in another agent, the gate does not start it but waits for that run to end, then looks again for a run to receive or runs it itself (the band shows it as waiting meanwhile). Running a heavy command such as `go test ./...` once per agent at the same time makes every run several times slower as they fight over the CPU. Different commands given the same `name` also run one at a time. This also holds between agents working in different git worktrees of the same repository: the locks live in `~/.claude/.gate-status/shared/<project_id>/`, where the project id is derived from the repository's common git directory (results are still received only within the same worktree, since the root and cwd differ). Whether a lock is alive is decided by the command's process: if the hook is stopped (for example with ESC) and leaves its lock behind, the next agent takes it over as soon as the command has exited, and waits for the command while it is still running. A lock is also treated as dead once the command's `timeout` has passed. A command with `share: false` is neither shared nor serialized; it always starts at once.

Two more things keep that waiting short when many agents stop at about the same time. First, the file lists of the agents waiting for a run with the same `name` are batched: while it waits, each agent leaves its key and file list under `<serial>.queue/`, and the next agent to start that command runs it once on the union of its own files and theirs (`CLAUDE_GATE_FILES` carries the union), so all of them receive that one result instead of running one after the other. Such a run covers files of other agents too; a failure in those files fails every agent that receives it, exactly as with a received superset run. Second, `max_parallel` at the top level of `gate.yaml` caps how many gate commands run at the same time across all agents and worktrees of the project (default `2`; `false` for no cap). An agent about to start a command first takes one of the `slot.<i>/` directories under the shared directory and waits for a free one otherwise; receiving a shared result needs no slot. The cap also applies inside a `parallel` block and to `share: false` commands. With ten subagents and whole-project tests, it keeps each run close to its standalone duration instead of all of them crawling (and timing out) together:

```yaml
max_parallel: 2   # default; false for no cap
rules:
  - ...
```

To opt a command out of sharing (and serializing), set `share: false` on its `run` element (`{cmd, name, timeout, share, files}`):

```yaml
run:
  - { cmd: "bun test", name: test, share: false }
```

A command that does not use the target files (such as `go test ./...`, which runs everything regardless of the list) can set `files: false`. Its file list is then treated as empty when deciding whether to share, so it is shared even when the agents changed different files. `CLAUDE_GATE_FILES` is still passed to the command as before. When combined with `share: false`, `share: false` wins and nothing is shared.

```yaml
run:
  - cmd: go test ./...
    name: test
    files: false
```

## Failures left unfixed

A failed rule in the `rules` phase (PostToolUse) does not stop the turn: the result goes back to Claude as feedback. To keep the transcript small, that feedback does not carry the command output: it has one line per command (`[gate] ok: ...` / `[gate] fail: ...`) and, for each failed command, its heading, the timeout message if any and the log path (`[gate] log: .claude/.gate-status/logs/<state>/<name>.<id>.log`), with an instruction to open the log and fix the errors. The full output is only in that log, which is removed by the usual log cleanup (logs of the current session after 1 hour, logs of other sessions 5 minutes after their last write). The `checks` phase (Stop / SubagentStop) does the same: its block reason lists the failed commands with their log paths, not their output. The failed files are also kept in `.claude/.gate-status/gate_failed.<state>.txt`, and the next `checks` phase (Stop / SubagentStop) reruns their rules on the current contents before anything else. If a rule still fails, the stop is blocked like a failed consistency check (and no success report is given); once it passes, the file is handled as if the `rules` phase had passed. So a lint failure cannot be left behind by simply finishing the turn. After `MAX_ATTEMPTS` (5) blocked stops in a row, the gate gives up: the failures are dropped (the files stay in the changed list, so the next edit checks them again).

## Success report

When the `checks` phase (Stop / SubagentStop) actually ran at least one command and all of them passed, the gate blocks the stop once and returns a summary as the reason, e.g. `[gate] All checks passed: lint ✓ / typecheck ✓ / test ✓. Report this result to the user and finish.`, so the agent can report the result and finish instead of waiting for you to say it passed. The stop right after such a report (`stop_hook_active`) runs no gate command and passes. Nothing is reported when no command ran, when `stop_hook_active` is true (a continuation after a failure block), or when it is turned off with a top-level `report_success: false` in `{.claude,.agents}/gate.yaml` (default: on). Failures block as before.
