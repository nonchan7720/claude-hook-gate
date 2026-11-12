---
name: effort-high
description: Switch the reasoning effort of the rest of the current turn to high. Invoke it when a feedback-gate hook message (for example the stop_review of gate.yaml at Stop / SubagentStop) tells you to, or when the user asks to run a task at high effort. It only changes the effort; it gives no task of its own.
argument-hint: "[what to do at this effort]"
effort: high
---

# effort-high: run the rest of this turn at high effort

The effort of the rest of this turn is now `high` (through the `effort` key of this
skill's frontmatter; where the model does not support `high`, Claude Code uses the highest
supported level at or below it, and `CLAUDE_CODE_EFFORT_LEVEL` takes precedence if set).

Continue with what you were told to do at this effort:

- If a `[stop-review]` hook message sent you here, carry out its numbered steps now:
  re-read the changed files, check them against the request, fix what you find, and report
  briefly.
- Otherwise do this: $ARGUMENTS

Do not invoke this skill again in the same turn.
