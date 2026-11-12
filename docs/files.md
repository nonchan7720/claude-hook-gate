# Rules and files

[← README](../README.md) · [日本語](ja/files.md)

## Where things live

| File | Location |
| --- | --- |
| Gate definition | `<project>/.claude/gate.yaml` (without it the gate does nothing) |
| Rules (all projects) | `~/.claude/feedback/*.md` (change with `CLAUDE_FEEDBACK_DIR`) |
| Rules (this project) | `<project>/.claude/feedback/*.md`; wins over a global rule with the same `name` |
| Shared rules file | `~/.claude/feedback-gate/feedback_rules.md` (the bundled one when missing) |
| Gate state and logs | `<project>/.claude/.gate-status/` (add it to `.gitignore`) |
| Violation and error logs | `~/.claude/feedback/.violations.jsonl`, `.errors.jsonl` |

`.agents` works in place of `.claude`. Claude Code looks in `.claude` first, Codex in `.agents` first. One may be a symlink to the other.

## Rule frontmatter

| Key | Meaning |
| --- | --- |
| `name`, `description`, `type` | Required. `type` is `feedback` |
| `count` | Enforcement level; injected and enforced from 3 (see the [README](../README.md#2-turn-a-correction-into-a-rule)) |
| `enforce` | The conditions a hook detects (`pre_bash` / `pre_edit` / `post_edit` / `stop_check`) |
| `files`, `exclude_files` | Inject only when such a file is touched (see [File-scoped rules](hooks.md#file-scoped-rules)) |
| `expires` | Inactive after this time (`YYYY-MM-DD` or ISO 8601) |
| `projects` | Active only in matching projects (globs of absolute paths) |
| `when_exists` | Active only in projects where a matching file exists |

The full format and examples are in [`skills/feedback/reference.md`](../skills/feedback/reference.md) and [`examples.md`](../skills/feedback/examples.md).

## Shared rules file

The file added to every prompt. By default it is the bundled `rules/feedback_rules.md` (`rules/feedback_rules.en.md` for English). To replace it, put your own file at the `rulesFile` path; it is then used instead of the bundled one.

Do not put it under `~/.claude/rules/`: Claude Code loads that directory itself, so the text would be added twice.

## Broken rules

One broken rule file never turns off the other rules.

| Problem | Handling |
| --- | --- |
| The frontmatter is not valid YAML | Only that file is skipped |
| `enforce` is not a list | `enforce` is treated as empty |
| An `enforce` entry is invalid (not a mapping, unusable regex) | Only that entry is dropped |

- The broken file and the reason are recorded in `.errors.jsonl`, and a list is shown at the top of every prompt until it is fixed. `/correct` reports it as `broken`.
- Write regular expressions the way Python's `re` takes them. A leading `(?i)` / `(?s)` / `(?m)`, `(?P<name>...)` and `\A` / `\Z` work. A leading `(?x)`, inline flags in the middle, `a*+` and `(?#...)` do not.

## The running display

While gate commands run, a list appears above the prompt.

```
[gate] running:
  typecheck ✓ (0.7s)
  lint ✗ (0.2s)
  test $ bun run test (8s)
```

- It combines the main agent and the subagents of one session. `waiting` marks a command that waits for the same run in another agent (see [Sharing runs between agents](gate.md#sharing-runs-between-agents)).
- When everything has finished the list goes away and `[gate] done: ✓ 5 / ✗ 1 (81.0s)` stays in the status line. The Stop hook output says which one failed.
- While a rule is evaluated, the status line shows `[feedback-guard] evaluating: <rule>` and the like.
