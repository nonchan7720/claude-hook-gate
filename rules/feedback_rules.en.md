# Global rules

## Feedback management rules

- When you receive feedback, a correction, a pointer or a preference from the user, **always save it before replying** as a Markdown file in `~/.claude/feedback/` or `.claude/feedback/`. If you forget to save it, the user has to repeat the same point in the next conversation.

### Before starting work

- `~/.claude/feedback/`
  - global rules
- `.claude/feedback/`
  - project-specific rules

Read every file in those directories, and always follow the rules with `count >= 3`.

### When you receive feedback

Every time you receive the same pointer, correction or preference, create or update the file in `.claude/feedback/` or `~/.claude/feedback/` and increment its `count`. **Always do this before replying.**
First, ask the user whether to save this feedback. Save it when the user chooses to.
When recording it, turn the concrete remark into an abstract rule instead of writing it down verbatim.
When recording it, also write down the excuse, and the pointer against that excuse.

- **count below 3**: recorded, but still a provisional rule (you may use your judgement depending on the situation)
- **count 3 or more**: a confirmed rule; always follow it

`/correct` aggregates the violation log (`.violations.jsonl`) and lists candidates for raising `count`, adding `enforce`, and cleaning up expired rules. `/correct apply` writes only the count bumps to the files (adding `enforce` is proposal only; ask the user before rewriting anything).

### Format of a feedback file

```markdown
---
name: (name of the feedback)
description: (one-line description)
type: feedback
count: 1
expires: 2026-12-31          # optional. The rule is inactive after this date
projects: ['~/src/myorg/**']  # optional. Applies only in matching projects
when_exists: ['go.mod']      # optional. Applies only in projects where this glob exists
---

(body of the rule)

**Why:** (the reason the user gave)

**How to apply:** (when and where to apply this rule)
```

`expires` / `projects` / `when_exists` are optional; the rule is active only when all three that are set are satisfied.

- `expires`: expiry. `YYYY-MM-DD` is valid through the end of that day (UTC); otherwise an ISO 8601 datetime. An expired rule is neither injected nor enforced. An unparsable value is ignored (no expiry)
- `projects`: a string or an array. Globs matched against the absolute path of the project directory (`**` crosses `/`; a leading `~` expands to HOME). Applies when at least one matches
- `when_exists`: a string or an array. Globs relative to the project root. Applies when at least one exists

Use these for language-specific or temporary rules. When a global rule and a project rule share a name and the project rule is inactive, the global one is not used either.

### File naming

`.claude/feedback/<topic>.md`, `~/.claude/feedback/<topic>.md` — name the topic in English snake_case (e.g. `tsconfig_rootdir.md`, `test_mocking.md`)

### enforce (enforcement by count)

When a hook (`src/feedback-guard.ts` / `src/feedback-post-edit.ts` / `src/feedback-stop-check.ts`) can actually
detect and enforce the rule, add `enforce:` to the frontmatter. `src/feedback-rules.ts` reads it and evaluates it on
PreToolUse (Bash / Edit, Write, MultiEdit), PostToolUse (Edit, Write, MultiEdit) and Stop.

```yaml
enforce:
  - event: pre_bash          # inspect the command string on PreToolUse(Bash)
    when: 'regex'            # required. A candidate when it matches command
    unless: 'regex'          # optional. Not a violation when this matches
    check: 'shell cmd'       # optional. Non-zero exit confirms the violation (AND with when)
    message: 'instruction shown on violation'
    severity: deny           # optional. Derived from count when omitted

  - event: pre_edit          # inspect the target and the content on PreToolUse(Edit|Write|MultiEdit)
    path: 'glob'             # required. Matched against file_path
    exclude_path: 'glob'     # optional. A string or an array. Even when path matches,
                             # the file is skipped when this matches
    when: 'regex'            # optional. Against new_string / content / new_source
    unless: 'regex'          # optional
    absent_sibling: 'name'   # optional. A violation when the same directory has no file of this name
                             # ({stem} is replaced with the file name without extension)
    absent_glob: 'glob'      # optional. A string or an array. Globs from the project root; when
                             # at least one exists it is not a violation (picks up tests in another
                             # tree such as spec/ or tests/). Expands {stem} and {dir} (the
                             # project-relative directory). OR with absent_sibling

  - event: post_edit         # inspect the whole file after the edit on PostToolUse(Edit|Write|MultiEdit)
                             # (pre_edit only sees the diff, so use this for checks of the resulting
                             # state such as "leave no console.log")
    path: 'glob'             # required. Matched against file_path (project-relative)
    exclude_path: 'glob'     # optional. A string or an array. Skipped when it matches
    when: 'regex'            # optional. Against the file content after the edit (the whole file on disk; m flag)
    unless: 'regex'          # optional. Not a violation when this matches
    check: 'shell cmd'       # optional. $FILE holds the absolute path, cwd is the root of that file. Non-zero exit is a violation
                             # at least one of when and check is required (an entry with neither is ignored).
                             # With both, AND (when matches and check exits non-zero)
    message: '...'
    severity: block          # optional. Derived from count when omitted

  - event: stop_check        # inspect the files changed in the session at Stop
    changed: 'glob'          # required
    check: 'shell cmd'       # optional. $FILE holds the path of the file. Non-zero exit is a violation
    require_sibling: 'name'  # optional. A violation when the same directory has no file of this name
    message: '...'
```

Globs: `*` does not cross `/`, `**` does, and `{a,b}` expansion is supported (same behaviour as
`globToRegex` in `src/glob.ts`).

When `severity` is omitted it is derived from `count` (whether `event` is `stop_check` / `post_edit`
changes how count 3 and 4 are treated).

| count | pre_bash / pre_edit | stop_check / post_edit |
| ----- | ------------------- | ---------------------- |
| >= 5  | `deny`              | `deny`                 |
| 3-4   | `ask`               | `block`                |
| 1-2   | `warn`              | `warn`                 |

- `deny` / `block`: stop the tool call (PreToolUse returns `permissionDecision: deny`, Stop exits 2,
  PostToolUse (`post_edit`) returns `decision: block` with feedback so the edit gets fixed)
- `ask`: ask the user for confirmation (PreToolUse `permissionDecision: ask`. PostToolUse has no ask, so
  an explicit `ask` on `post_edit` is treated as `block`)
- `warn`: only print a warning to stderr and continue

Violations are appended to `~/.claude/feedback/.violations.jsonl` (`count` itself is not changed).
