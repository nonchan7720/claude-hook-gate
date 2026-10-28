---
name: feedback
description: Create, update and review (periodic inventory) the feedback rule files that feedback-gate reads, `~/.claude/feedback/*.md` (global) and `<project>/.claude/feedback/*.md` (project). Use when the user gives feedback, a correction or a preference worth remembering, asks to save or record a rule, raise or lower a rule's count, add or fix an `enforce` entry, scope a rule to some projects, or clean up, audit or review the feedback rules (棚卸し). Also use when `/correct` reports broken, stale, enforce or expired proposals.
argument-hint: "[create|update|review] [topic or rule name]"
---

# feedback: manage feedback rule files

A feedback rule is one Markdown file with YAML frontmatter. feedback-gate reads every
`*.md` in `~/.claude/feedback/` (global) and `<project>/.claude/feedback/` (project;
same `name` → the project file wins), injects the rules with `count >= 3` into every
prompt (or, for a rule with `files`, right after a matching file is read or edited), and
enforces the `enforce` entries on tool calls and at stop. The exact format is
in [reference.md](reference.md); complete files are in [examples.md](examples.md); the
inventory procedure is in [review.md](review.md).

Arguments: `$ARGUMENTS`. The first word picks the mode (`create`, `update`, `review`);
the rest is the topic or rule name. Without a mode: the user just gave feedback →
`create` (or `update` when a rule for it already exists); the user asks to clean up,
audit, look over or 棚卸し the rules → `review`.

Talk to the user in their language; write the rule body and `message` texts in the
language they use with you. Keep every file short: rule files are instructions Claude
follows on every prompt, so each extra line costs context.

## Always first: list what exists

Before creating anything, read the frontmatter (`name`, `description`, `count`, scope
keys) of every file in both directories, so you update a rule instead of writing a
second one about the same thing:

```
ls ~/.claude/feedback/*.md .claude/feedback/*.md 2>/dev/null   # from the project root
```

`CLAUDE_FEEDBACK_DIR`, when set, replaces `~/.claude/feedback`. Never touch the state
files next to the rules (`.violations.jsonl`, `.errors.jsonl`, `.count_state/`,
`.ask_state/`, `.inject_state/`, `.bash_started/`): they belong to the hooks. The only thing you read
from them is the violation log, in `review` mode.

## create

1. **Confirm saving.** The bundled rules file asks you to check with the user before
   saving a new rule. Unless the user already said "save this" / "remember this", ask in
   one line, proposing the name, the scope and the one-sentence rule you intend to
   write. Then save before replying to the original request.
2. **Pick the scope.** Project (`<project>/.claude/feedback/`) when the point is about
   this codebase, its tools or its conventions. Global (`~/.claude/feedback/`) when it
   is about how you work in general. A rule about one language or kind of file (an
   idiom, a required construct, a forbidden API in that language) gets `files` (e.g.
   `['**/*.go']`, `['**/*.py', '**/*.pyi']`, `['migrations/*.sql']`; optional
   `exclude_files`): it is then shown only when such a file is read or edited, once per
   turn, instead of on every prompt. Translate the language the user names into globs
   yourself. Use `when_exists` (e.g. `['go.mod']`) only for a rule that must be in the
   context without a file being opened (build commands, directory layout). A global
   rule that only makes sense for one organization gets `projects` (e.g.
   `['~/src/myorg/**']`) instead of being copied into many projects. A rule the user
   wants only for a while gets `expires`.
3. **Abstract the remark.** Turn the concrete correction into the rule for the class of
   situation ("run the type check before claiming a change compiles", not "you forgot
   `tsc` in foo.ts"). The body's first paragraph is what the hook injects into the
   prompt: make it one or two imperative sentences that stand alone. A `files` rule
   arrives right before that kind of file is written, so its first paragraph may be
   concrete: the rule, the idiom to use in that language (a short code fragment is
   fine) and the one exception, in at most three sentences. Below it, record
   the excuse (what you were assuming when you made the mistake) and the pointer against
   it, then **Why** and **How to apply**. Never store secrets or private details.
4. **Name the file** `<topic>.md` in English snake_case (`tsconfig_rootdir.md`,
   `test_mocking.md`); `name` in the frontmatter is the same topic. `type: feedback`.
5. **Set `count`.** New rule → `count: 1` (provisional: recorded, not yet injected).
   The user says it is a repeated issue, or wants it enforced from now on → `count: 3`
   (confirmed: injected on every prompt, `ask` / `block` when enforced). Start at `5`
   (`deny`) only when the user asks for a hard stop. `count` is a plain integer line;
   the hooks rewrite only that line.
6. **Add `enforce` when a hook can detect it.** Pick the event with the table in
   reference.md (`pre_bash` for commands, `pre_edit` for what is about to be written,
   `post_edit` for the state of a file after the edit, `stop_check` for the changed
   files at stop). Write `when` / `unless` in Python `re` syntax (the hook translates
   them to JavaScript; see the limits in reference.md), test the pattern against a
   positive and a negative sample before saving, and write a `message` that tells
   future-you what to do instead. Prefer `when` to `check`: `check` runs a shell command
   with a 10-15 second limit on every matching call. In a rule with `files`, a
   `pre_edit` / `post_edit` entry may leave out `path` / `exclude_path`: the hook uses
   `files` / `exclude_files`. A rule you cannot detect
   mechanically gets no `enforce`; it still works through injection once `count >= 3`.
7. **Verify** by reading the file back: the frontmatter is valid YAML (quote strings
   containing `:`, `#`, or leading special characters), `count:` is a bare number, each
   `enforce` item is a mapping with its required keys. Then tell the user the path, the
   count and what it means now (provisional / confirmed / deny).

Use the template in reference.md; see examples.md for finished files.

## update

- **Same feedback again.** Raise `count` by 1 in the file that is actually used (the
  project file when both exist). Do not add 1 when a hook already bumped it in this
  session (the warn / ask / block reason says `count went from N to N+1`). Say what the
  new count means (3 = confirmed and injected; 5 = deny).
- **The rule fired wrongly.** Do not delete the rule. Narrow it: add `unless` for the
  accepted form, `exclude_path` for files it should not cover, or make `when` more
  specific. Tell the user the hook also logged that violation and may have raised the
  count; offer to put it back.
- **Reached `count >= 3` without `enforce`.** Add `enforce` if a hook can detect it
  (see create, step 6). `/correct` reports such rules as `enforce` proposals.
- **Imprecise wording.** Rewrite the first paragraph so it says exactly what to do.
  Keep `name` (renaming changes which file the hooks and `/correct` update); change the
  file name only together with `name`.
- **Scope changes.** Move a project rule to global (or the reverse) by moving the file;
  set or drop `expires` / `projects` / `when_exists` / `files` as the user asks. A rule
  that keeps showing up on prompts where it does not matter is a candidate for `files`.
- Edit only the rule files. Lowering a count or deleting a rule is the user's decision;
  do it when asked, and say so.

## review (periodic inventory)

Follow [review.md](review.md). In short: run `/correct` (or ask the user to run it and
paste the output), gather per-rule statistics from the violation log, and present one
table of all rules with a proposal per rule: keep, promote (raise count / add
`enforce`), fix (broken file or entry), narrow (false positives), merge (overlapping
rules), rescope, or retire (expired, obsolete, or now covered by `gate.yaml`, a linter or
a test). Ask before deleting or merging anything, apply only what the user picks, and
list the files you changed.
