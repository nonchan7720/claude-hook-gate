import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runGate } from '../src/gate.ts'
import {
  attemptsCount,
  attemptsPath,
  changedLines,
  changedPath,
  checks,
  exists,
  gate,
  newGate,
  pendingPath,
  read,
  readPending,
  rules,
  setupReservedCheckProject,
  sidecarPath,
  statePath,
  touch,
  writeChangedFiles,
  writeGateYaml,
  writePending,
} from './helpers/gate.ts'
import { makeIo, withTmp } from './helpers/node-io.ts'

const ok = (r: { exitCode: number }) => expect(r.exitCode).toBe(0)

describe('rules phase does not run consistency checks', () => {
  test('consistency checks are not executed', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'chk.marker')
      setupReservedCheckProject(proj, 'sess1', [`touch ${marker}`])
      ok(await rules(proj))
      expect(exists(marker)).toBe(false)
    }))
})

describe('rules phase persists the reservation', () => {
  test('reservation is written to the pending file', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['true'])
      ok(await rules(proj))
      expect(readPending(proj, 'sess1')).toEqual({ [proj]: { chk: ['x.py'] } })
    }))

  test('reservation accumulates across multiple rules phase runs', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }], consistency_checks: [{ name: 'chk', run: ['true'] }] })
      writeChangedFiles(proj, 'sess1', 'a.py')
      ok(await rules(proj))
      writeChangedFiles(proj, 'sess1', 'b.py')
      ok(await rules(proj))
      expect(readPending(proj, 'sess1')).toEqual({ [proj]: { chk: ['a.py', 'b.py'] } })
    }))

  test('matched file moves from changed to sidecar, pending confirmation', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['true'])
      ok(await rules(proj))
      expect(exists(changedPath(proj, 'sess1'))).toBe(false)
      expect(read(sidecarPath(proj, 'sess1')).split(/\s+/).filter(Boolean)).toEqual(['x.py'])
    }))
})

describe('checks phase runs only reserved checks', () => {
  test('only the referenced check runs', () =>
    withTmp(async (proj) => {
      const used = path.join(proj, 'used.marker')
      const unused = path.join(proj, 'unused.marker')
      setupReservedCheckProject(proj, 'sess1', [`touch ${used}`], { name: 'chk-unused', run: [`touch ${unused}`] })
      ok(await rules(proj))
      ok(await checks(proj, 'sess1', { stopHookActive: true }))
      expect(exists(used)).toBe(true)
      expect(exists(unused)).toBe(false)
    }))

  test('success confirms and clears sidecar and pending', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['true'])
      ok(await rules(proj))
      ok(await checks(proj, 'sess1', { stopHookActive: true }))
      expect(exists(sidecarPath(proj, 'sess1'))).toBe(false)
      expect(exists(pendingPath(proj, 'sess1'))).toBe(false)
      expect(exists(changedPath(proj, 'sess1'))).toBe(false)
    }))
})

describe('checks phase is a noop when empty', () => {
  test('no pending file is a noop', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [], consistency_checks: [] })
      ok(await checks(proj))
      expect(exists(attemptsPath(proj, 'sess1'))).toBe(false)
    }))

  test('empty pending object is removed and is a noop', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [], consistency_checks: [] })
      writePending(proj, 'sess1', {})
      ok(await checks(proj))
      expect(exists(pendingPath(proj, 'sess1'))).toBe(false)
    }))
})

