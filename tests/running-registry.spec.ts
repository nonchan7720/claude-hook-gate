import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Io } from '../src/io.ts'
import { gateStatusDir, listRunning, mergeRunning, type RunningEntry, runningBand, runningLines } from '../src/running-registry.ts'
import { makeIo, withTmp } from './helpers/node-io.ts'

// 一覧のファイルは Go 版の gate（internal/hookgate/running_registry.go の PublishRunning）が書く。ここでは同じ形で置く。
const publishRunning = async (io: Io, owner: string, entries: readonly RunningEntry[]): Promise<void> => {
  const dir = path.join(gateStatusDir(io), 'running')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${owner}.json`), JSON.stringify(entries))
}

const T0 = 1_000_000

describe('running registry', () => {
  test('entries of every owner are merged in start order', () =>
    withTmp(async (proj) => {
      const io = makeIo({ projectDir: proj, now: () => T0 + 10_000 })
      await publishRunning(io, 's.b', [{ name: 'late', cmd: 'x', started: T0 + 5000 }])
      await publishRunning(io, 's.a', [
        { name: 'first', cmd: 'x', started: T0 },
        { name: 'second', cmd: 'x', started: T0 + 1000, result: 'ok' },
      ])
      expect((await listRunning(io, 's')).map((e) => e.name)).toEqual(['first', 'second', 'late'])
    }))

  test('entries left behind by a dead process are ignored once they are old enough', () =>
    withTmp(async (proj) => {
      const old = makeIo({ projectDir: proj, now: () => T0 })
      await publishRunning(old, 's.dead', [{ name: 'dead', cmd: 'x', started: T0 }])
      const later = makeIo({ projectDir: proj, now: () => T0 + 3_600_000 })
      expect(await listRunning(later, 's')).toEqual([])
    }))

  test('only the own session (main and its subagents) is listed, not another session or a mere id prefix match', () =>
    withTmp(async (proj) => {
      const io = makeIo({ projectDir: proj, now: () => T0 })
      await publishRunning(io, 'sess.x1', [{ name: 'main', cmd: 'x', started: T0 }])
      await publishRunning(io, 'sess--agent.x2', [{ name: 'sub', cmd: 'x', started: T0 + 1 }])
      await publishRunning(io, 'other.x3', [{ name: 'other', cmd: 'x', started: T0 }])
      await publishRunning(io, 'sess2.x4', [{ name: 'prefix', cmd: 'x', started: T0 }])
      await publishRunning(io, 'sess2--agent.x5', [{ name: 'prefix-sub', cmd: 'x', started: T0 + 1 }])
      expect((await listRunning(io, 'sess')).map((e) => e.name)).toEqual(['main', 'sub'])
      expect((await listRunning(io, 'sess2')).map((e) => e.name)).toEqual(['prefix', 'prefix-sub'])
    }))

  test('mergeRunning skips broken files', () => {
    const entries = mergeRunning(['not json', '{}', JSON.stringify([{ name: 'a', cmd: 'x', started: T0 }])], T0)
    expect(entries.map((e) => e.name)).toEqual(['a'])
  })
})

describe('runningLines', () => {
  test('a heading, then running, finished and waiting entries one per line, indented by two spaces', () => {
    const lines = runningLines(
      [
        { name: 'a', cmd: 'sleep 1', started: T0 },
        { name: 'b', cmd: 'x', started: T0, result: 'ok', ended: T0 + 500 },
        { name: 'c', cmd: 'x', started: T0, result: 'fail', ended: T0 + 1200 },
        { name: 'd', cmd: 'z', started: T0 + 1000, waiting: true },
        { cmd: 'exit 1', started: T0 },
      ],
      T0 + 3000,
      'ja',
    )
    expect(lines).toEqual(['[gate] 実行中:', '  a $ sleep 1 (3s)', '  b ✓ (0.5s)', '  c ✗ (1.2s)', '  d $ z 待機中 (2s)', '  exit 1 (3s)'])
  })

  test('a finished entry keeps its duration on later renders', () => {
    const e = { name: 'b', cmd: 'x', started: T0, result: 'ok' as const, ended: T0 + 600 }
    expect(runningLines([e], T0 + 600, 'ja')).toEqual(runningLines([e], T0 + 60_000, 'ja'))
  })

  test('a long cmd is cut at a word boundary with " ..." so the line stays within the limit', () => {
    const cmd = "find scripts/renovate -name '*_test.sh' -print0 | xargs -0 -P0 -n1 bash -c 'echo hello world'"
    const [, line] = runningLines([{ name: 'renovate-scripts-test', cmd, started: T0 }], T0 + 12_000, 'ja')
    expect(line).toBe("  renovate-scripts-test $ find scripts/renovate -name '*_test.sh' ... (12s)")
    expect((line as string).length).toBeLessThanOrEqual(80)
  })

  test('a multi-line cmd is folded into one line', () => {
    const [, line] = runningLines([{ name: 'm', cmd: 'echo a\n  echo b', started: T0 }], T0, 'ja')
    expect(line).toBe('  m $ echo a ... (0s)')
  })

  test('an entry without a name is shown by its folded cmd', () => {
    const [, line] = runningLines([{ cmd: 'echo a\necho b', started: T0, result: 'fail', ended: T0 + 100 }], T0, 'ja')
    expect(line).toBe('  echo a ... ✗ (0.1s)')
  })
})

describe('language', () => {
  test('heading and waiting marker are English when lang is en', () => {
    const entries = [
      { name: 'a', cmd: 'sleep 1', started: T0 },
      { name: 'd', cmd: 'z', started: T0 + 1000, waiting: true },
    ]
    expect(runningLines(entries, T0 + 3000, 'en')).toEqual(['[gate] running:', '  a $ sleep 1 (3s)', '  d $ z waiting (2s)'])
  })
})

describe('runningBand', () => {
  const done: RunningEntry = { name: 'a', cmd: 'x', started: T0, result: 'ok', ended: T0 + 700 }
  const running: RunningEntry = { name: 'b', cmd: 'sleep 9', started: T0 }

  test('is a column of one Text per line while something is unfinished', () => {
    expect(runningBand([done, running], T0 + 8000, 'ja')).toEqual({
      type: 'Box',
      props: { flexDirection: 'column' },
      children: ['[gate] 実行中:', '  a ✓ (0.7s)', '  b $ sleep 9 (8s)'].map((line) => ({ type: 'Text', children: [line] })),
    })
  })

  test('is absent when nothing is listed or everything has finished', () => {
    expect(runningBand([], T0, 'ja')).toBeUndefined()
    expect(runningBand([done], T0, 'ja')).toBeUndefined()
  })
})
