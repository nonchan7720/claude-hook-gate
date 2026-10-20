// Claude Code の settings hook 向けの Host（src/host-claude.ts）: classic の payload は中核の形そのものなので素通し、出力は outcomeToClassic。
import { describe, expect, test } from 'bun:test'
import { claudeHost } from '../src/host-claude.ts'
import { makeIo } from './helpers/node-io.ts'

describe('claudeHost', () => {
  const io = makeIo({ projectDir: '/proj' })

  test('名前・イベント・設定', () => {
    expect(claudeHost.appName).toBe('Claude Code')
    expect([...claudeHost.configDirNames]).toEqual(['.claude', '.agents'])
    expect([...claudeHost.events]).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'])
    expect(
      claudeHost.options({
        CLAUDE_PLUGIN_OPTION_language: 'ja',
        CLAUDE_PLUGIN_OPTION_agentLaunchGuard: 'true',
        CLAUDE_PLUGIN_OPTION_autoCount: 'false',
        CLAUDE_PLUGIN_OPTION_rulesFile: '/r.md',
      }),
    ).toEqual({
      language: 'ja',
      agentLaunchGuard: true,
      autoCount: false,
      rulesFile: '/r.md',
    })
    expect(claudeHost.options({})).toEqual({ language: undefined, agentLaunchGuard: false, autoCount: true, rulesFile: undefined })
  })

  test('normalize は素通し、render は classic の JSON', () => {
    const payload = { session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }
    expect(claudeHost.normalize('PreToolUse', payload, io)).toEqual({ event: 'PreToolUse', payloads: [payload] })
    const ask = claudeHost.render('PreToolUse', { ask: 'sure?' }, 'warn\n', io)
    expect(JSON.parse(ask.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'sure?' },
    })
    expect(ask.stderr).toBe('warn\n')
    expect(claudeHost.render('Stop', { block: 'no' }, '', io).stdout).toBe('{"decision":"block","reason":"no"}\n')
    expect(claudeHost.render('PostToolUse', {}, '', io).stdout).toBe('')
  })
})
