import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Dict } from '../src/pyutil.ts'
import { resetGate } from '../src/reset-gate.ts'
import { deferredPath, exists, pendingPath, tracePath, writeDeferred, writeGateYaml, writePending, writeTraceRecords } from './helpers/gate.ts'
import { makeIo, withTmp } from './helpers/node-io.ts'

const run = (proj: string, sessionId = 'sess1', source: string | null = 'startup') => {
  const payload: Dict = { session_id: sessionId }
  if (source !== null) payload.source = source
  return resetGate(makeIo({ projectDir: proj }), payload)
}

const OLD = 1 // 1970 年付近（秒）
const age = (p: string) => fs.utimesSync(p, OLD, OLD)

function makeStateFiles(proj: string, id: string): string[] {
  const dir = path.join(proj, '.claude', '.gate-status')
  fs.mkdirSync(dir, { recursive: true })
  const files = [`changed_files.${id}.txt`, `gate_attempts.${id}.txt`, `gate_passed.${id}.txt`, `gate_pending_checks.${id}.json`].map((n) => path.join(dir, n))
  const contents = ['a.py\n', '1\n', 'b.py\n', '{"go-build": ["c.py"]}\n']
  for (const [i, f] of files.entries()) fs.writeFileSync(f, contents[i] as string)
  return files
}

const LEGACY_NAMES = [
  'changed_files.{sid}.txt',
  'gate_attempts.{sid}.txt',
  'gate_passed.{sid}.txt',
  'gate_pending_checks.{sid}.json',
  'gate_trace.{sid}.jsonl',
  'gate_deferred.{sid}.json',
  'gate_push_verified.{sid}.txt',
  'gate_reported.{sid}.txt',
  'feedback_gate_attempts.{sid}.txt',
]

/** 移行前の置き場所（.claude/ 直下と .claude/hooks/logs/<state_id>/）に残った状態ファイル。 */
function makeLegacyStateFiles(proj: string, id: string): string[] {
  const claudeDir = path.join(proj, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  const paths = LEGACY_NAMES.map((n) => path.join(claudeDir, n.replace('{sid}', id)))
  for (const p of paths) fs.writeFileSync(p, 'x\n')
  const logDir = path.join(claudeDir, 'hooks', 'logs', id)
  fs.mkdirSync(logDir, { recursive: true })
  const log = path.join(logDir, 'cmd.1.log')
  fs.writeFileSync(log, 'x\n')
  paths.push(log)
  return paths
}

function makeFeedbackAttempts(proj: string, id: string): string {
  const dir = path.join(proj, '.claude', '.gate-status')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `feedback_gate_attempts.${id}.txt`)
  fs.writeFileSync(p, '1\n')
  return p
}

function makePolicyState(proj: string, id: string): string[] {
  writeTraceRecords(proj, id, [{ ts: 1, root: proj, cwd: proj, name: 'n', cmd: 'c', kind: 'request' }])
  writeDeferred(proj, id, [{ root: proj, cwd: proj, name: 'n', cmd: 'c', timeout: 300, label: '.' }])
  return [tracePath(proj, id), deferredPath(proj, id)]
}

const allGone = (files: string[]) => {
  for (const f of files) expect(exists(f)).toBe(false)
}
const allKept = (files: string[]) => {
  for (const f of files) expect(exists(f)).toBe(true)
}

describe('reset-gate by SessionStart source', () => {
  test('deletes state on startup and clear, prints nothing', () =>
    withTmp(async (proj) => {
      const files = makeStateFiles(proj, 'sess1')
      const r = await run(proj, 'sess1', 'startup')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toBe('')
      allGone(files)
      const files2 = makeStateFiles(proj, 'sess1')
      await run(proj, 'sess1', 'clear')
      allGone(files2)
    }))

  test('deletes bash_started on startup and keeps it on resume', () =>
    withTmp(async (proj) => {
      const dir = path.join(proj, '.claude', '.gate-status')
      fs.mkdirSync(dir, { recursive: true })
      const files = ['bash_started.sess1.json', 'bash_started.sess1--agent1.json', 'bash_started.sess1--toolu_01.json'].map((n) => path.join(dir, n))
      for (const f of files) fs.writeFileSync(f, '{"tool_use_id":"t","started":1}\n')
      await run(proj, 'sess1', 'resume')
      allKept(files)
      await run(proj, 'sess1', 'startup')
      allGone(files)
    }))

  test('keeps state on resume, compact, unknown source and missing source', () =>
    withTmp(async (proj) => {
      const files = makeStateFiles(proj, 'sess1')
      for (const source of ['resume', 'compact', 'something-new', null]) {
        const r = await run(proj, 'sess1', source)
        expect(r.exitCode).toBe(0)
        expect(r.stdout).toBe('')
        allKept(files)
      }
    }))

  test('agent suffixed state is deleted on startup / clear and kept on resume', () =>
    withTmp(async (proj) => {
      const files = makeStateFiles(proj, 'sess1--agent1')
      await run(proj, 'sess1', 'resume')
      allKept(files)
      await run(proj, 'sess1', 'startup')
      allGone(files)
      const files2 = makeStateFiles(proj, 'sess1--agent1')
      await run(proj, 'sess1', 'clear')
      allGone(files2)
    }))

  test('always prunes stale sessions regardless of source', () =>
    withTmp(async (proj) => {
      const cur = makeStateFiles(proj, 'sess-current')
      const stale = makeStateFiles(proj, 'sess-stale')
      for (const f of stale) age(f)
      const r = await run(proj, 'sess-current', 'resume')
      expect(r.exitCode).toBe(0)
      allKept(cur)
      allGone(stale)
    }))
})