describe('pending root isolation', () => {
  test('same named check runs independently per root', () =>
    withTmp(async (proj) => {
      const mainMarker = path.join(proj, 'main_chk.marker')
      fs.mkdirSync(path.join(proj, 'docs'))
      writeGateYaml(proj, {
        rules: [{ match: 'docs/*.md', dir: 'docs', run: ['true'], run_checks: ['chk'] }],
        consistency_checks: [{ name: 'chk', run: [`touch ${mainMarker}`] }],
      })
      const wt = path.join(proj, '.claude', 'worktrees', 'agent-a1')
      fs.mkdirSync(path.join(wt, 'pkg'), { recursive: true })
      const wtMarker = path.join(wt, 'wt_chk.marker')
      writeGateYaml(wt, {
        rules: [{ match: 'pkg/*.go', dir: 'pkg', run: ['true'], run_checks: ['chk'] }],
        consistency_checks: [{ name: 'chk', run: [`touch ${wtMarker}`] }],
      })
      const absFile = path.join(wt, 'pkg', 'foo.go')
      writeChangedFiles(proj, 'sess1', 'docs/readme.md', absFile)

      ok(await rules(proj))
      const data = readPending(proj, 'sess1')
      expect(new Set(Object.keys(data))).toEqual(new Set([proj, wt]))
      expect(data[proj]).toEqual({ chk: ['docs/readme.md'] })
      expect(data[wt]).toEqual({ chk: [absFile] })

      ok(await checks(proj, 'sess1', { stopHookActive: true }))
      expect(exists(mainMarker)).toBe(true)
      expect(exists(wtMarker)).toBe(true)
    }))

  test('only the root with a reservation runs its check', () =>
    withTmp(async (proj) => {
      const mainMarker = path.join(proj, 'main_chk.marker')
      fs.mkdirSync(path.join(proj, 'docs'))
      writeGateYaml(proj, {
        rules: [{ match: 'docs/*.md', dir: 'docs', run: ['true'], run_checks: ['chk'] }],
        consistency_checks: [{ name: 'chk', run: [`touch ${mainMarker}`] }],
      })
      const wt = path.join(proj, '.claude', 'worktrees', 'agent-a2')
      fs.mkdirSync(wt, { recursive: true })
      const wtMarker = path.join(wt, 'wt_chk.marker')
      writeGateYaml(wt, { rules: [], consistency_checks: [{ name: 'chk', run: [`touch ${wtMarker}`] }] })
      writeChangedFiles(proj, 'sess1', 'docs/readme.md')

      ok(await rules(proj))
      expect(Object.keys(readPending(proj, 'sess1'))).toEqual([proj])
      ok(await checks(proj, 'sess1', { stopHookActive: true }))
      expect(exists(mainMarker)).toBe(true)
      expect(exists(wtMarker)).toBe(false)
    }))
})

describe('cleanup', () => {
  test('cleanup removes the pending file', () =>
    withTmp(async (proj) => {
      writePending(proj, 'sess1', { [proj]: { chk: ['x.py'] } })
      const g = newGate(proj, 'sess1')
      expect(exists(pendingPath(proj, 'sess1'))).toBe(true)
      await g.cleanup()
      expect(exists(pendingPath(proj, 'sess1'))).toBe(false)
    }))

  test('cleanup only count and pending keeps changed and sidecar', () =>
    withTmp(async (proj) => {
      writeChangedFiles(proj, 'sess1', 'a.py')
      writePending(proj, 'sess1', { [proj]: { chk: ['x.py'] } })
      const g = newGate(proj, 'sess1')
      fs.writeFileSync(g.count, '3')
      await g.cleanup([g.count, g.pending])
      expect(exists(g.count)).toBe(false)
      expect(exists(g.pending)).toBe(false)
      expect(exists(g.changed)).toBe(true)
    }))
})

describe('checks phase max attempts requeues to changed', () => {
  test('max attempts requeues and keeps changed, removes count and pending', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['false'])
      ok(await rules(proj))
      expect(exists(sidecarPath(proj, 'sess1'))).toBe(true)
      expect(exists(pendingPath(proj, 'sess1'))).toBe(true)
      expect(exists(changedPath(proj, 'sess1'))).toBe(false)

      let r = await checks(proj)
      for (let i = 1; i < 5; i++) r = await checks(proj, 'sess1', { stopHookActive: true })
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('systemMessage')
      expect(r.stdout).toContain('未検証のまま CHANGED へ戻しました')
      expect(r.stdout).toContain('手動で確認してください')
      expect(r.stdout).toContain('reset-gate')

      expect(exists(attemptsPath(proj, 'sess1'))).toBe(false)
      expect(exists(pendingPath(proj, 'sess1'))).toBe(false)
      expect(exists(sidecarPath(proj, 'sess1'))).toBe(false)
      expect(read(changedPath(proj, 'sess1')).split(/\s+/).filter(Boolean)).toEqual(['x.py'])
    }))

  test('attempts accumulate across checks phase retries', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['false'])
      ok(await rules(proj))
      let r = await checks(proj, 'sess1', { stopHookActive: true })
      for (let i = 1; i < 4; i++) r = await checks(proj, 'sess1', { stopHookActive: true })
      expect(r.exitCode).toBe(2)
      expect(attemptsCount(proj, 'sess1')).toBe('4')
    }))

  test('attempts reset when stop hook is not active', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['false'])
      ok(await rules(proj))
      const r1 = await checks(proj, 'sess1', { stopHookActive: false })
      expect(r1.exitCode).toBe(2)
      expect(attemptsCount(proj, 'sess1')).toBe('1')
      const r2 = await checks(proj, 'sess1', { stopHookActive: false })
      expect(r2.exitCode).toBe(2)
      expect(attemptsCount(proj, 'sess1')).toBe('1')
    }))
})

