# Periodic review (inventory) of feedback rules

Goal: every rule still earns its place in the prompt, the ones that matter are enforced,
and nothing is broken or duplicated. Do this when the user asks for a review, cleanup,
audit or 棚卸し, after `/correct` shows many proposals, or when the injected rules block
grows long.

## 1. Collect

1. `/correct` (optionally `--window 90d`): read its `broken`, `bump`, `enforce`, `stale`
   and `expired` proposals. If you cannot run it, ask the user to run it and paste the
   output, or compute the same facts from the files and the log below.
2. The rule files: both directories, frontmatter plus the first paragraph of each body.
   Note which project rules shadow a global rule of the same `name`.
3. The violation log `~/.claude/feedback/.violations.jsonl` (one JSON object per line:
   `ts`, `rule`, `count`, `severity`, `event`, `detail`). Count per rule, last timestamp,
   severity mix. Without `jq`:

   ```
   LOG=~/.claude/feedback/.violations.jsonl
   grep -o '"rule":"[^"]*"' "$LOG" | sort | uniq -c | sort -rn        # violations per rule (all time)
   grep -o '"rule":"[^"]*"' <(awk -v since="$(date -u -d '90 days ago' +%Y-%m-%d 2>/dev/null || date -u -v-90d +%Y-%m-%d)" \
     '{ ts = substr($0, index($0, "\"ts\":\"") + 6, 10) } ts >= since' "$LOG") | sort | uniq -c | sort -rn   # last 90 days
   ```
4. `~/.claude/feedback/.errors.jsonl` for broken files and dropped `enforce` entries.
5. The project's `.claude/gate.yaml`, linters and tests: a rule that a gate command or a
   linter now catches no longer needs to be a feedback rule.

## 2. Classify every rule

| Proposal | When |
| --- | --- |
| **keep** | Active, clear, count matches how firmly the user wants it, enforce present where possible. |
| **promote** | Violated repeatedly (`bump` proposal) → raise count to 3 (confirmed) or 5 (deny). `count >= 3` without `enforce` but detectable → add `enforce`. |
| **fix** | `broken`: the file or an `enforce` entry does not parse; invalid regex. Fix in place. |
| **narrow** | Violations are mostly false positives (`detail` shows accepted forms) → add `unless` / `exclude_path`, or sharpen `when`. |
| **merge** | Two rules say the same thing, or one is a special case of another → keep one name, fold the other's body / enforce in, delete the other (ask first). |
| **rescope** | A global rule that only applies to one stack → add `when_exists` / `projects`; a project rule the user wants everywhere → move to global. |
| **retire** | `expired`; the situation no longer exists (tool replaced, project archived); now covered by `gate.yaml`, a linter or a test; `stale` for a long time and the user agrees it is no longer needed. Delete (ask first) or set `expires`. |

Rules with `count 1-2` and no violations for a long time are candidates to retire or
promote: ask the user whether the point still matters.

## 3. Present

One table, sorted by count descending then name, with: rule, scope (global / project /
shadowed), count, enforce (events or none), violations in the window / all time, last
violation, status flags (active / expired / scoped-out / broken), proposal in one phrase.
Then the questions you need answered, grouped: deletions, merges, count changes. Keep
the whole message short; the table is the content.

## 4. Apply

- Only what the user picked. `count` changes, `enforce` edits, scope keys and body
  rewrites are edits to the rule file. Deleting a file is `rm`; merging is edit + `rm`.
- Do not touch `.violations.jsonl`, `.errors.jsonl` or the `.count_state` / `.ask_state`
  directories; the log stays as history.
- Keep `name` stable unless merging; the violation log and `/correct` key on it.
- Re-read every edited file (valid frontmatter, bare `count:` line, regexes tested).
- Finish with the list of changed and deleted files and the new count of active rules.