describe('reset-gate legacy paths', () => {
  test('deletes legacy state on startup', () =>
    withTmp(async (proj) => {
      const files = [...makeLegacyStateFiles(proj, 'sess1'), ...makeLegacyStateFiles(proj, 'sess1--agent1')]
      expect((await run(proj, 'sess1', 'startup')).exitCode).toBe(0)
      allGone(files)
    }))

  test('keeps legacy state on resume', () =>
    withTmp(async (proj) => {
      const files = makeLegacyStateFiles(proj, 'sess1')
      expect((await run(proj, 'sess1', 'resume')).exitCode).toBe(0)
      allKept(files)
    }))

  test('prunes stale legacy state regardless of source', () =>
    withTmp(async (proj) => {
      const stale = makeLegacyStateFiles(proj, 'sess-stale')
      for (const f of stale) age(f)
      age(path.dirname(stale[stale.length - 1] as string))
      expect((await run(proj, 'sess-current', 'resume')).exitCode).toBe(0)
      allGone(stale)
    }))

  test('does not touch gate.yaml', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [] })
      await run(proj, 'sess1', 'startup')
      expect(exists(path.join(proj, '.claude', 'gate.yaml'))).toBe(true)
    }))
})

describe('reset-gate feedback attempts', () => {
  test('deletes on startup / clear, agent suffixed too', () =>
    withTmp(async (proj) => {
      const a = makeFeedbackAttempts(proj, 'sess1')
      await run(proj, 'sess1', 'startup')
      allGone([a])
      const b = makeFeedbackAttempts(proj, 'sess1')
      await run(proj, 'sess1', 'clear')
      allGone([b])
      const c = makeFeedbackAttempts(proj, 'sess1--agent1')
      await run(proj, 'sess1', 'startup')
      allGone([c])
    }))

  test('keeps on resume, prunes stale ones', () =>
    withTmp(async (proj) => {
      const cur = makeFeedbackAttempts(proj, 'sess1')
      const agent = makeFeedbackAttempts(proj, 'sess1--agent1')
      await run(proj, 'sess1', 'resume')
      allKept([cur, agent])

      const stale = makeFeedbackAttempts(proj, 'sess-stale')
      age(stale)
      await run(proj, 'sess1', 'resume')
      allGone([stale])
      allKept([cur])
    }))
})

describe('reset-gate pending files', () => {
  test('removes pending files including agent suffixed, on startup', () =>
    withTmp(async (proj) => {
      writePending(proj, 'sess1', { [proj]: { chk: ['x.py'] } })
      writePending(proj, 'sess1--agent1', { [proj]: { chk: ['y.py'] } })
      expect((await run(proj, 'sess1', 'startup')).exitCode).toBe(0)
      allGone([pendingPath(proj, 'sess1'), pendingPath(proj, 'sess1--agent1')])
    }))

  test('keeps pending file on resume, prunes a stale one', () =>
    withTmp(async (proj) => {
      writePending(proj, 'sess1', { [proj]: { chk: ['x.py'] } })
      writePending(proj, 'sess-stale', { [proj]: { chk: ['x.py'] } })
      age(pendingPath(proj, 'sess-stale'))
      await run(proj, 'sess1', 'resume')
      allKept([pendingPath(proj, 'sess1')])
      allGone([pendingPath(proj, 'sess-stale')])
    }))
})

describe('reset-gate policy state (trace / deferred)', () => {
  test('deletes on startup and agent suffixed on clear', () =>
    withTmp(async (proj) => {
      const a = makePolicyState(proj, 'sess1')
      await run(proj, 'sess1', 'startup')
      allGone(a)
      const b = makePolicyState(proj, 'sess1--agent1')
      await run(proj, 'sess1', 'clear')
      allGone(b)
    }))

  test('keeps on resume, prunes stale regardless of source', () =>
    withTmp(async (proj) => {
      const cur = makePolicyState(proj, 'sess1')
      await run(proj, 'sess1', 'resume')
      allKept(cur)
      const stale = makePolicyState(proj, 'sess-stale')
      for (const f of stale) age(f)
      await run(proj, 'sess-current', 'resume')
      allGone(stale)
    }))
})

describe('reset-gate status summary', () => {
  const summary = (proj: string, sessionId = 'sess1') => path.join(proj, '.claude', '.gate-status', `summary.${sessionId}.txt`)
  const put = (proj: string, sessionId = 'sess1') => {
    fs.mkdirSync(path.dirname(summary(proj, sessionId)), { recursive: true })
    fs.writeFileSync(summary(proj, sessionId), '[gate] 完了: ✓ 1 (0.1s)')
  }

  test('the kept gate summary is deleted on startup / clear and kept on resume', () =>
    withTmp(async (proj) => {
      put(proj)
      await run(proj, 'sess1', 'resume')
      expect(exists(summary(proj))).toBe(true)
      await run(proj, 'sess1', 'startup')
      expect(exists(summary(proj))).toBe(false)
      put(proj)
      await run(proj, 'sess1', 'clear')
      expect(exists(summary(proj))).toBe(false)
    }))

  test('another session summary is left alone', () =>
    withTmp(async (proj) => {
      put(proj, 'sess1')
      put(proj, 'sess2')
      await run(proj, 'sess1', 'startup')
      expect(exists(summary(proj, 'sess1'))).toBe(false)
      expect(exists(summary(proj, 'sess2'))).toBe(true)
    }))

  test('prunes a stale summary of another session regardless of source', () =>
    withTmp(async (proj) => {
      put(proj, 'sess-stale')
      put(proj, 'sess-live')
      age(summary(proj, 'sess-stale'))
      await run(proj, 'sess-current', 'resume')
      expect(exists(summary(proj, 'sess-stale'))).toBe(false)
      expect(exists(summary(proj, 'sess-live'))).toBe(true)
    }))
})
