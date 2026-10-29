import { describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { hashKey, runShared, runWithSlot, type SharedOutcome, shareId } from '../src/shared-run.ts'
import { makeIo, sharedDirOf, waitForSharedLock, withTmp } from './helpers/node-io.ts'

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
      const shared = await sharedDirOf(proj)
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

  test("runs that cannot be shared do not overlap, and the waiters' file lists are batched into the next run", () =>
    withTmp(async (proj) => {
      let active = 0
      let peak = 0
      let runs = 0
      const ranWith: string[][] = []
      const execute = async (_pid: string[], files: string[]) => {
        runs++
        peak = Math.max(peak, ++active)
        ranWith.push(files)
        await sleep(300)
        active--
        return outcome(`run${runs}`)
      }
      const waited: string[] = []
      const call = (files: string[]) =>
        runShared(makeIo({ projectDir: proj }), 'k', files, 10_000, execute, {
          onWait: () => {
            waited.push(files.join(','))
          },
        })
      const first = call(['a.py'])
      await sleep(100) // a.py が実行側になってから b.py と c.py が来る
      const [r1] = await Promise.all([first, call(['b.py']), call(['c.py'])])
      // a.py の実行中に来た b.py と c.py は受け取れないので待ち、終わったあと 1 回にまとめて走る（一方が実行側、他方が受け取る）。
      expect(runs).toBe(2)
      expect(peak).toBe(1)
      expect(waited.sort()).toEqual(['b.py', 'c.py'])
      expect(ranWith).toEqual([['a.py'], ['b.py', 'c.py']])
      expect(r1.shared).toBe(false)
      // 置かれた一覧は消えている
      const shared = await sharedDirOf(proj)
      const queues = fs.readdirSync(shared).filter((f) => f.endsWith('.queue'))
      expect(queues.flatMap((q) => fs.readdirSync(path.join(shared, q)))).toEqual([])
    }))

  test('a stale request left by a dead waiter is dropped, not batched', () =>
    withTmp(async (proj) => {
      const queue = path.join(await sharedDirOf(proj), `${hashKey('k')}.queue`)
      fs.mkdirSync(queue, { recursive: true })
      fs.writeFileSync(path.join(queue, 'old.json'), JSON.stringify({ started: 1000, key: 'k', files: ['z.py'] }))
      fs.writeFileSync(path.join(queue, 'other.json'), JSON.stringify({ started: Date.now(), key: 'other', files: ['o.py'] }))
      let ranWith: string[] = []
      await runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async (_pid, files) => {
        ranWith = files
        return outcome('x')
      })
      expect(ranWith).toEqual(['a.py'])
      expect(fs.existsSync(path.join(queue, 'old.json'))).toBe(false)
      expect(fs.existsSync(path.join(queue, 'other.json'))).toBe(true) // 別のキーの分は、そのキーの実行側に残す
    }))

  test('different keys with the same serial do not overlap', () =>
    withTmp(async (proj) => {
      let active = 0
      let peak = 0
      const execute = async () => {
        peak = Math.max(peak, ++active)
        await sleep(300)
        active--
        return outcome('x')
      }
      await Promise.all(['k1', 'k2'].map((k) => runShared(makeIo({ projectDir: proj }), k, [], 10_000, execute, { serial: 's' })))
      expect(peak).toBe(1)
    }))

  test('a stale serial lock is taken over', () =>
    withTmp(async (proj) => {
      const shared = await sharedDirOf(proj)
      const lock = path.join(shared, `${hashKey('k')}.serial`)
      fs.mkdirSync(lock, { recursive: true })
      fs.writeFileSync(path.join(lock, 'info.json'), JSON.stringify({ started: 1000, timeoutMs: 1000 }))
      const r = await runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async () => outcome('mine'))
      expect(r.outcome.out).toBe('mine')
      expect(fs.existsSync(lock)).toBe(false)
    }))

  // ESC などで hook が止められ、ロックが残ったままになった状態を作る。
  const leftLock = async (proj: string, serial: string, info: Record<string, unknown>, pid?: number) => {
    const lock = path.join(await sharedDirOf(proj), `${hashKey(serial)}.serial`)
    fs.mkdirSync(lock, { recursive: true })
    fs.writeFileSync(path.join(lock, 'info.json'), JSON.stringify(info))
    if (pid !== undefined) fs.writeFileSync(path.join(lock, 'pid'), `${pid}\n`)
    return lock
  }

  test('a serial lock whose command process is gone is taken over at once, well before its timeout', () =>
    withTmp(async (proj) => {
      const dead = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim()
      const lock = await leftLock(proj, 'k', { started: Date.now(), timeoutMs: 600_000 }, Number(dead))
      const t0 = Date.now()
      const r = await runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async () => outcome('mine'))
      expect(r.outcome.out).toBe('mine')
      expect(Date.now() - t0).toBeLessThan(3000)
      expect(fs.existsSync(lock)).toBe(false)
    }))

  test('a serial lock without a pid long after its start is taken over', () =>
    withTmp(async (proj) => {
      await leftLock(proj, 'k', { started: Date.now() - 60_000, timeoutMs: 600_000 })
      const t0 = Date.now()
      const r = await runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async () => outcome('mine'))
      expect(r.outcome.out).toBe('mine')
      expect(Date.now() - t0).toBeLessThan(3000)
    }))

  test('a serial lock whose command is still running is waited for until the command ends', () =>
    withTmp(async (proj) => {
      const child = spawn('sleep', ['1'])
      const lock = await leftLock(proj, 'k', { started: Date.now(), timeoutMs: 600_000 }, child.pid)
      let endedAt = 0
      child.on('exit', () => {
        endedAt = Date.now()
      })
      let startedAt = 0
      const r = await runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async () => {
        startedAt = Date.now()
        return outcome('mine')
      })
      expect(r.outcome.out).toBe('mine')
      expect(endedAt).toBeGreaterThan(0)
      expect(startedAt).toBeGreaterThanOrEqual(endedAt)
      expect(fs.existsSync(lock)).toBe(false)
    }))

  test('when no lock can be created, it gives up coordinating and runs the command itself', () =>
    withTmp(async (proj) => {
      // shared/ がファイルなので mkdir できない。待ち続けず、ラウンドが尽きたら自分で実行する。
      const shared = await sharedDirOf(proj)
      fs.mkdirSync(path.dirname(shared), { recursive: true })
      fs.writeFileSync(shared, '')
      const r = await Promise.race([
        runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async () => outcome('mine')),
        sleep(4000).then(() => undefined),
      ])
      expect(r?.outcome.out).toBe('mine')
      expect(r?.shared).toBe(false)
    }))

  test('a leader whose command just ended but has not yet written its result is not taken over', () =>
    withTmp(async (proj) => {
      // 実行側のコマンドは終わった（PID は死んでいる）が、結果を書いてロックを外すのはこれから、という瞬間を作る。
      const dead = Number(spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim())
      const shared = await sharedDirOf(proj)
      const id = shareId('k', ['a.py'])
      const run = path.join(shared, `${id}.run`)
      fs.mkdirSync(run, { recursive: true })
      fs.writeFileSync(path.join(run, 'info.json'), JSON.stringify({ started: Date.now(), timeoutMs: 600_000, key: 'k', files: ['a.py'] }))
      fs.writeFileSync(path.join(run, 'pid'), `${dead}\n`)
      const serial = await leftLock(proj, 'k', { started: Date.now(), timeoutMs: 600_000 }, dead)
      const finish = sleep(400).then(() => {
        const leader = outcome('leader')
        fs.writeFileSync(path.join(shared, `${id}.result.json`), JSON.stringify({ key: 'k', files: ['a.py'], ...leader }))
        fs.rmSync(run, { recursive: true })
        fs.rmSync(serial, { recursive: true })
      })
      let runs = 0
      const r = await runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async () => {
        runs++
        return outcome('mine')
      })
      await finish
      expect(runs).toBe(0)
      expect(r.shared).toBe(true)
      expect(r.outcome.out).toBe('leader')
    }))

  test('the leader passes pid files inside both locks to execute, and both locks are gone afterwards', () =>
    withTmp(async (proj) => {
      let got: string[] = []
      await runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async (pidFiles) => {
        got = pidFiles
        return outcome('x')
      })
      expect(got.map((f) => path.basename(path.dirname(f)).split('.').pop())).toEqual(['serial', 'run'])
      expect(got.every((f) => path.basename(f) === 'pid')).toBe(true)
      expect(fs.readdirSync(await sharedDirOf(proj)).filter((n) => !n.endsWith('.result.json'))).toEqual([])
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
      const lock = path.join(await sharedDirOf(proj), `${shareId('k', ['a.py', 'b.py'])}.run`)
      fs.mkdirSync(lock, { recursive: true })
      fs.writeFileSync(path.join(lock, 'info.json'), JSON.stringify({ started: 1000, timeoutMs: 1000, key: 'k', files: ['a.py', 'b.py'] }))
      const r = await runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async () => outcome('mine'))
      expect(r.outcome.out).toBe('mine')
      expect(r.shared).toBe(false)
    }))

  test('a lock that has no info.json yet is waited on, then joined once the info appears', () =>
    withTmp(async (proj) => {
      const lock = path.join(await sharedDirOf(proj), `${shareId('k', ['a.py', 'b.py'])}.run`)
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
      const lock = path.join(await sharedDirOf(proj), `${shareId('k', ['a.py', 'b.py'])}.run`)
      fs.mkdirSync(lock, { recursive: true })
      const old = new Date(Date.now() - 60_000)
      fs.utimesSync(lock, old, old)
      const r = await runShared(makeIo({ projectDir: proj }), 'k', ['a.py'], 10_000, async () => outcome('mine'))
      expect(r.outcome.out).toBe('mine')
      expect(r.shared).toBe(false)
    }))
})

