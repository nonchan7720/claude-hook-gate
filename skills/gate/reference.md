# `.claude/gate.yaml` field reference

Condensed from `scripts/gate.schema.json` (read the schema for the authoritative text).
Unknown keys are invalid everywhere (`additionalProperties: false`).

## Top level

| Key | Type | Meaning |
| --- | --- | --- |
| `rules` | list of rule, **required** | Evaluated on PostToolUse. All rules whose `match` hits a changed file run (no early exit). Failure does not block the turn; the failed files are rerun in the next checks phase, and a still-failing rule then blocks the stop. |
| `consistency_checks` | list of check | Named checks for the Stop / SubagentStop phase. Not run on their own: only the names a matched rule listed in `run_checks` are reserved. Failure blocks the stop. |
| `report_success` | boolean, default `true` | When the checks phase actually ran at least one command and all passed, block the stop once with a summary so the agent reports it and finishes. `false` turns the report off. |
| `policy` | path or `false` | dogwood policy (`.dw`) applied to every command before it runs. Omitted → the bundled default (same `name` at most once per 2 minutes; paused after 3 failures within 10 minutes). `false` → run every time. Relative to the project / worktree root; `~` and absolute paths allowed. Needs the optional `dogwood` binary; without it the default policy runs every time and a custom policy defers the commands. |
| `policy_schema` | path | Cedar schema for `policy`. Default: the bundled `scripts/dogwood/gate.cedarschema`. |

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

## run item

Either a command or `{ parallel: [command, ...] }`. `parallel` cannot nest. A command is a
string or a mapping:

| Key | Type | Meaning |
| --- | --- | --- |
| `cmd` | string, **required** | Run with `sh -c`. |
| `name` | string | Label in the band, the status line and the log file name. Also the serialization unit between agents: two commands with the same `name` never run at the same time (without `name`, `cmd` is the unit). |
| `timeout` | integer seconds | Overrides the rule / check timeout. Precedence: command > rule / check > 300. On expiry the process group is killed and the command fails. |
| `share` | boolean, default `true` | When another agent is already running the same command (same root, cwd, `cmd`, environment) on a superset of this agent's files, wait for it and reuse its result instead of starting again; otherwise wait for a run with the same `name` to finish before starting. `false`: always start at once, never serialize. |
| `files` | boolean, default `true` | `false` declares that the command does not use `CLAUDE_GATE_FILES`, so sharing ignores the file list (whole-project commands). The variable is still passed. `share: false` wins over `files: false`. |

## Environment of a command

| Variable | Value |
| --- | --- |
| `CLAUDE_GATE_FILES` | The matched files for this run: project-root-relative paths, shell-quoted, deduplicated, sorted, separated by spaces. Root-relative even when `dir` / `per_file_dir` moved the cwd. `cmd $CLAUDE_GATE_FILES` when paths have no spaces; `eval "set -- $CLAUDE_GATE_FILES"` otherwise. With `per_file_dir`, only the files of that root. |
| `CLAUDE_PROJECT_DIR` | Absolute path of the project (worktree) root. |
| `CLAUDE_SESSION_ID` | The session. |
| `CLAUDE_AGENT_ID` | The agent (subagents), when known. |

Plus the user's environment. Output goes to `.claude/.gate-status/logs/<state>/<name>.<id>.log`.

## Runtime behaviour worth knowing when designing

- Changed files are recorded per session and matched as project-root-relative paths;
  files in `.claude/worktrees/<name>/` are matched relative to that worktree.
- The gate itself never edits files. A failed rule returns the command output to Claude.
- After 5 blocked stops in a row the gate gives up on those failures (the files stay
  tracked and are rechecked on the next edit).
- Several agents of one session share the band; identical runs are merged (see `share`).
- Git history and working-tree operations (`checkout`, `rebase`, `merge`, ...) are not
  treated as edits and record nothing.
