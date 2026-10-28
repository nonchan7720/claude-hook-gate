# Feedback rule examples

Complete files, one per common shape. Replace the texts; keep the structure.

## 1. Command rule (`pre_bash`): no force push

`~/.claude/feedback/no_force_push.md`

```markdown
---
name: no_force_push
description: Never force-push; rewrite history only when the user asks for that branch explicitly.
type: feedback
count: 3
enforce:
  - event: pre_bash
    when: 'git\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b)'
    unless: '--force-with-lease\b.*\bclaude/'
    message: 'Do not force-push. Push a new commit, or ask the user before rewriting history.'
---

Do not force-push a branch. Add commits instead; rewrite history only when the user names the branch and asks for it.

**Excuse:** The branch was mine, so rewriting it seemed harmless.
**Pointer:** Other sessions and CI may have checked it out; a force push invalidates them.

**Why:** A force push broke a colleague's checkout.

**How to apply:** Any `git push` with `--force` / `-f`. `--force-with-lease` on a `claude/` branch is allowed.
```

## 2. Pre-edit rule with a required test file (`pre_edit`, `absent_glob`)

`<project>/.claude/feedback/tdd_test_first.md`

```markdown
---
name: tdd_test_first
description: Write or update the test before touching a source module.
type: feedback
count: 3
when_exists: ['package.json']
enforce:
  - event: pre_edit
    path: 'src/**/*.ts'
    exclude_path: ['src/**/*.d.ts', 'src/index.ts']
    absent_sibling: '{stem}.test.ts'
    absent_glob: ['tests/**/{stem}.spec.ts', 'tests/**/{stem}.test.ts']
    message: 'Write the test for this module first (tests/<name>.spec.ts), then edit the source.'
---

Before editing a module under `src/`, make sure a test for it exists (`<stem>.test.ts` next to it or `tests/**/<stem>.spec.ts`); write the failing test first when it is missing.

**Excuse:** The change looked too small to need a test.
**Pointer:** Small changes without tests are where regressions came from in this project.

**Why:** The user wants red-green in this repository.

**How to apply:** Any `src/**/*.ts` except type declarations and the barrel file.
```

## 3. Post-edit state rule (`post_edit`): no stray debug output

`~/.claude/feedback/no_debug_logging.md`

```markdown
---
name: no_debug_logging
description: Do not leave console.log / print debugging in source files.
type: feedback
count: 4
enforce:
  - event: post_edit
    path: ['src/**/*.{ts,tsx,js}', 'app/**/*.py', 'lib/**/*.py']
    exclude_path: ['**/*.test.*', '**/*.spec.*', '**/scripts/**']
    when: '^\s*(console\.(log|debug)\(|print\()'
    unless: '#\s*noqa: debug|//\s*debug-ok'
    message: 'Remove the debug output (or mark it with a `// debug-ok` / `# noqa: debug` comment if it is intended).'
---

Do not leave `console.log` / `print` debugging in source files; use the project's logger or remove it before finishing.

**Why:** Debug output reached production logs twice.

**How to apply:** Source trees only; tests and scripts may print.
```

## 4. Stop-time rule with a shell check (`stop_check`)

`~/.claude/feedback/gofmt_clean.md`

```markdown
---
name: gofmt_clean
description: Every Go file changed in the session must be gofmt-clean before stopping.
type: feedback
count: 3
when_exists: ['go.mod']
enforce:
  - event: stop_check
    changed: '**/*.go'
    check: 'test -z "$(gofmt -l "$FILE")"'
    message: 'Run gofmt -w on the changed Go files before finishing.'
---

Run `gofmt` on every Go file you changed before you stop.

**Why:** CI's format check failed on unformatted files three times.

**How to apply:** Projects with a `go.mod`; all changed `*.go` files.
```

## 5. Temporary, project-scoped rule (`expires`, `projects`), no enforce

`~/.claude/feedback/freeze_api_v1.md`

```markdown
---
name: freeze_api_v1
description: Do not change the v1 API handlers during the migration freeze.
type: feedback
count: 3
expires: 2026-12-31
projects: ['~/src/myorg/api-*']
---

Do not modify files under `internal/api/v1/` until the migration freeze ends; put changes in `v2` and tell the user.

**Why:** The v1 handlers are frozen for a client migration.

**How to apply:** Only the `api-*` repositories, until the end of 2026.
```

## 6. Language-scoped rule (`files`): shown when a Go file is read or edited

`~/.claude/feedback/go_wrap_errors.md`

```markdown
---
name: go_wrap_errors
description: Wrap errors you return with the operation that failed; never return a bare err.
type: feedback
count: 3
files: ['**/*.go']
exclude_files: ['**/*_test.go']
enforce:
  - event: pre_edit
    when: '^\s*return (.*, )?err\s*$'
    unless: 'errors\.(Is|As)\('
    message: 'Wrap the error: return fmt.Errorf("<what you were doing>: %w", err).'
---

When a Go function returns an error from a callee, wrap it: `return fmt.Errorf("open config: %w", err)`. A bare `return err` loses the context the caller needs. Exception: a function that only forwards the error one level inside the same package.

**Excuse:** The caller would log it anyway.
**Pointer:** The log line then says only "no such file" with no hint of which file or step.

**Why:** Two incidents took an hour each to locate because the error had no context.

**How to apply:** Every `.go` file except tests. The rule is not on every prompt; it is injected the first time a Go file is read or edited in a turn, and the `pre_edit` entry (which inherits `files` as its `path`) asks before a bare `return err` is written.
```

## 7. A rule that cannot be enforced mechanically

`~/.claude/feedback/answer_first.md`

```markdown
---
name: answer_first
description: Lead with the conclusion; put the reasoning after it.
type: feedback
count: 3
---

Start every answer with the conclusion or result in one or two sentences, then give the reasoning.

**Excuse:** Showing the reasoning first seemed more transparent.
**Pointer:** The user reads the first line on a phone and decides from it.

**Why:** The user asked for it twice.

**How to apply:** Every reply, including intermediate status updates.
```