describe('maxParallel', () => {
  // 同時に走っている数のピークを数える execute。
  const counter = (ms: number) => {
    const state = { active: 0, peak: 0, runs: 0 }
    const execute = async () => {
      state.runs++
      state.peak = Math.max(state.peak, ++state.active)
      await sleep(ms)
      state.active--
      return outcome('x')
    }
    return { state, execute }
  }

  test('different commands run at most maxParallel at a time, and all of them run', () =>
    withTmp(async (proj) => {
      const { state, execute } = counter(250)
      await Promise.all(['k1', 'k2', 'k3', 'k4'].map((k) => runShared(makeIo({ projectDir: proj }), k, [], 10_000, execute, { maxParallel: 2 })))
      expect(state.runs).toBe(4)
      expect(state.peak).toBe(2)
      const shared = await sharedDirOf(proj)
      expect(fs.readdirSync(shared).filter((f) => fs.statSync(path.join(shared, f)).isDirectory())).toEqual([]) // 枠もロックも外れている
    }))

  test('maxParallel 0 means no limit', () =>
    withTmp(async (proj) => {
      const { state, execute } = counter(250)
      await Promise.all(['k1', 'k2', 'k3'].map((k) => runShared(makeIo({ projectDir: proj }), k, [], 10_000, execute, { maxParallel: 0 })))
      expect(state.peak).toBe(3)
    }))

  test('a slot left by a dead process is taken over', () =>
    withTmp(async (proj) => {
      const slot = path.join(await sharedDirOf(proj), 'slot.0')
      fs.mkdirSync(slot, { recursive: true })
      fs.writeFileSync(path.join(slot, 'info.json'), JSON.stringify({ started: 1000, timeoutMs: 1000 }))
      const r = await runShared(makeIo({ projectDir: proj }), 'k', [], 10_000, async () => outcome('mine'), { maxParallel: 1 })
      expect(r.outcome.out).toBe('mine')
      expect(fs.existsSync(slot)).toBe(false)
    }))

  test("runWithSlot (share: false) takes a slot too and writes the command's pid into it", () =>
    withTmp(async (proj) => {
      const { state, execute } = counter(250)
      let pidFiles: string[] = []
      const call = () =>
        runWithSlot(makeIo({ projectDir: proj }), 1, 10_000, async (p) => {
          pidFiles = p
          return execute()
        })
      await Promise.all([call(), call()])
      expect(state.peak).toBe(1)
      const shared = await sharedDirOf(proj)
      expect(pidFiles).toEqual([path.join(shared, 'slot.0', 'pid')])
      expect(fs.existsSync(path.join(shared, 'slot.0'))).toBe(false)
    }))
})
