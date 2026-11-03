# `.claude/gate.yaml` field reference

Condensed from `scripts/gate.schema.json` (read the schema for the authoritative text).
Unknown keys are invalid everywhere (`additionalProperties: false`).

## Top level

| Key | Type | Meaning |
| --- | --- | --- |
| `rules` | list of rule (the normal entry point; may be omitted when the project only needs `session_start`) | Evaluated on PostToolUse. All rules whose `match` hits a changed file run (no early exit). Failure does not block the turn; the failed files are rerun in the next checks phase, and a still-failing rule then blocks the stop. |
| `consistency_checks` | list of check | Named checks for the Stop / SubagentStop phase. Not run on their own: only the names a matched rule listed in `run_checks` are reserved. Failure blocks the stop. |
| `session_start` | list of session_start command | Commands run on SessionStart whose stdout is added to the session context. See below. |
| `report_success` | boolean, default `true` | When the checks phase actually ran at least one command and all passed, block the stop once with a summary so the agent reports it and finishes. `false` turns the report off. |
| `policy` | path or `false` | dogwood policy (`.dw`) applied to every command before it runs. Omitted → the bundled default (same `name` at most once per 2 minutes; paused after 3 failures within 10 minutes). `false` → run every time. Relative to the project / worktree root; `~` and absolute paths allowed. Needs the optional `dogwood` binary; without it the default policy runs every time and a custom policy defers the commands. |
| `policy_schema` | path | Cedar schema for `policy`. Default: the bundled `scripts/dogwood/gate.cedarschema`. |
| `max_parallel` | integer >= 1 or `false`, default `2` | How many gate commands may run at the same time across all agents and worktrees of the project (one slot per running command; receiving a shared result needs none). Applies inside `parallel` blocks and to `share: false` commands too. `false` removes the cap. Keeps many subagents from running whole-project tests all at once and slowing each other down. |

## rule

| Key | Type | Meaning |
| --- | --- | --- |
| `match` | glob or list of globs, **required** | Project-root-relative paths of changed files. `*` does not cross `/`, `**` does, `{a,b}` expands. |
| `run` | list of run items, **required** | Executed in order; the first non-zero exit fails the rule (a `parallel` block waits for all its commands). |
| `run_checks` | list of names | `consistency_checks` to reserve for the stop phase when this rule matched. Each name runs once per checks phase however many rules reference it. A rule without `run_checks` stops tracking its files once they pass. |
| `dir` | string | Working directory for `run`, root-relative, no leading `/` and no `..`. Default: the project root. Ignored when `per_file_dir` is set. |
| `per_file_dir` | `true` / `"file"` / `"pattern_root"` | Run once per root derived from each matched file, roots deduplicated and sorted. `file` (= `true`): the file's own directory (one directory = one package: Go, Terraform). `pattern_root`: the real path up to the first `**` segment of the matching pattern (`packages/*/src/**/*.ts` → `packages/<pkg>`; workspaces). |
| `timeout` | integer seconds | Default for the rule's commands (default 300). |
| `policy`, `policy_schema` | as top level | Override for this rule only. |

## consistency check

| Key | Type | Meaning |
| --- | --- | --- |
| `name` | string, **required** | Unique; referenced by `run_checks`. |
| `run` | list of run items, **required** | As in a rule. |
| `dir` | string | As in a rule. |
| `timeout` | integer seconds | As in a rule. |
| `policy`, `policy_schema` | | Override for this check only. |

## session_start command

Run on SessionStart of the main session (skipped for subagents). A string item is shorthand
for `{ cmd: <string> }`. `parallel` is not used here: every item already runs in parallel
(bounded by `max_parallel`). No policy, no run sharing. Only the project root's gate.yaml
is read. The output is added after the reset step.

