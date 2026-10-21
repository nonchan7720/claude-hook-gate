import { describe, expect, test } from 'bun:test'
import { agentLaunchGuard, agentLaunchLists, parseAgentList } from '../src/agent-launch-guard.ts'
import type { Dict } from '../src/pyutil.ts'

const guard = (payload: Dict) => agentLaunchGuard(payload, 'ja')

const decision = (r: { stdout: string }) =>
  (JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput

describe('agent-launch-guard', () => {
  test('the reason is English when lang is en', () => {
    const d = decision(agentLaunchGuard({ tool_name: 'Agent', tool_input: { subagent_type: 'code-implementer', prompt: 'P' } }, 'en'))
    expect(d.permissionDecisionReason).toBe(
      'Prompt to send to code-implementer:\n\nP\n\n--- Check: what to do / background / current state of the code / what not to do / done criteria',
    )
    const m = decision(agentLaunchGuard({ tool_name: 'SendMessage', tool_input: { message: 'M' } }, 'en'))
    expect(m.permissionDecisionReason.startsWith('Message to send to unknown recipient:\n\nM')).toBe(true)
  })

  test('asks for code-implementer with the prompt in the reason', () => {
    const d = decision(guard({ tool_name: 'Agent', tool_input: { subagent_type: 'code-implementer', prompt: 'P' } }))
    expect(d.permissionDecision).toBe('ask')
    expect(d.permissionDecisionReason).toBe(
      'code-implementer に送るプロンプト:\n\nP\n\n--- チェック: やること / 背景 / 既存コードの現状 / やらないこと / 完了条件',
    )
  })

  test('other agent types pass through', () => {
    expect(guard({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'P' } }).stdout).toBe('')
    expect(guard({ tool_name: 'Agent', tool_input: {} }).stdout).toBe('')
  })

  test('SendMessage asks for everyone except git-operator', () => {
    expect(decision(guard({ tool_name: 'SendMessage', tool_input: { to: 'x', message: 'M' } })).permissionDecisionReason).toContain('x に送るメッセージ:\n\nM')
    expect(decision(guard({ tool_name: 'SendMessage', tool_input: { message: 'M' } })).permissionDecisionReason).toContain('宛先不明 に送るメッセージ')
    expect(guard({ tool_name: 'SendMessage', tool_input: { to: 'git-operator', message: 'M' } }).stdout).toBe('')
  })

  test('other tools pass through', () => {
    expect(guard({ tool_name: 'Bash', tool_input: {} }).stdout).toBe('')
  })

  describe('lists from the environment', () => {
    test('parseAgentList splits on , and ;, trims and drops empty names', () => {
      expect(parseAgentList('a, b;c')).toEqual(['a', 'b', 'c'])
      expect(parseAgentList(' x ,, ; ')).toEqual(['x'])
      expect(parseAgentList('')).toEqual([])
      expect(parseAgentList(' ;, ')).toEqual([])
      expect(parseAgentList(undefined)).toEqual([])
    })

    test('agentLaunchLists falls back to the defaults when unset or empty', () => {
      const defaults = { askAgentTypes: ['code-implementer'], allowRecipients: ['git-operator'] }
      expect(agentLaunchLists({})).toEqual(defaults)
      expect(agentLaunchLists({ FEEDBACK_GATE_ASK_AGENT_TYPES: '', FEEDBACK_GATE_ALLOW_RECIPIENTS: ' ;, ' })).toEqual(defaults)
      expect(agentLaunchLists({ FEEDBACK_GATE_ASK_AGENT_TYPES: 'worker; reviewer', FEEDBACK_GATE_ALLOW_RECIPIENTS: 'git-operator, ops' })).toEqual({
        askAgentTypes: ['worker', 'reviewer'],
        allowRecipients: ['git-operator', 'ops'],
      })
      // 片方だけ設定したら、もう片方は既定のまま
      expect(agentLaunchLists({ FEEDBACK_GATE_ASK_AGENT_TYPES: 'worker' })).toEqual({ askAgentTypes: ['worker'], allowRecipients: ['git-operator'] })
    })

    test('custom lists change the verdicts for Agent and SendMessage', () => {
      const lists = agentLaunchLists({ FEEDBACK_GATE_ASK_AGENT_TYPES: 'worker', FEEDBACK_GATE_ALLOW_RECIPIENTS: 'ops' })
      const run = (payload: Dict) => agentLaunchGuard(payload, 'ja', lists)
      expect(decision(run({ tool_name: 'Agent', tool_input: { subagent_type: 'worker', prompt: 'P' } })).permissionDecision).toBe('ask')
      expect(run({ tool_name: 'Agent', tool_input: { subagent_type: 'code-implementer', prompt: 'P' } }).stdout).toBe('')
      expect(run({ tool_name: 'SendMessage', tool_input: { to: 'ops', message: 'M' } }).stdout).toBe('')
      expect(decision(run({ tool_name: 'SendMessage', tool_input: { to: 'git-operator', message: 'M' } })).permissionDecision).toBe('ask')
    })
  })
})
