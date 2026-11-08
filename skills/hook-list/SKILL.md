---
name: hook-list
description: Show, in the browser, which hooks feedback-gate runs in this project and when - the `.claude/gate.yaml` rules / consistency_checks / session_start with their commands, and the feedback rules with how they are injected and each `enforce` entry (event, severity, condition, check command), plus the inactive and unreadable rules. Use when the user asks what hooks, gate rules, feedback rules or commands are registered or active in the project, or wants to see or check them in a UI. Works where the /hook-list command of the mod is not available (managed environments, Codex).
argument-hint: "[--no-open]"
---

# hook-list: show the registered hooks in the browser

Run this and report its one-line result (it names the HTML file it wrote):

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/hook-list.sh" claude $ARGUMENTS
```

In Codex, pass `codex` instead of `claude` (the project's `.agents/` is then read before
`.claude/`). The script runs the `feedback-gate` binary (`<host> hook-list`), which reads
`{.claude,.agents}/gate.yaml` and the global and project feedback rules, writes the page to
`~/.claude/feedback-gate/hook-list/<project>-<hash>.html` and opens it in the default browser
(`open` on macOS, `xdg-open` or `wslview` elsewhere). It changes no rule or gate file.

- If the result says the browser could not be opened (a remote machine, no desktop), give
  the user the file path so they can open it themselves. With `--no-open` it only writes
  the file.
- If the script fails because the binary could not be installed, relay its one-line
  reason (for example no `curl` / `wget`, or no network).
- Do not summarise the page from memory: it is the source of truth. If the user asks a
  question about the hooks, read `{.claude,.agents}/gate.yaml` and the rule files
  directly.