| Key | Type | Meaning |
| --- | --- | --- |
| `cmd` | string, **required** | Run with `sh -c` in the project root. Stdout of a command that exits 0 is injected, labelled `[gate] session_start: <name>`, in declaration order; all output together is capped at 8 KiB (a truncation note is appended). Output is plain text, or a SessionStart hook JSON object of which only `hookSpecificOutput.additionalContext` is taken (no usable one: nothing injected; a top-level `systemMessage` is shown to the user). |
| `name` | string | Label and log file name. Default: derived from `cmd`. |
| `timeout` | integer seconds | Default 10 (not 300); a value above 600 is capped to 600 (the SessionStart hook waits at most 600 s for the whole phase). On expiry the process group is killed. |
| `on` | string or list | Only for these SessionStart sources (`startup`, `resume`, `clear`, `compact`). Default: all. Unknown values never match. |
| `background` | boolean, default `false` | Start the command detached and do not wait; its output goes to the log only and is not injected. |

A failing or timed-out command never blocks the session: it is reported once on stderr
with its exit status and log path (on stderr and as a `systemMessage` shown to the user), the hook exits 0, and the others still run.

## run item

Either a command or `{ parallel: [command, ...] }`. `parallel` cannot nest. A command is a
string or a mapping:

| Key | Type | Meaning |
| --- | --- | --- |
| `cmd` | string, **required** | Run with `sh -c`. |
| `name` | string | Label in the band, the status line and the log file name. Also the serialization unit between agents: two commands with the same `name` never run at the same time (without `name`, `cmd` is the unit). |
| `timeout` | integer seconds | Overrides the rule / check timeout. Precedence: command > rule / check > 300. On expiry the process group is killed and the command fails. |
| `share` | boolean, default `true` | When another agent is already running the same command (same root, cwd, `cmd`, environment) on a superset of this agent's files, wait for it and reuse its result instead of starting again; otherwise wait for a run with the same `name` to finish before starting; the file lists of the agents waiting for it are batched into that next run (one run on the union of their files, received by all of them). `false`: always start at once, never serialize (the `max_parallel` cap still applies). |
| `files` | boolean, default `true` | `false` declares that the command does not use `CLAUDE_GATE_FILES`, so sharing ignores the file list (whole-project commands). The variable is still passed. `share: false` wins over `files: false`. |

## Environment of a command

| Variable | Value |
| --- | --- |
| `CLAUDE_GATE_FILES` | The matched files for this run: project-root-relative paths, shell-quoted, deduplicated, sorted, separated by spaces. Root-relative even when `dir` / `per_file_dir` moved the cwd. `cmd $CLAUDE_GATE_FILES` when paths have no spaces; `eval "set -- $CLAUDE_GATE_FILES"` otherwise. With `per_file_dir`, only the files of that root. |
| `CLAUDE_PROJECT_DIR` | Absolute path of the project (worktree) root. |
| `CLAUDE_SESSION_ID` | The session. |
| `CLAUDE_AGENT_ID` | The agent (subagents), when known. Unset in `session_start`. |
| `CLAUDE_SESSION_SOURCE` | `session_start` only: the SessionStart source (`startup`, `resume`, `clear` or `compact`). In `session_start`, `CLAUDE_GATE_FILES` is empty. |

Plus the user's environment. Output goes to `.claude/.gate-status/logs/<state>/<name>.<id>.log`.

## Runtime behaviour worth knowing when designing

- Changed files are recorded per session and matched as project-root-relative paths;
  files in `.claude/worktrees/<name>/` are matched relative to that worktree.
- The gate itself never edits files. A failed rule returns the command output to Claude.
- After 5 blocked stops in a row the gate gives up on those failures (the files stay
  tracked and are rechecked on the next edit).
- Several agents of one session share the band; identical runs are merged (see `share`),
  waiting agents' file lists are batched into the next run, and at most `max_parallel`
  commands run at once across the whole project.
- Git history and working-tree operations (`checkout`, `rebase`, `merge`, ...) are not
  treated as edits and record nothing.
