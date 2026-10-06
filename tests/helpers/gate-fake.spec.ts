import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readCalls, writeFakeDogwood } from './gate.ts'
import { withTmp } from './node-io.ts'

test('fake dogwood is executable and answers with the configured verdict', () =>
  withTmp((dir) => {
    const [bin, calls] = writeFakeDogwood(dir, { verdict: 'deny' })
    const out = execFileSync(bin, ['replay', 'p.dw'], { encoding: 'utf8' })
    expect(JSON.parse(out)).toEqual({ verdicts: [{ index: 0, verdict: 'deny' }] })
    expect(readCalls(calls)[0]?.argv).toEqual(['replay', 'p.dw'])
  }))