describe('rules phase does not block the conversation', () => {
  test('failure exits 2 with stderr and no stdout decision', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['echo BOOM && false'] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      const r = await rules(proj)
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain('BOOM')
      expect(r.stdout).not.toContain('decision')
    }))
})

describe('checks phase failure stdout', () => {
  test('exits 2 with parseable json stdout', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['echo BOOM && false'])
      ok(await rules(proj))
      const r = await checks(proj, 'sess1', { stopHookActive: false })
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain('BOOM')
      const payload = JSON.parse(r.stdout) as { decision?: string; reason?: string }
      expect(payload.decision).toBe('block')
      expect(payload.reason).toBeTruthy()
    }))

  test('json stdout survives a "no such file" stderr', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['cat /no/such/file/here 2>&1; false'])
      ok(await rules(proj))
      const r = await checks(proj, 'sess1', { stopHookActive: false })
      expect(r.exitCode).toBe(2)
      expect(r.stderr.toLowerCase()).toContain('no such file')
      expect(r.stdout.trim()).not.toBe('')
      expect(() => JSON.parse(r.stdout)).not.toThrow()
    }))

  test('success under stop_hook_active has no decision field', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['true'])
      ok(await rules(proj))
      const r = await checks(proj, 'sess1', { stopHookActive: true })
      expect(r.exitCode).toBe(0)
      if (r.stdout.trim()) expect(JSON.parse(r.stdout)).not.toHaveProperty('decision')
    }))

  test('max attempts giveup has no decision field', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['false'])
      ok(await rules(proj))
      let r = await checks(proj, 'sess1', { stopHookActive: false })
      for (let i = 1; i < 5; i++) r = await checks(proj, 'sess1', { stopHookActive: true })
      expect(r.exitCode).toBe(0)
      expect(JSON.parse(r.stdout)).not.toHaveProperty('decision')
    }))
})

