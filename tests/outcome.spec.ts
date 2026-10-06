import { describe, expect, test } from 'bun:test'
import { merge, toOutcome } from '../src/outcome.ts'

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
