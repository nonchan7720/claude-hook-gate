# Feedback rule file: format reference

What `src/feedback-rules.ts` reads. Anything not listed here is ignored by the hooks (but
costs context when the file is injected).

## Template

```markdown
---
name: <topic>                 # same as the file name without .md; English snake_case
description: <one line>       # injected with the rule; say what the rule prevents
type: feedback
count: 1                      # bare integer; the hooks rewrite only this line
# expires: 2026-12-31         # optional; inactive after this day (UTC) or ISO 8601 datetime
# projects: ['~/src/myorg/**']   # optional; globs on the project dir's absolute path
# when_exists: ['go.mod']     # optional; globs relative to the project root
# files: ['**/*.go']          # optional; inject when such a file is read / edited, not on every prompt
# exclude_files: ['**/*_test.go']  # optional; files to leave out of `files`
# enforce:                    # optional; see below
#   - event: pre_bash
#     when: '...'
#     message: '...'
---

<The rule: one or two imperative sentences. This first paragraph is what gets injected.>

**Excuse:** <what you were assuming when you made the mistake>
**Pointer:** <why that assumption was wrong, in the user's words made general>

**Why:** <the reason the user gave>

**How to apply:** <when and where the rule applies; what to do instead>
```

- The body is injected only up to the first `**Why**`, `**Excuse**`, `**言い訳**` or
  `**How to apply**` marker, and only its first paragraph. Everything after is for you to
  read when you open the file.
- `count` thresholds: `1-2` provisional (not injected; `warn` when enforced), `3-4`
  confirmed (injected on every prompt, or on touching a matching file for a rule with
  `files`; `ask` on pre_* events, `block` on post_edit / stop_check), `>= 5` `deny` /
  `block` everywhere. The hooks raise `count` by 1 the
  first time a rule is violated in a session (up to 5; plugin setting `autoCount`).
  `/correct apply` raises it to 3 or 5 based on the violation log.

## Scope keys (all optional; a rule is active only when every key that is set is satisfied)

| Key | Value | Meaning |
| --- | --- | --- |
| `expires` | `YYYY-MM-DD` or ISO 8601 datetime | Inactive after that point (a date is valid through the end of that day, UTC). An unparsable value means no expiry. |
| `projects` | string or list of globs | Matched against the project directory's absolute path; `**` crosses `/`; a leading `~` expands to `HOME`. Active when any matches. |
| `when_exists` | string or list of globs | Relative to the project root. Active when at least one file exists. |

These filters apply to the merged global + project view. When a project rule and a
global rule share a `name` and the project one is inactive, the global one is hidden too.

## Target files (`files`, optional)

| Key | Value | Meaning |
| --- | --- | --- |
| `files` | string or list of globs | Relative to the project root (in a worktree under `.claude/worktrees/`, relative to that worktree). A rule with `files` is **not** injected on UserPromptSubmit; it is injected (`count >= 3`) right after a matching file is read (`Read`) or edited (`Edit` / `Write` / `MultiEdit`, or a plain heredoc write in `Bash`), once per rule per turn, under a header that names the file. |
| `exclude_files` | string or list of globs | Files matched by `files` that the rule does not cover. |

Use it for anything tied to one language or kind of file: the rule then reaches Claude
when it is about to write that kind of file, and costs nothing on other prompts. It does
not make a rule active or inactive (the scope keys above still apply). In such a rule a
`pre_edit` / `post_edit` entry may omit `path` / `exclude_path`; `files` /
`exclude_files` are used.

## `enforce` entries

A list of mappings. An entry whose `event` has no hook, or whose `when` / `unless` is not
a usable regular expression, is dropped on its own (recorded in `.errors.jsonl` and shown
by `/correct` as `broken`); the rest of the rule still works. `enforce` that is not a list
(a forgotten `- `) counts as empty.

### Choosing the event

| You want to catch | Event | Hook sees |
| --- | --- | --- |
| A command Claude is about to run (`git push --force`, `rm -rf`, `npm install` without lockfile, ...) | `pre_bash` | The Bash `command` string. |
| Something Claude is about to write (a forbidden API, a missing header, code without a test file next to it) | `pre_edit` | The new text only (`new_string` / `content`), plus the target path. |
| The state of a file after an edit (a leftover `console.log`, a TODO without ticket, a file that fails a formatter) | `post_edit` | The whole file on disk after Edit / Write, or after a Bash command rewrote it. |
| A condition over the files changed in the session, at stop (every changed Go file gofmt-clean; a changed migration has a down file) | `stop_check` | The list of changed files. |