describe('worktree grouping (rules phase)', () => {
  test('worktree path uses the worktree gate.yaml and cwd', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.md', run: ['true'] }] })
      const wt = path.join(proj, '.claude', 'worktrees', 'agent-a1')
      const pkgDir = path.join(wt, 'pkg')
      fs.mkdirSync(pkgDir, { recursive: true })
      writeGateYaml(wt, { rules: [{ match: 'pkg/*.go', dir: 'pkg', run: ['touch ok.marker'] }] })
      writeChangedFiles(proj, 'sess1', path.join(wt, 'pkg', 'foo.go'))
      ok(await rules(proj))
      expect(exists(path.join(pkgDir, 'ok.marker'))).toBe(true)
      expect(exists(changedPath(proj, 'sess1'))).toBe(false)
    }))

  test('missing worktree gate.yaml falls back to the main cfg', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: 'pkg/*.go', dir: 'pkg', run: ['touch fallback.marker'] }] })
      const wt = path.join(proj, '.claude', 'worktrees', 'agent-a2')
      const pkgDir = path.join(wt, 'pkg')
      fs.mkdirSync(pkgDir, { recursive: true })
      writeChangedFiles(proj, 'sess1', path.join(wt, 'pkg', 'foo.go'))
      ok(await rules(proj))
      // メインの cfg のルールが、cwd は proj/pkg ではなく wt/pkg で実行された
      expect(exists(path.join(pkgDir, 'fallback.marker'))).toBe(true)
      expect(exists(path.join(proj, 'pkg'))).toBe(false)
    }))

  test('main and worktree mixed memo runs both roots', () =>
    withTmp(async (proj) => {
      fs.mkdirSync(path.join(proj, 'docs'))
      writeGateYaml(proj, { rules: [{ match: 'docs/*.md', dir: 'docs', run: ['touch main.marker'] }] })
      const wt = path.join(proj, '.claude', 'worktrees', 'agent-a3')
      const pkgDir = path.join(wt, 'pkg')
      fs.mkdirSync(pkgDir, { recursive: true })
      writeGateYaml(wt, { rules: [{ match: 'pkg/*.go', dir: 'pkg', run: ['touch wt.marker'] }] })
      writeChangedFiles(proj, 'sess1', 'docs/readme.md', path.join(wt, 'pkg', 'foo.go'))
      ok(await rules(proj))
      expect(exists(path.join(proj, 'docs', 'main.marker'))).toBe(true)
      expect(exists(path.join(pkgDir, 'wt.marker'))).toBe(true)
      expect(exists(changedPath(proj, 'sess1'))).toBe(false)
    }))

  test('failure writes back the raw representation', () =>
    withTmp(async (proj) => {
      fs.mkdirSync(path.join(proj, 'docs'))
      writeGateYaml(proj, { rules: [{ match: 'docs/*.md', dir: 'docs', run: ['touch main.marker'] }] })
      const wt = path.join(proj, '.claude', 'worktrees', 'agent-a4')
      fs.mkdirSync(path.join(wt, 'pkg'), { recursive: true })
      writeGateYaml(wt, { rules: [{ match: 'pkg/*.go', dir: 'pkg', run: ['false'] }] })
      const absFile = path.join(wt, 'pkg', 'foo.go')
      writeChangedFiles(proj, 'sess1', 'docs/readme.md', absFile)
      const r = await rules(proj, 'sess1', { stopHookActive: false })
      expect(r.exitCode).toBe(2)
      // worktree 分は失敗したので元の絶対パス表記のまま CHANGED に残る
      expect(changedLines(proj, 'sess1')).toEqual([absFile])
      // main 分は run_checks が無いので、成功済みとして完全に手を離している（SIDECAR には退避しない）
      expect(exists(sidecarPath(proj, 'sess1'))).toBe(false)
    }))

  test('missing worktree directory is skipped with a warning', () =>
    withTmp(async (proj) => {
      fs.mkdirSync(path.join(proj, 'docs'))
      writeGateYaml(proj, { rules: [{ match: 'docs/*.md', dir: 'docs', run: ['touch main.marker'] }] })
      const ghost = path.join(proj, '.claude', 'worktrees', 'agent-ghost', 'pkg', 'foo.go')
      writeChangedFiles(proj, 'sess1', 'docs/readme.md', ghost)
      ok(await rules(proj))
      expect(exists(path.join(proj, 'docs', 'main.marker'))).toBe(true)
      expect(exists(changedPath(proj, 'sess1'))).toBe(false)
    }))

  test('missing worktree directory is consumed, others continue on failure', () =>
    withTmp(async (proj) => {
      fs.mkdirSync(path.join(proj, 'a'))
      writeGateYaml(proj, { rules: [{ match: 'a/*.txt', dir: 'a', run: ['false'] }] })
      const ghost = path.join(proj, '.claude', 'worktrees', 'agent-ghost', 'pkg', 'foo.go')
      writeChangedFiles(proj, 'sess1', 'a/x.txt', ghost)
      const r = await rules(proj, 'sess1', { stopHookActive: false })
      expect(r.exitCode).toBe(2)
      expect(changedLines(proj, 'sess1')).toEqual(['a/x.txt'])
      expect(exists(sidecarPath(proj, 'sess1'))).toBe(false)
    }))
})

