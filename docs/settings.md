# Settings

[← README](../README.md) · [日本語](ja/settings.md)

## Agent launch guard (optional)

`src/agent-launch-guard.ts` is active only when the `agentLaunchGuard` option (`userConfig`) is `true`. It is `false` by default. When enabled, it runs on PreToolUse for `Agent` and `SendMessage` and returns `ask`, putting the full text that would be sent into the confirmation reason so you can review it before the subagent receives it:

- `Agent`: asks when `subagent_type` is `code-implementer`, showing the `prompt`.
- `SendMessage`: asks for every recipient except `git-operator`, showing the `message`.

Anything else passes through to the normal permission flow. The default agent types and allowed recipients are the `ASK_AGENT_TYPES` and `ALLOW_RECIPIENTS` arrays at the top of `src/agent-launch-guard.ts` (`AskAgentTypes` / `AllowRecipients` in `internal/hookgate/agent_launch_guard.go`). Both the mod hooks and the command hooks (the `feedback-gate` binary) can replace them with the environment variables `FEEDBACK_GATE_ASK_AGENT_TYPES` (the `subagent_type`s to ask about) and `FEEDBACK_GATE_ALLOW_RECIPIENTS` (the recipients that need no confirmation), each a list separated by `,` or `;` (spaces around the names are ignored; an unset or empty variable keeps the default), e.g. `FEEDBACK_GATE_ASK_AGENT_TYPES='code-implementer;worker'`.

To enable it, turn on `agentLaunchGuard` on the settings screen shown when you install the plugin with `/plugin`, or change it later in the `/config` menu (the plugin's `agentLaunchGuard` row).

## Automatic count increase

When a hook (`pre_bash` / `pre_edit` on PreToolUse, `post_edit` on PostToolUse, `stop_check` on Stop / SubagentStop) detects a feedback rule violation, it raises that rule's `count` by 1 at the same time it writes the violation log. Repeating the same violation escalates enforcement from warn to ask / block to deny, instead of the rule staying at `count: 1` forever. Violations found when PostToolUse(Bash) checks files written by Bash (heredoc, `python`, `sed -i`, ...; `post_edit` and the after-the-command `pre_edit` described in "Files written by Bash" above) count too, the same as for Edit / Write.

- Only the `count: N` line inside the frontmatter of the rule file actually used is rewritten (when the global and project directories both have a rule with that name, the project one). The line must be a plain number; a rule without a numeric `count` line is left alone. The new text is written to a temporary file in the same directory and moved into place with `mv`.
- Increases are limited per session and rule name: within one session a rule is raised at most once, however often it is violated (multiple matching `enforce` entries, repeated Stop blocks). A violation in a later session raises it again. The rules already raised are recorded in `~/.claude/feedback/.count_state/<session_id>.json`; calls without a `session_id` never raise a count.
- The cap is `5` (the count that means deny when no `severity` is given); counts at or above it are not raised.
- The current decision still uses the count from before the increase; the new enforcement applies from the next violation. When a count is raised, a line saying `count` went from N to N+1 is added to the deny / ask / block reason (or to stderr for warn), so the model sees it too.
- A failed write never stops the hook.

To turn it off, set `autoCount` in `userConfig` to `false` (default `true`; on the settings screen shown by `/plugin` at install time, or later in `/config`).

## Language of the messages

Everything the hooks print (the feedback rules injected into the context, the block / warn reasons, the gate results, the band and the status line, the desktop notifications, the `/correct` report and the bundled rules file) is available in English and Japanese. The `language` option (`userConfig`, set on the `/plugin` install screen or later in `/config`) chooses it:

- `auto` (default): follow the OS language. The hooks read `FEEDBACK_GATE_LANG` (a plugin-specific override, `ja` or `en`), then `LC_ALL`, `LC_MESSAGES` and `LANG`, and use the first one that has a value: Japanese when it starts with `ja` (e.g. `ja_JP.UTF-8`), English for anything else (`en_US.UTF-8`, `C`, `POSIX`, ...). When none of them is set, English.
- `ja` / `en`: always that language, whatever the environment.

The texts live in `locales/ja.yaml` and `locales/en.yaml` (one key per message, `{{name}}` for the values filled in at runtime; both files must have the same keys, which a test checks) and are looked up with [i18next](https://www.i18next.com/); the language resolution is in `src/i18n.ts`. To change a wording, edit the YAML. The examples in these docs show the English texts; with Japanese you get the Japanese ones (e.g. `[gate] 実行中:` for `[gate] running:` and `[gate] 完了:` for `[gate] done:`). Your own `rulesFile` and the `message` of your feedback rules are shown as you wrote them, in any language.
