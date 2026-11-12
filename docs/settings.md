# Settings

[← README](../README.md) · [日本語](ja/settings.md)

Set them on the `/plugin` install screen, or later in `/config`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `language` | `auto` | Language of the messages |
| `autoCount` | `true` | Raise a rule's `count` by 1 when a violation is detected |
| `agentLaunchGuard` | `false` | Ask before sending instructions to a subagent |
| `rulesFile` | `~/.claude/feedback-gate/feedback_rules.md` | The shared rules file injected into every prompt (see [Shared rules file](files.md#shared-rules-file)) |

## Agent launch guard

With `agentLaunchGuard` set to `true`, these calls show the full text to be sent and ask first.

| Tool | Asks when |
| --- | --- |
| `Agent` | `subagent_type` is `code-implementer` |
| `SendMessage` | the recipient is anything other than `git-operator` |

Environment variables change the targets (lists separated by `,` or `;`).

- `FEEDBACK_GATE_ASK_AGENT_TYPES`: the `subagent_type` values to ask about
- `FEEDBACK_GATE_ALLOW_RECIPIENTS`: the recipients that need no confirmation

## Automatic count increase

When a hook detects a rule violation, it raises the `count` in that rule's file by 1. Repeating the mistake moves the rule from warn to ask / block to deny.

- It is raised once per session per rule, up to 5.
- Only the `count: N` line of the frontmatter is rewritten. A rule without a numeric `count` is left alone.
- The current decision uses the `count` from before the increase; the new level applies from the next violation.
- The increase is mentioned in one line of the reason, so Claude sees it too.

Set `autoCount` to `false` to turn it off.

## Language of the messages

What the hooks print (rules, block reasons, gate results, notifications, ...) is in Japanese or English.

- `auto`: the first of `FEEDBACK_GATE_LANG`, `LC_ALL`, `LC_MESSAGES`, `LANG` that has a value decides: Japanese when it starts with `ja`, English otherwise.
- `ja` / `en`: always that language.

The texts are in `locales/ja.yaml` and `locales/en.yaml`. Your own shared rules file and the `message` of a rule are printed as written.