A heredoc whose target and body are plain in a Bash command (`cat > path <<'EOF' ... EOF`,
`tee path <<EOF`) is checked by `pre_edit` before the command runs, like a Write. Every
other file written by Bash (`sed -i`, `python`, a target in a variable) is checked after
the command with the `post_edit` entries and with the `pre_edit` entries that can be
judged afterwards (the added lines for a tracked file, the whole content for a new file);
`deny` / `ask` become a PostToolUse `block` there.

### Keys per event

```yaml
enforce:
  - event: pre_bash
    when: '正規表現 / regex'      # required; matches the command
    unless: 'regex'              # optional; not a violation when it matches
    check: 'shell cmd'           # optional; non-zero exit confirms (AND with when); 10 s limit
    message: 'what to do instead'
    severity: deny               # optional: deny | ask | warn; default from count

  - event: pre_edit
    path: 'glob'                 # required unless the rule has `files`; project-relative file path (string or list)
    exclude_path: 'glob'         # optional; string or list (defaults to `exclude_files` when path is omitted)
    when: 'regex'                # optional; against the text being written (m flag)
    unless: 'regex'              # optional
    absent_sibling: '{stem}.test.ts'   # optional; violation when no such file sits next to the target
    absent_glob: 'tests/**/{stem}_test.py'  # optional; string or list, from the project root;
                                 # {stem} = file name without extension (kebab/snake variants tried),
                                 # {dir} = project-relative directory. OR with absent_sibling.
                                 # Targets that are themselves test files are skipped.
    message: '...'
    severity: ask                # optional: deny | ask | warn

  - event: post_edit
    path: 'glob'                 # required unless the rule has `files`
    exclude_path: 'glob'         # optional (defaults to `exclude_files` when path is omitted)
    when: 'regex'                # optional; against the whole file (m flag)
    unless: 'regex'              # optional
    check: 'shell cmd'           # optional; $FILE = absolute path, cwd = that file's root; 15 s limit
                                 # at least one of when / check; both = AND
    message: '...'
    severity: block              # optional: block | warn (ask is treated as block)

  - event: stop_check
    changed: 'glob'              # required; matched against each changed file
    check: 'shell cmd'           # optional; $FILE = absolute path of the file; non-zero = violation
    require_sibling: 'name'      # optional; violation when the same directory lacks this file
    message: '...'
    severity: block              # optional: block | warn
```

Globs: `*` does not cross `/`, `**` does, `{a,b}` expands (same as `.claude/gate.yaml`).

### Regular expressions

Written in Python `re` syntax and run as JavaScript. Translated: a leading `(?i)` /
`(?s)` / `(?m)`, `(?P<name>...)`, `(?P=name)`, `\A` / `\Z` / `\z`. Invalid (the entry is
dropped): a leading `(?x)`, an inline flag not at the start (`x(?i)y`), possessive
quantifiers (`a*+`), comments (`(?#...)`), recursion (`(?P>name)`). `pre_edit` /
`post_edit` match with the `m` flag, so `^` / `$` are line anchors; `pre_bash` has no flag.

Test a pattern before saving, e.g.

```
node -e 'console.log(/git\s+push\b.*\s--force\b/.test(process.argv[1]))' 'git push --force origin main'
```

or the Python equivalent with `re.search`. Check one text that must match and one that
must not.

### Severity by count (when `severity` is omitted)

| count | pre_bash / pre_edit | post_edit / stop_check |
| --- | --- | --- |
| >= 5 | `deny` | `block` |
| 3-4 | `ask` | `block` |
| 1-2 | `warn` | `warn` |

`deny` / `block` stop the call (or the stop) and return `message` as the reason; `ask`
asks the user; `warn` only prints to stderr. Every detected violation is appended to
`~/.claude/feedback/.violations.jsonl` as one JSON line: `ts`, `rule`, `count`,
`severity`, `event`, `detail`.

## Where the hooks look

- Global: `~/.claude/feedback/*.md`, or `$CLAUDE_FEEDBACK_DIR/*.md` when set.
- Project: `<project>/.claude/feedback/*.md`. Same `name` → project wins.
- A file is a rule only if it starts with a `---` frontmatter block that parses as YAML.
  Temporary files that do not end in `.md` are ignored.
- The plugin-wide instructions (`rules/feedback_rules.md`, or the user's `rulesFile`) are
  separate and are not rules; do not put rules there.
