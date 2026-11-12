# Commands and skills

[← README](../README.md) · [日本語](ja/commands-and-skills.md)

## Commands

### `/correct`

Fixes a repeated mistake at the layer that works best. It aggregates the feedback rules (`~/{.claude,.agents}/feedback/*.md` and `<project>/{.claude,.agents}/feedback/*.md`) and the violation log (`~/.claude/feedback/.violations.jsonl`), then proposes how to tighten them. The command is registered on `session.start` by `src/register.ts`; the logic is in `src/correct.ts`.

```
/correct [--window 30d] [--min 2] [apply]
```

- `--window`: how far back to count violations, `Nd` or `Nh` (default `30d`).
- `--min`: the minimum number of violations in the window before a proposal is made (default `2`).
- `apply`: write the `bump` proposals to the rule files (see below). Without it nothing is changed.

Unknown arguments are ignored. There are five kinds of proposals, listed in this order:

| Kind | When | Proposal |
| --- | --- | --- |
| `broken` | A rule file cannot be read, or an `enforce` entry in it is invalid (see [Broken rules](files.md#broken-rules)). The rule name is the file name without `.md`. | Fix the file; the reason is shown. |
| `bump` | An active rule has at least `--min` violations in the window. | `count` 1-2: raise to 3 (confirmed rule). `count` 3-4 with at least `--min` `ask` / `block` violations in the window: raise to 5 (`deny`). `count` >= 5 is never proposed. |
| `enforce` | An active rule has `count >= 3` but no `enforce`, so no hook can detect it (and the violation log never sees it). | Add `enforce` entries; a template for the four events is shown. |
| `stale` | An active rule has `count >= 3` and `enforce`, but has never appeared in the violation log. | Check that the `enforce` works and the rule is not out of date. |
| `expired` | A rule file is inactive because of `expires`, `projects` or `when_exists`. | Delete or update it. |

`apply` rewrites only the `count:` line inside the frontmatter of the `bump` rules, and lists the changed files. Nothing else in the files is touched. `enforce` (and `stale` / `expired`) are proposals only: Claude is told to show them to you and to ask before editing any file.

With the automatic increase (`autoCount`) on, `count` goes up by 1 per session in which the rule is violated. A `bump` proposal instead jumps to 3 or 5 based on the violations in the window; it always starts from the current `count`, and `apply` only rewrites a file whose `count` still matches the proposal, so the two never add up twice.

### `/hook-list`

Shows, as a page in the browser, what feedback-gate runs in this project and when. It changes no rule or gate file.

```
/hook-list [--no-open]
```

The list is built by the Go binary (`feedback-gate <claude|codex> hook-list`, `internal/hookgate/hook_list.go`) and the page is `webui/hook-list.html` (embedded in the binary). The mod's `/hook-list` (`src/hook-list.ts`) only runs it through `scripts/hook-list.sh`, so the same page is available where the mod's hooks do not run (managed environments) and in Codex, through the same script (the `/feedback-gate:hook-list` skill; in Codex, `bash <plugin>/scripts/hook-list.sh codex`). The HTML is written to `~/.claude/feedback-gate/hook-list/<project path>-<hash>.html` and opened in the default browser (`open` on macOS, `xdg-open` or `wslview` elsewhere, `start` on Windows). Where no browser can be opened (a remote machine) or with `--no-open`, it returns the path of the file.

The page shows:

- **gate.yaml**: the path of the file found, then `rules` (PostToolUse right after an edit: `match`, the `run` commands, `parallel`, `run_checks`, `dir` / `per_file_dir` / `timeout` / `policy`), `consistency_checks` (Stop / SubagentStop; a check no rule names in `run_checks` is marked as never running) and `session_start` (SessionStart; `on` / `background`), each with when it runs. A missing or unparsable file is reported as such.
- **feedback rules**: for each active rule of the merged global + project view, where it lives, its `count` and level (provisional / confirmed / deny), how it is injected (every prompt / when a file matching `files` is read or edited / never), each `enforce` entry (event and effective severity, `path` / `changed` / `when` / `unless` / the `check` command, ...) and the file path. Then the inactive rules (expired, `projects` / `when_exists` not matching) and the unreadable ones, with the reason.
- **Plugin settings**: the current `agentLaunchGuard`, `autoCount` and `language`.

The feedback rules are a table with one row per rule; opening a row shows the details above. Buttons filter by level, scope and event, and a text box by name, command or glob, so dozens of rules stay easy to scan. Inactive rules are collapsed to a count; unreadable ones are shown open. The page follows the light / dark setting.

## Skills

Three skills, plus the `effort-<level>` skills that only switch the effort ([below](#feedback-gateeffort-level)), are bundled under `skills/`. Claude Code loads them with the plugin; invoke them as `/feedback-gate:<name>` or let Claude pick them up from their descriptions. Each is a `SKILL.md` with the procedure plus reference files it reads when needed; the hooks do not depend on them.

### `/feedback-gate:feedback`

Creates, updates and reviews the feedback rule files (`~/.claude/feedback/*.md`, `<project>/.claude/feedback/*.md`).

```
/feedback-gate:feedback [create|update|review] [topic or rule name]
```

- `create`: when you give feedback, a correction or a preference. Confirms that you want it saved, picks global or project scope (or a scoped global rule via `projects` / `when_exists` / `expires`), turns the concrete remark into an abstract rule whose first paragraph is what the hook injects, names the file in snake_case, sets `count` (1 provisional, 3 confirmed), adds `enforce` only when a hook can detect the violation (choosing the event, testing the regular expression), and reads the file back to check the frontmatter.
- `update`: the same feedback again (raises `count` by 1, unless the hook already did in this session), a rule that fired wrongly (narrowed with `unless` / `exclude_path` instead of deleted), a confirmed rule without `enforce`, rewording, rescoping.
- `review`: the periodic inventory (`skills/feedback/review.md`). Runs `/correct`, counts the violations per rule from `.violations.jsonl`, and presents one table with a proposal per rule: keep, promote, fix, narrow, merge, rescope or retire (expired, obsolete, or now covered by `gate.yaml` or a linter). Nothing is deleted or merged without asking.

The format reference (`skills/feedback/reference.md`) and complete examples for the four `enforce` events (`skills/feedback/examples.md`) travel with the skill. The skill edits only rule files, never the hooks' state files.

### `/feedback-gate:gate`

Writes or updates the project's `.claude/gate.yaml`.

```
/feedback-gate:gate [init|update|review]
```

It first reads what the project already runs instead of guessing: the manifests (language and package manager), the task runner (`Makefile`, `justfile`, `Taskfile.yml`, `mise` tasks, `package.json` scripts), the CI configuration (GitHub Actions, GitLab CI, CircleCI, ...) and pre-commit style hooks, and the repository layout (single package, workspaces, one directory per package). It then maps those to the gate: file-scoped lint / format / typecheck and package tests in `rules` (with `$CLAUDE_GATE_FILES` where the tool accepts files), whole-project tests and builds in `consistency_checks` referenced by `run_checks`, `per_file_dir` for monorepos, a `name` on every command, `parallel` groups, `timeout` from measured durations and `files: false` for whole-project commands; CI-only steps (coverage upload, deploys, steps that need services or secrets) are left out and listed in the report. Before handing over it runs every command once on the current tree (through the normal permission flow), checks the file against the schema's key set and makes sure `.claude/.gate-status/` is in `.gitignore`. `review` reports the drift between the current file and CI without editing. The field reference, the discovery checklist and per-toolchain recipes (TypeScript, workspaces, Python, Go, Rust, Ruby, JVM, Terraform, shell, Makefile-driven) are in `skills/gate/`.

### `/feedback-gate:hook-list`

Shows the same page as [`/hook-list`](#hook-list) by running `scripts/hook-list.sh` (argument: `--no-open`). Use it in managed environments where the mod's `/hook-list` is not available; Claude may also use it when asked which hooks, gate rules or feedback rules are registered in the project.

### `/feedback-gate:effort-<level>`

Five skills: `effort-low`, `effort-medium`, `effort-high`, `effort-xhigh` and `effort-max`. Their body is nearly empty; the `effort` key of the frontmatter switches the effort of the rest of the turn that invoked the skill (a Claude Code skill feature: a level the model does not support becomes the highest supported level at or below it, and the environment variable `CLAUDE_CODE_EFFORT_LEVEL` takes precedence when set). Hook output cannot change the session's effort, so [stop_review](gate.md#stop_review) has Claude invoke this skill from the block reason. You can also use it yourself, e.g. `/feedback-gate:effort-max find out why this test fails`.
