import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runShared, type SharedOutcome, shareId } from '../src/shared-run.ts'
import { makeIo, waitForSharedLock, withTmp } from './helpers/node-io.ts'

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
        runShared(makeIo({ projectDir: proj }), 'k', [], 10_000, execute, {
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
      await Promise.all(['k1', 'k2'].map((k) => runShared(makeIo({ projectDir: proj }), k, [], 10_000, execute)))
      expect(runs).toBe(2)
    }))

  test('a finished run is not reused', () =>
    withTmp(async (proj) => {
      let runs = 0
      const execute = async () => outcome(`run${++runs}`)
      const first = await runShared(makeIo({ projectDir: proj }), 'k', [], 10_000, execute)
      const second = await runShared(makeIo({ projectDir: proj }), 'k', [], 10_000, execute)
      expect([first.outcome.out, second.outcome.out]).toEqual(['run1', 'run2'])
      expect(second.shared).toBe(false)
    }))

  test('a marker older than the timeout is taken over', () =>
    withTmp(async (proj) => {
      const shared = path.join(proj, '.claude', '.gate-status', 'shared')
      const lock = path.join(shared, `${shareId('k', [])}.run`)
      fs.mkdirSync(lock, { recursive: true })
      fs.writeFileSync(path.join(lock, 'info.json'), JSON.stringify({ started: 1000, timeoutMs: 1000, key: 'k', files: [] }))
      const r = await runShared(makeIo({ projectDir: proj }), 'k', [], 10_000, async () => outcome('mine'))
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
        runShared(makeIo({ projectDir: proj }), 'k', [], 10_000, execute),
        runShared(makeIo({ projectDir: proj }), 'k', [], 10_000, execute),
      ])
      expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1)
      const fulfilled = settled.filter((s) => s.status === 'fulfilled')
      expect(fulfilled).toHaveLength(1)
      expect(fulfilled[0]?.value.outcome.out).toBe('second')
    }))
})

describe('runShared with file lists', () => {
  // leader の info.json が現れてから waiter が来る。waiter が待ったか（= 結果を受け取ったか）と、実行回数を返す。
  const overlap = (proj: string, leaderFiles: string[], waiterFiles: string[]) => {
    let runs = 0
    const execute = async () => {
      runs++
      await sleep(500)
      return outcome(`run${runs}`)
    }
    const leader = runShared(makeIo({ projectDir: proj }), 'k', leaderFiles, 10_000, execute)
    const waiter = waitForSharedLock(proj).then(() => runShared(makeIo({ projectDir: proj }), 'k', waiterFiles, 10_000, execute))
    return Promise.all([leader, waiter]).then(([l, w]) => ({ runs, leader: l, waiter: w }))
  }

  test('a waiter whose files are a subset of the running ones receives its outcome', () =>
    withTmp(async (proj) => {
      const r = await overlap(proj, ['a.py', 'b.py'], ['a.py'])
      expect(r.runs).toBe(1)
      expect(r.waiter.shared).toBe(true)
      expect(r.waiter.outcome).toEqual(outcome('run1'))
    }))

  test('the same file list is shared', () =>
    withTmp(async (proj) => {
      const r = await overlap(proj, ['b.py', 'a.py'], ['a.py', 'b.py'])
      expect(r.runs).toBe(1)
      expect(r.waiter.shared).toBe(true)
    }))

  test('a waiter whose files are not a subset runs it itself', () =>
    withTmp(async (proj) => {
      const r = await overlap(proj, ['a.py'], ['a.py', 'b.py'])
      expect(r.runs).toBe(2)
      expect(r.waiter.shared).toBe(false)
    }))

  test('disjoint file lists run separately', () =>
    withTmp(async (proj) => {
      const r = await overlap(proj, ['a.py'], ['b.py'])
      expect(r.runs).toBe(2)
      expect(r.waiter.shared).toBe(false)
    }))

  test('an empty file list is contained in any running list', () =>
    withTmp(async (proj) => {
      const r = await overlap(proj, ['a.py'], [])
      expect(r.runs).toBe(1)
      expect(r.waiter.shared).toBe(true)
    }))

  test('a running empty list does not cover a waiter with files', () =>
    withTmp(async (proj) => {
      const r = await overlap(proj, [], ['a.py'])
      expect(r.runs).toBe(2)
      expect(r.waiter.shared).toBe(false)
    }))

  test('a run with a different key is not joined even when the files match', () =>
    withTmp(async (proj) => {
      let runs = 0
      const execute = async () => {
        runs++
        await sleep(300)
        return outcome('x')
      }
      await Promise.all([
        runShared(makeIo({ projectDir: proj }), 'k1', ['a.py'], 10_000, execute),
        runShared(makeIo({ projectDir: proj }), 'k2', ['a.py'], 10_000, execute),
      ])
      expect(runs).toBe(2)
    }))

  test('a stale superset lock is taken over instead of waited for', () =>
    withTmp(async (proj) => {
      const lock = path.join(proj, '.claude', '.gate-status', 'shared', `${shareId('k', ['a.py', 'b.py'])}.run`)
      fs.mkdirSync(lock, { recursive: true })
      fs.writeFileSync(path.join(lock, 'info.json'), JSON.stringify({ started: 1000, timeoutMs: 1000, key: 'k', files: ['a.py', 'b.py'] }))
      const r = await runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async () => outcome('mine'))
      expect(r.outcome.out).toBe('mine')
      expect(r.shared).toBe(false)
    }))

  test('a lock that has no info.json yet is waited on, then joined once the info appears', () =>
    withTmp(async (proj) => {
      const lock = path.join(proj, '.claude', '.gate-status', 'shared', `${shareId('k', ['a.py', 'b.py'])}.run`)
      fs.mkdirSync(lock, { recursive: true })
      let runs = 0
      const waiter = runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async () => outcome(`run${++runs}`))
      await sleep(200)
      fs.writeFileSync(path.join(lock, 'info.json'), JSON.stringify({ started: Date.now(), timeoutMs: 10_000, key: 'k', files: ['a.py', 'b.py'] }))
      await sleep(200)
      fs.writeFileSync(`${lock.slice(0, -'.run'.length)}.result.json`, JSON.stringify({ key: 'k', files: ['a.py', 'b.py'], ...outcome('theirs') }))
      fs.rmSync(lock, { recursive: true })
      const r = await waiter
      expect(runs).toBe(0)
      expect(r.shared).toBe(true)
      expect(r.outcome).toEqual(outcome('theirs'))
    }))

  test('a lock that never gets an info.json is taken over after the grace period', () =>
    withTmp(async (proj) => {
      const lock = path.join(proj, '.claude', '.gate-status', 'shared', `${shareId('k', ['a.py', 'b.py'])}.run`)
      fs.mkdirSync(lock, { recursive: true })
      const old = new Date(Date.now() - 60_000)
      fs.utimesSync(lock, old, old)
      const r = await runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async () => outcome('mine'))
      expect(r.outcome.out).toBe('mine')
      expect(r.shared).toBe(false)
    }))
})