describe('agent id state files', () => {
  test('rules phase uses suffixed changed and pending files', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }], consistency_checks: [{ name: 'chk', run: ['true'] }] })
      writeChangedFiles(proj, 'sess1--agent1', 'x.py')
      ok(await rules(proj, 'sess1', { agentId: 'agent1' }))
      expect(exists(pendingPath(proj, 'sess1--agent1'))).toBe(true)
      expect(exists(pendingPath(proj, 'sess1'))).toBe(false)
    }))

  test('checks phase uses the suffixed attempts file', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1--agent1', ['false'])
      ok(await rules(proj, 'sess1', { agentId: 'agent1' }))
      const r = await checks(proj, 'sess1', { stopHookActive: false, agentId: 'agent1' })
      expect(r.exitCode).toBe(2)
      expect(exists(attemptsPath(proj, 'sess1--agent1'))).toBe(true)
      expect(exists(attemptsPath(proj, 'sess1'))).toBe(false)
    }))

  test('main session rules phase ignores another agent memo', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['true'] }] })
      writeChangedFiles(proj, 'sess1--agent1', 'other_agent_file.py')
      ok(await rules(proj))
      // 実行中の別エージェントのメモには手を付けない
      expect(exists(changedPath(proj, 'sess1--agent1'))).toBe(true)
    }))
})

describe('gate without gate.yaml', () => {
  test('is a no-op', () =>
    withTmp(async (proj) => {
      touch(proj, 'x.py')
      const r = await gate(proj, 'sess1', { phase: 'rules' })
      expect(r).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    }))
})

