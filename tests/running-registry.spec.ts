import { describe, expect, test } from 'bun:test'
import {
  finishedSummary,
  listRunning,
  mergeRunning,
  publishRunning,
  type RunningEntry,
  runningBand,
  runningLines,
  withdrawRunning,
} from '../src/running-registry.ts'
import { makeIo, withTmp } from './helpers/node-io.ts'

const T0 = 1_000_000

describe('running registry', () => {
  test('entries of every owner are merged in start order', () =>
    withTmp(async (proj) => {
      const io = makeIo({ projectDir: proj, now: () => T0 + 10_000 })
      await publishRunning(io, 'b', [{ name: 'late', cmd: 'x', started: T0 + 5000 }])
      await publishRunning(io, 'a', [
        { name: 'first', cmd: 'x', started: T0 },
        { name: 'second', cmd: 'x', started: T0 + 1000, result: 'ok' },
      ])
      expect((await listRunning(io)).map((e) => e.name)).toEqual(['first', 'second', 'late'])
    }))

  test('withdrawing one owner keeps the others', () =>
    withTmp(async (proj) => {
      const io = makeIo({ projectDir: proj, now: () => T0 })
      await publishRunning(io, 'a', [{ name: 'a', cmd: 'x', started: T0 }])
      await publishRunning(io, 'b', [{ name: 'b', cmd: 'x', started: T0 }])
      await withdrawRunning(io, 'a')
      expect((await listRunning(io)).map((e) => e.name)).toEqual(['b'])
    }))

  test('entries left behind by a dead process are ignored once they are old enough', () =>
    withTmp(async (proj) => {
      const old = makeIo({ projectDir: proj, now: () => T0 })
      await publishRunning(old, 'dead', [{ name: 'dead', cmd: 'x', started: T0 }])
      const later = makeIo({ projectDir: proj, now: () => T0 + 3_600_000 })
      expect(await listRunning(later)).toEqual([])
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
    )
    expect(lines).toEqual(['[gate] 実行中:', '  a $ sleep 1 (3s)', '  b ✓ (0.5s)', '  c ✗ (1.2s)', '  d $ z 待機中 (2s)', '  exit 1 (3s)'])
  })

  test('a finished entry keeps its duration on later renders', () => {
    const e = { name: 'b', cmd: 'x', started: T0, result: 'ok' as const, ended: T0 + 600 }
    expect(runningLines([e], T0 + 600)).toEqual(runningLines([e], T0 + 60_000))
  })

  test('a long cmd is cut at a word boundary with " ..." so the line stays within the limit', () => {
    const cmd = "find scripts/renovate -name '*_test.sh' -print0 | xargs -0 -P0 -n1 bash -c 'echo hello world'"
    const [, line] = runningLines([{ name: 'renovate-scripts-test', cmd, started: T0 }], T0 + 12_000)
    expect(line).toBe("  renovate-scripts-test $ find scripts/renovate -name '*_test.sh' ... (12s)")
    expect((line as string).length).toBeLessThanOrEqual(80)
  })

  test('a multi-line cmd is folded into one line', () => {
    const [, line] = runningLines([{ name: 'm', cmd: 'echo a\n  echo b', started: T0 }], T0)
    expect(line).toBe('  m $ echo a ... (0s)')
  })

  test('an entry without a name is shown by its folded cmd', () => {
    const [, line] = runningLines([{ cmd: 'echo a\necho b', started: T0, result: 'fail', ended: T0 + 100 }], T0)
    expect(line).toBe('  echo a ... ✗ (0.1s)')
  })
})

describe('runningBand', () => {
  const done: RunningEntry = { name: 'a', cmd: 'x', started: T0, result: 'ok', ended: T0 + 700 }
  const running: RunningEntry = { name: 'b', cmd: 'sleep 9', started: T0 }

  test('is a column of one Text per line while something is unfinished', () => {
    expect(runningBand([done, running], T0 + 8000)).toEqual({
      type: 'Box',
      props: { flexDirection: 'column' },
      children: ['[gate] 実行中:', '  a ✓ (0.7s)', '  b $ sleep 9 (8s)'].map((line) => ({ type: 'Text', children: [line] })),
    })
  })

  test('is absent when nothing is listed or everything has finished', () => {
    expect(runningBand([], T0)).toBeUndefined()
    expect(runningBand([done], T0)).toBeUndefined()
  })
})

describe('finishedSummary', () => {
  test('shows only the counts of passed and failed checks plus the elapsed seconds', () => {
    const entries: RunningEntry[] = [
      { name: 'a', cmd: 'x', started: T0, result: 'ok', ended: T0 + 700 },
      { name: 'b', cmd: 'x', started: T0, result: 'ok', ended: T0 + 200 },
      { name: 'c', cmd: 'x', started: T0, result: 'ok', ended: T0 + 300 },
      { name: 'd', cmd: 'x', started: T0, result: 'ok', ended: T0 + 400 },
      { name: 'e', cmd: 'x', started: T0, result: 'ok', ended: T0 + 500 },
      { name: 'f', cmd: 'x', started: T0, result: 'fail', ended: T0 + 81_000 },
    ]
    expect(finishedSummary(entries)).toBe('[gate] 完了: ✓ 5 / ✗ 1 (81.0s)')
  })

  test('omits the failure count when nothing failed', () => {
    const entries: RunningEntry[] = [
      { name: 'a', cmd: 'x', started: T0, result: 'ok', ended: T0 + 700 },
      { name: 'b', cmd: 'x', started: T0, result: 'ok', ended: T0 + 81_000 },
    ]
    expect(finishedSummary(entries)).toBe('[gate] 完了: ✓ 2 (81.0s)')
  })

  test('omits the success count when nothing passed', () => {
    const entries: RunningEntry[] = [
      { name: 'a', cmd: 'x', started: T0, result: 'fail', ended: T0 + 12_300 },
      { name: 'b', cmd: 'x', started: T0, result: 'fail', ended: T0 + 100 },
    ]
    expect(finishedSummary(entries)).toBe('[gate] 完了: ✗ 2 (12.3s)')
  })

  test('the seconds span the first start to the last end, not the sum of the checks', () => {
    const entries: RunningEntry[] = [
      { name: 'a', cmd: 'x', started: T0, result: 'ok', ended: T0 + 10_000 },
      { name: 'b', cmd: 'x', started: T0 + 2000, result: 'ok', ended: T0 + 12_000 },
      { name: 'c', cmd: 'x', started: T0 + 5000, result: 'ok', ended: T0 + 8000 },
    ]
    expect(finishedSummary(entries)).toBe('[gate] 完了: ✓ 3 (12.0s)')
  })

  test('is absent while something is unfinished or when nothing ran', () => {
    expect(finishedSummary([])).toBeUndefined()
    expect(finishedSummary([{ name: 'a', cmd: 'x', started: T0 }])).toBeUndefined()
  })
})
