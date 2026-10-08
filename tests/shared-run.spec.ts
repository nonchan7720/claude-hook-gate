import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { hashKey, runShared, type SharedOutcome } from '../src/shared-run.ts'
import { makeIo, withTmp } from './helpers/node-io.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const outcome = (out: string, ok = true): SharedOutcome => ({ out, ok, timedOut: false, logpath: `/log/${out}` })

describe('runShared', () => {
  test('concurrent callers with the same key execute once and share the outcome', () =>
    withTmp(async (proj) => {
      let runs = 0
      const execute = async () => {
        runs++
        await sleep(400)
        return outcome(`run${runs}`, false)
      }
      const waited: string[] = []
      const call = (who: string) =>
        runShared(makeIo({ projectDir: proj }), 'k', 10_000, execute, {
          onWait: () => {
            waited.push(who)
          },
        })
      const results = await Promise.all([call('a'), call('b')])
      expect(runs).toBe(1)
      expect(results.map((r) => r.outcome)).toEqual([outcome('run1', false), outcome('run1', false)])
      expect(results.map((r) => r.shared).sort()).toEqual([false, true])
      expect(waited).toHaveLength(1)
    }))

  test('different keys execute in parallel', () =>
    withTmp(async (proj) => {
      let runs = 0
      const execute = async () => {
        runs++
        await sleep(300)
        return outcome('x')
      }
      await Promise.all(['k1', 'k2'].map((k) => runShared(makeIo({ projectDir: proj }), k, 10_000, execute)))
      expect(runs).toBe(2)
    }))

  test('a finished run is not reused', () =>
    withTmp(async (proj) => {
      let runs = 0
      const execute = async () => outcome(`run${++runs}`)
      const first = await runShared(makeIo({ projectDir: proj }), 'k', 10_000, execute)
      const second = await runShared(makeIo({ projectDir: proj }), 'k', 10_000, execute)
      expect([first.outcome.out, second.outcome.out]).toEqual(['run1', 'run2'])
      expect(second.shared).toBe(false)
    }))

  test('a marker older than the timeout is taken over', () =>
    withTmp(async (proj) => {
      const shared = path.join(proj, '.claude', '.gate-status', 'shared')
      const lock = path.join(shared, `${hashKey('k')}.run`)
      fs.mkdirSync(lock, { recursive: true })
      fs.writeFileSync(path.join(lock, 'info.json'), JSON.stringify({ started: 1000, timeoutMs: 1000 }))
      const r = await runShared(makeIo({ projectDir: proj }), 'k', 10_000, async () => outcome('mine'))
      expect(r.outcome.out).toBe('mine')
      expect(r.shared).toBe(false)
    }))

  test('when the executing side throws, the waiting side runs it itself', () =>
    withTmp(async (proj) => {
      let runs = 0
      const execute = async () => {
        runs++
        if (runs === 1) {
          await sleep(300)
          throw new Error('boom')
        }
        return outcome('second')
      }
      const settled = await Promise.allSettled([
        runShared(makeIo({ projectDir: proj }), 'k', 10_000, execute),
        runShared(makeIo({ projectDir: proj }), 'k', 10_000, execute),
      ])
      expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1)
      const fulfilled = settled.filter((s) => s.status === 'fulfilled')
      expect(fulfilled).toHaveLength(1)
      expect(fulfilled[0]?.value.outcome.out).toBe('second')
    }))
})