// 実行中は帯（redraw のたびの bandLog）に複数行で出し、全部終わったら帯を消してステータス行（resultLog）に 1 行の結果を残す。
describe('progress band', () => {
  // rules フェーズで consistency_checks を予約しておく（checks フェーズは予約分しか実行しない）。
  const setup = async (proj: string, run: unknown[]) => {
    writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }], consistency_checks: [{ name: 'chk', run }] })
    writeChangedFiles(proj, 'sess1', 'x.py')
    ok(await rules(proj))
  }
  const makeClock = () => {
    const clock = { t: 1_000_000, fns: new Set<() => void>() }
    return {
      clock,
      every: (_ms: number, fn: () => void) => {
        clock.fns.add(fn)
        return () => void clock.fns.delete(fn)
      },
      advance: (ms: number) => {
        clock.t += ms
        for (const f of [...clock.fns]) f()
      },
    }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test('checks phase draws the running command in the band, redraws elapsed seconds, then hides it and leaves one result line', () =>
    withTmp(async (proj) => {
      await setup(proj, [{ cmd: 'sleep 0.4', name: 'slow' }])
      const bandLog: Array<string | undefined> = []
      const resultLog: Array<string | undefined> = []
      const progressLog: Array<string | undefined> = []
      const c = makeClock()
      const io = makeIo({ projectDir: proj, bandLog, resultLog, progressLog, now: () => c.clock.t, every: c.every })
      const p = runGate(io, { sessionId: 'sess1', phase: 'checks', stopHookActive: true })
      await sleep(150)
      c.advance(35_000)
      await sleep(50)
      ok(await p)
      expect(bandLog[0]).toBe('[gate] 実行中:\n  slow $ sleep 0.4 (0s)')
      expect(bandLog).toContain('[gate] 実行中:\n  slow $ sleep 0.4 (35s)')
      expect(bandLog.at(-1)).toBeUndefined()
      expect(resultLog.at(-1)).toMatch(/^\[gate\] 完了: ✓ 1 \(\d+\.\ds\)$/)
      expect(progressLog).toEqual([])
      expect(c.clock.fns.size).toBe(0)
    }))

  test('parallel commands are listed together and finished ones stay with a check mark', () =>
    withTmp(async (proj) => {
      await setup(proj, [
        {
          parallel: [
            { cmd: 'sleep 0.4', name: 'a' },
            { cmd: 'sleep 0.1', name: 'b' },
          ],
        },
      ])
      const bandLog: Array<string | undefined> = []
      const resultLog: Array<string | undefined> = []
      const io = makeIo({ projectDir: proj, bandLog, resultLog })
      ok(await runGate(io, { sessionId: 'sess1', phase: 'checks', stopHookActive: true }))
      expect(bandLog).toContain('[gate] 実行中:\n  a $ sleep 0.4 (0s)\n  b $ sleep 0.1 (0s)')
      expect(bandLog.some((l) => /^\[gate\] 実行中:\n {2}a \$ sleep 0\.4 \(0s\)\n {2}b ✓ \(\d+\.\ds\)$/.test(l ?? ''))).toBe(true)
      // 全部終わったら帯は消え、結果は帯ではなくステータス行に 1 行で出る。
      expect(bandLog.at(-1)).toBeUndefined()
      expect(resultLog.at(-1)).toMatch(/^\[gate\] 完了: ✓ 2 \(\d+\.\ds\)$/)
    }))

  test('a failed command stays with a cross mark and a command without a name is shown by its cmd', () =>
    withTmp(async (proj) => {
      await setup(proj, [
        {
          parallel: [{ cmd: 'sleep 0.3', name: 'a' }, { cmd: 'exit 1' }],
        },
      ])
      const bandLog: Array<string | undefined> = []
      const resultLog: Array<string | undefined> = []
      const io = makeIo({ projectDir: proj, bandLog, resultLog })
      await runGate(io, { sessionId: 'sess1', phase: 'checks' })
      expect(bandLog.some((l) => /^\[gate\] 実行中:\n {2}a \$ sleep 0\.3 \(0s\)\n {2}exit 1 ✗ \(\d+\.\ds\)$/.test(l ?? ''))).toBe(true)
      expect(bandLog.at(-1)).toBeUndefined()
      expect(resultLog.at(-1)).toMatch(/^\[gate\] 完了: ✓ 1 \/ ✗ 1 \(\d+\.\ds\)$/)
    }))

  test('sequential commands: each result lands on the status line, and the next command clears it and returns to the band', () =>
    withTmp(async (proj) => {
      await setup(proj, [
        { cmd: 'true', name: 'first' },
        { cmd: 'sleep 0.1', name: 'second' },
      ])
      const bandLog: Array<string | undefined> = []
      const resultLog: Array<string | undefined> = []
      const io = makeIo({ projectDir: proj, bandLog, resultLog })
      ok(await runGate(io, { sessionId: 'sess1', phase: 'checks', stopHookActive: true }))
      expect(bandLog.some((l) => /^\[gate\] 実行中:\n {2}first ✓ \(\d+\.\ds\)\n {2}second \$ sleep 0\.1 \(0s\)$/.test(l ?? ''))).toBe(true)
      expect(bandLog.at(-1)).toBeUndefined()
      // 結果 → 次の開始で消える → 結果、の順。
      expect(resultLog.map((l) => (l === undefined ? 'clear' : l.replace(/\d+\.\ds/g, 'Ns')))).toEqual([
        'clear',
        '[gate] 完了: ✓ 1 (Ns)',
        'clear',
        '[gate] 完了: ✓ 2 (Ns)',
      ])
    }))

  test('rules phase draws the running command in the same format', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [{ cmd: 'true', name: 'fmt' }] }] })
      writeChangedFiles(proj, 'sess1', 'x.py')
      const bandLog: Array<string | undefined> = []
      const resultLog: Array<string | undefined> = []
      ok(await runGate(makeIo({ projectDir: proj, bandLog, resultLog }), { sessionId: 'sess1', phase: 'rules' }))
      expect(bandLog[0]).toBe('[gate] 実行中:\n  fmt $ true (0s)')
      expect(bandLog.at(-1)).toBeUndefined()
      expect(resultLog.at(-1)).toMatch(/^\[gate\] 完了: ✓ 1 \(\d+\.\ds\)$/)
    }))
})

