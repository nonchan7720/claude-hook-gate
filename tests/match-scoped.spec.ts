import { describe, expect, test } from 'bun:test'
import { matchScoped } from '../src/feedback-rules.ts'

const src = '// TODO: a\nconst a = "TODO b"\nconst c = "ok" // TODO ok-note\n/* x\nTODO multi */\n'

describe('matchScoped', () => {
  test('no when -> undefined', () => {
    expect(matchScoped('x', 'a.ts', { scope: 'code' })).toBeUndefined()
  })
  test('no scope: content matched and line undefined', () => {
    const r = matchScoped(src, 'a.ts', { when: 'TODO' })
    expect(r).toEqual({ matched: true, detail: 'content matched: TODO' })
    expect(r?.line).toBeUndefined()
    expect(matchScoped(src, 'a.ts', { when: 'nomatch' })).toEqual({ matched: false, detail: '' })
  })
  test('scope all with unless on the whole text', () => {
    expect(matchScoped('a TODO\nok', 'a.ts', { when: 'TODO', unless: 'ok', scope: 'all' })?.matched).toBe(false)
  })
  test('comments: segment start line and detail', () => {
    const r = matchScoped(src, 'a.ts', { when: 'TODO', scope: 'comments' })
    expect(r).toEqual({ matched: true, detail: 'comment matched: TODO (line 1)', line: 1 })
  })
  test('comments: multi-line block reports its start line', () => {
    const r = matchScoped(src, 'a.ts', { when: 'multi', scope: 'comments' })
    expect(r?.line).toBe(4)
  })
  test('strings + unless is evaluated per segment', () => {
    const text = 'a = "TODO ok"\nb = "TODO bad"\n'
    const r = matchScoped(text, 'a.ts', { when: 'TODO', unless: 'ok', scope: 'strings' })
    expect(r).toEqual({ matched: true, detail: 'string matched: TODO (line 2)', line: 2 })
    // unless matches a different segment only: still a violation; across segments it must not suppress
    expect(matchScoped('a = "TODO"\nb = "ok"\n', 'a.ts', { when: 'TODO', unless: 'ok', scope: 'strings' })?.matched).toBe(true)
    expect(matchScoped('a = "TODO ok"\n', 'a.ts', { when: 'TODO', unless: 'ok', scope: 'strings' })?.matched).toBe(false)
  })
  test('code: comments and strings are blanked; unless applies to the blanked text', () => {
    const text = 'x = "foo" // foo\nfoo()\n'
    const r = matchScoped(text, 'a.ts', { when: 'foo', scope: 'code' })
    expect(r).toEqual({ matched: true, detail: 'code matched: foo' })
    expect(r?.line).toBeUndefined()
    expect(matchScoped('x = "foo" // foo\n', 'a.ts', { when: 'foo', scope: 'code' })?.matched).toBe(false)
    expect(matchScoped('foo() // ok\n', 'a.ts', { when: 'foo', unless: 'ok', scope: 'code' })?.matched).toBe(true)
    expect(matchScoped('foo() ok()\n', 'a.ts', { when: 'foo', unless: 'ok', scope: 'code' })?.matched).toBe(false)
  })
  test('unknown language: comments / strings find nothing, code evaluates the text as is', () => {
    expect(matchScoped('// foo', 'a.unknown', { when: 'foo', scope: 'comments' })?.matched).toBe(false)
    expect(matchScoped('// foo', 'a.unknown', { when: 'foo', scope: 'code' })?.matched).toBe(true)
  })
  test('lang overrides the extension', () => {
    expect(matchScoped('# foo', 'a.txt', { when: 'foo', scope: 'comments', lang: 'py' })?.line).toBe(1)
  })
})
