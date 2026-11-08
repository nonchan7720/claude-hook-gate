import { describe, expect, test } from 'bun:test'
import type { ScriptResult } from '../src/io.ts'
import { merge, type Outcome, toOutcome } from '../src/outcome.ts'
import type { Dict } from '../src/pyutil.ts'

// Go 版の OutcomeToClassic（internal/hookgate/outcome.go）と同じ変換。Go の出力を toOutcome で戻せることの検証に使う。
// toOutcome の逆変換で、exit 2 の block / deny は JSON の判定（decision: block / permissionDecision: deny）で同じ効果になる
// （exit 2 は stderr を理由にするだけで、stdout の JSON は無視される規約なので、情報は reason に移す）。
// stderr は warn など正常終了時の出力で、そのまま stderr へ出す。
const outcomeToClassic = (event: string, outcome: Outcome, stderr = ''): ScriptResult => {
  const json: Dict = {}
  const specific: Dict = {}
  const context = (outcome.additionalContext ?? []).filter((c) => c.trim() !== '').join('\n\n')
  if (event === 'PreToolUse') {
    // 返す判定は deny / ask だけ（allow は返さず、ユーザーの判断に委ねる）。deny が先。
    const decision = outcome.deny !== undefined ? 'deny' : outcome.ask !== undefined ? 'ask' : undefined
    if (decision !== undefined) {
      specific.permissionDecision = decision
      specific.permissionDecisionReason = outcome.deny ?? outcome.ask ?? ''
    }
  } else if (outcome.block !== undefined) {
    json.decision = 'block'
    json.reason = outcome.block
  }
  if (context !== '' && event !== 'Stop' && event !== 'SubagentStop' && event !== 'Notification') specific.additionalContext = context
  if (Object.keys(specific).length > 0) json.hookSpecificOutput = { hookEventName: event, ...specific }
  if (outcome.systemMessage) json.systemMessage = outcome.systemMessage
  if (outcome.preventContinuation) {
    json.continue = false
    if (outcome.stopReason !== undefined) json.stopReason = outcome.stopReason
  }
  return { exitCode: 0, stdout: Object.keys(json).length > 0 ? `${JSON.stringify(json)}\n` : '', stderr }
}

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

describe('systemMessage', () => {
  test('comes from stdout JSON (the Go output) or the step side channel', () => {
    expect(toOutcome('PostToolUse', ran(0, '{"systemMessage":"x"}'))).toEqual({ systemMessage: 'x' })
    expect(toOutcome('SessionStart', { ...ran(0), systemMessage: 'note' })).toEqual({ systemMessage: 'note' })
    expect(toOutcome('SessionStart', { ...ran(1), systemMessage: 'note' })).toEqual({})
  })
  test('merge joins with a newline and outcomeToClassic emits it at the top level', () => {
    const m = merge({ systemMessage: 'a' }, { systemMessage: 'b' })
    expect(m.systemMessage).toBe('a\nb')
    expect(merge({}, { systemMessage: 'b' }).systemMessage).toBe('b')
    expect(JSON.parse(outcomeToClassic('SessionStart', { systemMessage: 'hi', additionalContext: ['c'] }).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'c' },
      systemMessage: 'hi',
    })
  })
})