describe('checks phase reports success once', () => {
  const reportedPath = (proj: string, id: string) => statePath(proj, 'gate_reported', id, 'txt')
  const countLines = (p: string) => (exists(p) ? read(p).split('\n').filter(Boolean).length : 0)
  const reasonOf = (stdout: string): string => (JSON.parse(stdout.trim().split('\n').at(-1) as string) as { reason: string }).reason

  const setupNamed = (proj: string, extra: Record<string, unknown> = {}) => {
    writeGateYaml(proj, {
      ...extra,
      rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
      consistency_checks: [
        {
          name: 'chk',
          run: [
            { cmd: 'true', name: 'lint' },
            { cmd: 'true', name: 'typecheck' },
          ],
        },
      ],
    })
    writeChangedFiles(proj, 'sess1', 'x.py')
  }

  test('blocks with the executed commands when everything passed', () =>
    withTmp(async (proj) => {
      setupNamed(proj)
      ok(await rules(proj))
      const r = await checks(proj)
      expect(r.exitCode).toBe(2)
      const body = JSON.parse(r.stdout.trim().split('\n').at(-1) as string)
      expect(body.decision).toBe('block')
      expect(body.reason).toContain('[gate] 検証がすべて通りました: lint ✓ / typecheck ✓')
      expect(body.reason).toContain('報告')
      expect(exists(reportedPath(proj, 'sess1'))).toBe(true)
    }))

  test('the success report is in English when the language is en', () =>
    withTmp(async (proj) => {
      setupNamed(proj)
      ok(await rules(proj, 'sess1', { lang: 'en' }))
      const r = await checks(proj, 'sess1', { lang: 'en' })
      expect(r.exitCode).toBe(2)
      const body = JSON.parse(r.stdout.trim().split('\n').at(-1) as string)
      expect(body.reason).toBe('[gate] All checks passed: lint ✓ / typecheck ✓. Report this result to the user and finish.')
      expect(r.stderr).not.toMatch(/[ぁ-んァ-ン一-龥]/)
    }))

  test('does not block when stop_hook_active is true', () =>
    withTmp(async (proj) => {
      setupNamed(proj)
      ok(await rules(proj))
      ok(await checks(proj, 'sess1', { stopHookActive: true }))
      expect(exists(reportedPath(proj, 'sess1'))).toBe(false)
    }))

  test('does not block when nothing was executed', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [], consistency_checks: [] })
      writePending(proj, 'sess1', {})
      ok(await checks(proj))
      expect(exists(reportedPath(proj, 'sess1'))).toBe(false)
    }))

  test('report_success: false disables the report', () =>
    withTmp(async (proj) => {
      setupNamed(proj, { report_success: false })
      ok(await rules(proj))
      const r = await checks(proj)
      ok(r)
      expect(r.stdout).toContain('成功')
      expect(exists(reportedPath(proj, 'sess1'))).toBe(false)
    }))

  test('the stop right after a success report runs no command and drops the marker', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'runs.marker')
      setupReservedCheckProject(proj, 'sess1', [`echo x >> ${marker}`])
      ok(await rules(proj))
      expect((await checks(proj)).exitCode).toBe(2)
      expect(countLines(marker)).toBe(1)

      // 予約が残っていても走らせない
      writePending(proj, 'sess1', { [proj]: { chk: ['x.py'] } })
      const followUp = await checks(proj, 'sess1', { stopHookActive: true })
      ok(followUp)
      expect(followUp.reportConsumed).toBe(true)
      expect(countLines(marker)).toBe(1)
      expect(exists(reportedPath(proj, 'sess1'))).toBe(false)
      expect(exists(pendingPath(proj, 'sess1'))).toBe(true)
    }))

  test('a new user turn after a report still runs the checks', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'runs.marker')
      setupReservedCheckProject(proj, 'sess1', [`echo x >> ${marker}`])
      ok(await rules(proj))
      expect((await checks(proj)).exitCode).toBe(2)
      writePending(proj, 'sess1', { [proj]: { chk: ['x.py'] } })
      const next = await checks(proj)
      expect(next.exitCode).toBe(2)
      expect(next.reportConsumed).toBeUndefined()
      expect(countLines(marker)).toBe(2)
    }))

  test('after a failure block the next stop reruns the checks', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'runs.marker')
      setupReservedCheckProject(proj, 'sess1', [`echo x >> ${marker}; exit 1`])
      ok(await rules(proj))
      const first = await checks(proj)
      expect(first.exitCode).toBe(2)
      expect(reasonOf(first.stdout)).toContain('consistency checks 失敗')
      expect(exists(reportedPath(proj, 'sess1'))).toBe(false)
      const second = await checks(proj, 'sess1', { stopHookActive: true })
      expect(second.exitCode).toBe(2)
      expect(countLines(marker)).toBe(2)
    }))
})
