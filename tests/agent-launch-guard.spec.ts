import { describe, expect, test } from 'bun:test'
import { agentLaunchGuard } from '../src/agent-launch-guard.ts'

const decision = (r: { stdout: string }) =>
  (JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput

describe('agent-launch-guard', () => {
  test('asks for code-implementer with the prompt in the reason', () => {
    const d = decision(agentLaunchGuard({ tool_name: 'Agent', tool_input: { subagent_type: 'code-implementer', prompt: 'P' } }))
    expect(d.permissionDecision).toBe('ask')
    expect(d.permissionDecisionReason).toBe(
      'code-implementer に送るプロンプト:\n\nP\n\n--- チェック: やること / 背景 / 既存コードの現状 / やらないこと / 完了条件',
    )
  })

  test('other agent types pass through', () => {
    expect(agentLaunchGuard({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'P' } }).stdout).toBe('')
    expect(agentLaunchGuard({ tool_name: 'Agent', tool_input: {} }).stdout).toBe('')
  })

  test('SendMessage asks for everyone except git-operator', () => {
    expect(decision(agentLaunchGuard({ tool_name: 'SendMessage', tool_input: { to: 'x', message: 'M' } })).permissionDecisionReason).toContain(
      'x に送るメッセージ:\n\nM',
    )
    expect(decision(agentLaunchGuard({ tool_name: 'SendMessage', tool_input: { message: 'M' } })).permissionDecisionReason).toContain(
      '宛先不明 に送るメッセージ',
    )
    expect(agentLaunchGuard({ tool_name: 'SendMessage', tool_input: { to: 'git-operator', message: 'M' } }).stdout).toBe('')
  })

  test('other tools pass through', () => {
    expect(agentLaunchGuard({ tool_name: 'Bash', tool_input: {} }).stdout).toBe('')
  })
})
