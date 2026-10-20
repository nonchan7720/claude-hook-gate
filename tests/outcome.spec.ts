import { describe, expect, test } from 'bun:test'
import { merge, type Outcome, outcomeToClassic, toOutcome } from '../src/outcome.ts'

const ran = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout, stderr })

describe('toOutcome', () => {
  test('exit 2 blocks (deny for PreToolUse) with stderr as the reason', () => {
    expect(toOutcome('Stop', ran(2, '', ' no \n'))).toEqual({ block: 'no' })
    expect(toOutcome('PreToolUse', ran(2, '', 'forbidden'))).toEqual({ deny: 'forbidden' })
    expect(toOutcome('Stop', ran(2))).toEqual({ block: 'hook exited with code 2' })
  })

  test('other non-zero exit codes are ignored', () => {
    expect(toOutcome('Stop', ran(1, '{"decision":"block","reason":"x"}', 'boom'))).toEqual({})
  })

  test('JSON stdout is interpreted', () => {
    expect(toOutcome('Stop', ran(0, JSON.stringify({ continue: false, stopReason: 's', decision: 'block', reason: 'r' })))).toEqual({
      preventContinuation: true,
      stopReason: 's',
      block: 'r',
    })
    expect(toOutcome('PreToolUse', ran(0, JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'c' } })))).toEqual({
      ask: 'c',
    })
    expect(toOutcome('Stop', ran(0, JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'c' } })))).toEqual({})
  })

  test('plain text becomes context only for UserPromptSubmit / SessionStart', () => {
    expect(toOutcome('SessionStart', ran(0, 'reset done\n'))).toEqual({ additionalContext: ['reset done'] })
    expect(toOutcome('Stop', ran(0, 'text'))).toEqual({})
  })
})

describe('merge', () => {
  test('the first decision wins and contexts are concatenated', () => {
    expect(merge({ block: 'first', additionalContext: ['a'] }, { block: 'second', additionalContext: ['b'] })).toEqual({
      block: 'first',
      additionalContext: ['a', 'b'],
    })
    expect(merge({}, {})).toEqual({})
  })
})

describe('outcomeToClassic', () => {
  const json = (event: string, o: Outcome) => JSON.parse(outcomeToClassic(event, o).stdout)

  test('PreToolUse: deny / ask become permissionDecision, deny first, allow is never returned', () => {
    expect(json('PreToolUse', { deny: 'no' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
    })
    expect(json('PreToolUse', { ask: 'sure?' }).hookSpecificOutput.permissionDecision).toBe('ask')
    expect(json('PreToolUse', { ask: 'a', deny: 'd' }).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(outcomeToClassic('PreToolUse', { allow: true }).stdout).toBe('')
  })

  test('PostToolUse: block becomes decision block, context goes to hookSpecificOutput', () => {
    expect(json('PostToolUse', { block: 'fix', additionalContext: ['a', 'b'] })).toEqual({
      decision: 'block',
      reason: 'fix',
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'a\n\nb' },
    })
  })

  test('UserPromptSubmit / SessionStart: additionalContext, and decision block for a block', () => {
    expect(json('UserPromptSubmit', { additionalContext: ['x'] })).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x' },
    })
    expect(json('UserPromptSubmit', { block: 'no' }).decision).toBe('block')
    expect(json('SessionStart', { additionalContext: ['x'] }).hookSpecificOutput.hookEventName).toBe('SessionStart')
  })

  test('Stop / SubagentStop: decision block and reason only; continue false keeps its stopReason', () => {
    expect(json('Stop', { block: 'r', additionalContext: ['ignored'] })).toEqual({ decision: 'block', reason: 'r' })
    expect(json('SubagentStop', { preventContinuation: true, stopReason: 's' })).toEqual({ continue: false, stopReason: 's' })
  })

  test('nothing to say prints nothing; stderr is passed through', () => {
    expect(outcomeToClassic('Stop', {})).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    expect(outcomeToClassic('Stop', {}, 'warn\n').stderr).toBe('warn\n')
  })

  test('the Outcome survives a round trip through toOutcome', () => {
    const cases: Array<[string, Outcome]> = [
      ['PreToolUse', { deny: 'd' }],
      ['PreToolUse', { ask: 'a' }],
      ['PostToolUse', { block: 'b', additionalContext: ['c'] }],
      ['UserPromptSubmit', { additionalContext: ['c'] }],
      ['Stop', { block: 'b' }],
      ['SubagentStop', { block: 'b', preventContinuation: true, stopReason: 's' }],
    ]
    for (const [event, o] of cases) expect(toOutcome(event, outcomeToClassic(event, o))).toEqual(o)
  })
})
