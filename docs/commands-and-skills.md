# Commands and skills

[← README](../README.md) · [日本語](ja/commands-and-skills.md)

## `/correct`

Counts the rules and the violation log (`~/.claude/feedback/.violations.jsonl`) and proposes how to tighten the rules.

```
/correct [--window 30d] [--min 2] [apply]
```

| Argument | Meaning |
| --- | --- |
| `--window` | The period to count violations over: `Nd` or `Nh` (default `30d`) |
| `--min` | The smallest number of violations that produces a proposal (default `2`) |
| `apply` | Write the `bump` proposals into the rule files. Without it nothing is changed |

It makes five kinds of proposal.

| Proposal | When | What |
| --- | --- | --- |
| `broken` | A rule file cannot be read, or an `enforce` entry is invalid | How to fix it (see [Broken rules](files.md#broken-rules)) |
| `bump` | At least `--min` violations in the period | `count` 1-2 to 3; 3-4 to 5 when asks or blocks keep happening |
| `enforce` | `count >= 3` but no `enforce` | Add `enforce` (with a template) |
| `stale` | Has `enforce` but no violation was ever recorded | Check that it still works and is still needed |
| `expired` | Inactive because of `expires` / `projects` / `when_exists` | Delete or update |

`apply` only rewrites the `count:` line of the rules with a `bump` proposal. Everything else stays a proposal.

## `/hook-list`

Shows in the browser what runs in this project, and when. It changes nothing.

```
/hook-list [--no-open]
```

- **gate.yaml**: the commands of `rules`, `consistency_checks` and `session_start`, and when they run.
- **Rules**: for each active rule its `count`, how it is injected and its `enforce` entries. Inactive and unreadable rules are listed with the reason.
- **Settings**: the current `agentLaunchGuard`, `autoCount` and `language`.

Where no browser can be opened (a remote machine) or with `--no-open`, it only returns the path of the HTML file it wrote.

## Skills

Invoke them as `/feedback-gate:<name>`. Claude may also pick them up from their descriptions.

| Skill | Use |
| --- | --- |
| `/feedback-gate:feedback [create\|update\|review]` | Create, update or audit rules |
| `/feedback-gate:gate [init\|update\|review]` | Create or update `gate.yaml`, or report how it differs from CI |
| `/feedback-gate:hook-list [--no-open]` | The same page as `/hook-list`, for where `/hook-list` is not available (managed environments, Cowork, Codex) |
| `/feedback-gate:effort-<level>` | Switch the effort of the rest of the turn |

### `/feedback-gate:feedback`

- `create`: turns a correction into a general rule, chooses where it goes (all projects or this one) and its `count`, and adds `enforce` only for what a hook can detect. It asks before saving.
- `update`: the same correction came up again (raise `count`), a false positive (narrow the condition instead of deleting), or a change of wording or scope.
- `review`: puts all rules in one table and proposes keep, promote, fix, merge or retire. Deleting and merging are confirmed first.

### `/feedback-gate:gate`

It does not guess commands. It reads what the project really uses (manifests, task runner, CI configuration) and maps that onto `gate.yaml`. What can only run in CI (deploys, steps that need secrets) is left out and reported. Each command is run once before the file is handed over.

### `/feedback-gate:effort-<level>`

Five skills: `effort-low`, `effort-medium`, `effort-high`, `effort-xhigh` and `effort-max`. Each only switches the effort of the rest of the turn that invoked it; the session setting is unchanged. [`stop_review`](gate.md#stop_review) has Claude invoke one. You can use them yourself:

```
/feedback-gate:effort-max find out why this test fails
```

A level the model does not support becomes the highest supported level at or below it. The environment variable `CLAUDE_CODE_EFFORT_LEVEL` takes precedence when set.
