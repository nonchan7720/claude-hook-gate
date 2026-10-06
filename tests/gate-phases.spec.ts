import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
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
  touch,
  writeChangedFiles,
  writeGateYaml,
  writePending,
} from './helpers/gate.ts'
import { withTmp } from './helpers/node-io.ts'

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
      ok(await checks(proj))
      expect(exists(used)).toBe(true)
      expect(exists(unused)).toBe(false)
    }))

  test('success confirms and clears sidecar and pending', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['true'])
      ok(await rules(proj))
      ok(await checks(proj))
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

      ok(await checks(proj))
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
      ok(await checks(proj))
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

  test('success has no decision field', () =>
    withTmp(async (proj) => {
      setupReservedCheckProject(proj, 'sess1', ['true'])
      ok(await rules(proj))
      const r = await checks(proj, 'sess1', { stopHookActive: false })
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
