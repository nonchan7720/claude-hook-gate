import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { filesEnv, Gate, runGate } from '../src/gate.ts'
import { checks, readTraceRecords, rules, writeChangedFiles, writeDeferred, writeGateYaml } from './helpers/gate.ts'
import { MISSING_DOGWOOD_BIN, makeIo, sharedDirOf, waitForSharedLock, withTmp } from './helpers/node-io.ts'

const count = (file: string): number => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0)
const logFiles = (proj: string, stateId: string): string[] => {
  const dir = path.join(proj, '.claude', '.gate-status', 'logs', stateId)
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

type Logs = { bandLog?: Array<string | undefined>; resultLog?: Array<string | undefined> }

const agentGate = (proj: string, agentId: string, logs: Logs = {}) =>
  new Gate(makeIo({ projectDir: proj, env: { DOGWOOD_BIN: MISSING_DOGWOOD_BIN }, ...logs }), { sessionId: 'sess1', agentId, phase: 'rules' })

describe('two agents running the same command', () => {
  const setup = (proj: string, tail: string, extra: Record<string, unknown> = {}) => {
    const marker = path.join(proj, 'marker.txt')
    writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [{ cmd: `echo r >> ${marker}; sleep 0.5; ${tail}`, name: 'slow', ...extra }] }] })
    writeChangedFiles(proj, 'sess1--a1', 'x.py')
    writeChangedFiles(proj, 'sess1--a2', 'x.py')
    return marker
  }
  const both = () => (proj: string) => Promise.all([rules(proj, 'sess1', { agentId: 'a1' }), rules(proj, 'sess1', { agentId: 'a2' })])

  test('the command runs once, both get the same success, and both keep a trace and a log', () =>
    withTmp(async (proj) => {
      const marker = setup(proj, 'true')
      const [r1, r2] = await both()(proj)
      expect(count(marker)).toBe(1)
      expect([r1.exitCode, r2.exitCode]).toEqual([0, 0])
      for (const id of ['sess1--a1', 'sess1--a2']) {
        expect(readTraceRecords(proj, id).map((r) => r.kind)).toContain('response')
        expect(logFiles(proj, id).length).toBeGreaterThan(0)
      }
    }))

  test('both get the same failure', () =>
    withTmp(async (proj) => {
      const marker = setup(proj, 'echo boom; exit 1')
      const [r1, r2] = await both()(proj)
      expect(count(marker)).toBe(1)
      expect([r1.exitCode, r2.exitCode]).toEqual([2, 2])
      expect(r1.stderr).toContain('boom')
      expect(r2.stderr).toContain('boom')
      for (const id of ['sess1--a1', 'sess1--a2']) expect(readTraceRecords(proj, id).map((r) => r.kind)).toContain('error')
    }))

  test('the waiting side logs the shared output in its own log directory', () =>
    withTmp(async (proj) => {
      setup(proj, 'echo shared-output')
      await both()(proj)
      for (const id of ['sess1--a1', 'sess1--a2']) {
        const dir = path.join(proj, '.claude', '.gate-status', 'logs', id)
        const text = logFiles(proj, id)
          .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
          .join('\n')
        expect(text).toContain('shared-output')
      }
    }))

  test('share: false runs it twice even when concurrent', () =>
    withTmp(async (proj) => {
      const marker = setup(proj, 'true', { share: false })
      const [r1, r2] = await both()(proj)
      expect(count(marker)).toBe(2)
      expect([r1.exitCode, r2.exitCode]).toEqual([0, 0])
    }))

  test('files: false in gate.yaml runs it once even when the agents changed different files', () =>
    withTmp(async (proj) => {
      const marker = setup(proj, 'true', { files: false })
      writeChangedFiles(proj, 'sess1--a2', 'y.py')
      await both()(proj)
      expect(count(marker)).toBe(1)
    }))

  test('a differing CLAUDE_GATE_FILES runs it twice', () =>
    withTmp(async (proj) => {
      const marker = setup(proj, 'true')
      writeChangedFiles(proj, 'sess1--a2', 'y.py')
      await both()(proj)
      expect(count(marker)).toBe(2)
    }))
})

describe('the share key', () => {
  const run = (proj: string, agentId: string, cmd: string, cwd: string, env = filesEnv(['x.py'])) =>
    agentGate(proj, agentId).execOne('l', cmd, cwd, 10, '', 'n', env, { root: proj })
  const cmd = (marker: string, tag = '') => `echo r >> ${marker}; sleep 0.4 # ${tag}`

  test('the same root, cwd, cmd and files share one run even though the agent ids differ', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      await Promise.all([run(proj, 'a1', cmd(marker), proj), run(proj, 'a2', cmd(marker), proj)])
      expect(count(marker)).toBe(1)
    }))

  test('a differing cwd runs twice', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      fs.mkdirSync(path.join(proj, 'd1'))
      fs.mkdirSync(path.join(proj, 'd2'))
      await Promise.all([run(proj, 'a1', cmd(marker), path.join(proj, 'd1')), run(proj, 'a2', cmd(marker), path.join(proj, 'd2'))])
      expect(count(marker)).toBe(2)
    }))

  test('a differing cmd runs twice', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      await Promise.all([run(proj, 'a1', cmd(marker, 'a'), proj), run(proj, 'a2', cmd(marker, 'b'), proj)])
      expect(count(marker)).toBe(2)
    }))

  test('a differing CLAUDE_GATE_FILES runs twice', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      await Promise.all([run(proj, 'a1', cmd(marker), proj, filesEnv(['x.py'])), run(proj, 'a2', cmd(marker), proj, filesEnv(['y.py']))])
      expect(count(marker)).toBe(2)
    }))

  test('files: false shares the run even though CLAUDE_GATE_FILES differ', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      const g = (id: string, files: string[]) => agentGate(proj, id).execOne('l', cmd(marker), proj, 10, '', 'n', filesEnv(files), { root: proj, files: false })
      await Promise.all([g('a1', ['x.py']), g('a2', ['y.py', 'z.py'])])
      expect(count(marker)).toBe(1)
    }))

  test('files: false with share: false still runs twice', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      const g = (id: string, files: string[]) =>
        agentGate(proj, id).execOne('l', cmd(marker), proj, 10, '', 'n', filesEnv(files), { root: proj, share: false, files: false })
      await Promise.all([g('a1', ['x.py']), g('a2', ['y.py'])])
      expect(count(marker)).toBe(2)
    }))

  test('files that are a subset of the running ones share the run', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      const pa = run(proj, 'a1', cmd(marker), proj, filesEnv(['x.py', 'y.py']))
      await waitForSharedLock(proj)
      const pb = run(proj, 'a2', cmd(marker), proj, filesEnv(['x.py']))
      await Promise.all([pa, pb])
      expect(count(marker)).toBe(1)
    }))

  test('files that are not a subset of the running ones run separately', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      const pa = run(proj, 'a1', cmd(marker), proj, filesEnv(['x.py']))
      await waitForSharedLock(proj)
      const pb = run(proj, 'a2', cmd(marker), proj, filesEnv(['x.py', 'y.py']))
      await Promise.all([pa, pb])
      expect(count(marker)).toBe(2)
    }))

  test('a differing CLAUDE_GATE_FILES runs twice, one after the other', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      const c = `echo start >> ${marker}; sleep 0.4; echo end >> ${marker}`
      await Promise.all([run(proj, 'a1', c, proj, filesEnv(['x.py'])), run(proj, 'a2', c, proj, filesEnv(['y.py']))])
      expect(fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean)).toEqual(['start', 'end', 'start', 'end'])
    }))

  test('the same cmd in the rules phase of one agent and the checks phase of another runs one after the other', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      const c = `echo start >> ${marker}; sleep 0.4; echo end >> ${marker}`
      const g = (id: string, phase: string) =>
        new Gate(makeIo({ projectDir: proj, env: { DOGWOOD_BIN: MISSING_DOGWOOD_BIN } }), { sessionId: 'sess1', agentId: id, phase }).execOne(
          'l',
          c,
          proj,
          10,
          '',
          'n',
          {},
          { root: proj },
        )
      await Promise.all([g('a1', 'rules'), g('a2', 'checks')])
      expect(fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean)).toEqual(['start', 'end', 'start', 'end'])
    }))

  test('different cmds with the same name run one after the other, even in different roots', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      const c = (tag: string) => `echo start >> ${marker}; sleep 0.4; echo end >> ${marker} # ${tag}`
      const g = (id: string, tag: string, root: string) => agentGate(proj, id).execOne('l', c(tag), proj, 10, '', 'go-test', filesEnv(['x.py']), { root })
      await Promise.all([g('a1', 'a', proj), g('a2', 'b', path.join(proj, 'other'))])
      expect(fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean)).toEqual(['start', 'end', 'start', 'end'])
    }))

  test('the command pid is written into the lock while it runs', () =>
    withTmp(async (proj) => {
      const shared = await sharedDirOf(proj)
      const seen = path.join(proj, 'seen.txt')
      // 実行中のコマンド自身から、ロックの pid が自分の PID（$$）と一致するかを書き出す。
      const c = `for f in ${shared}/*.serial/pid; do [ "$(cat "$f")" = "$$" ] && echo same >> ${seen}; done; true`
      await agentGate(proj, 'a1').execOne('l', c, proj, 10, '', 'n', filesEnv(['x.py']), { root: proj })
      expect(fs.readFileSync(seen, 'utf8').trim()).toBe('same')
    }))

  test('share: false is not serialized', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      const c = `echo start >> ${marker}; sleep 0.4; echo end >> ${marker}`
      const g = (id: string) => agentGate(proj, id).execOne('l', c, proj, 10, '', 'n', filesEnv(['x.py']), { root: proj, share: false })
      await Promise.all([g('a1'), g('a2')])
      expect(fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).slice(0, 2)).toEqual(['start', 'start'])
    }))

  test('a differing root runs twice', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      const g = (id: string, root: string) => agentGate(proj, id).execOne('l', cmd(marker), proj, 10, '', 'n', filesEnv(['x.py']), { root })
      await Promise.all([g('a1', proj), g('a2', path.join(proj, 'other'))])
      expect(count(marker)).toBe(2)
    }))
})

describe('shared band', () => {
  test('the band stays while another agent is running; the result line appears only when all are done', () =>
    withTmp(async (proj) => {
      const bandLog: Array<string | undefined> = []
      const resultLog: Array<string | undefined> = []
      const a = agentGate(proj, 'a1', { bandLog, resultLog })
      const b = agentGate(proj, 'a2', { bandLog, resultLog })
      const pa = a.execOne('l', 'sleep 0.3', proj, 10, '', 'fast', undefined, { root: proj }).then(() => a.finishProgress())
      const pb = b.execOne('l', 'sleep 1', proj, 10, '', 'slow', undefined, { root: proj }).then(() => b.finishProgress())
      await pa
      expect(bandLog.at(-1)).toMatch(/^\[gate\] 実行中:\n {2}slow \$ sleep 1 \(\d+s\)$/)
      expect(resultLog.filter((l) => l !== undefined)).toEqual([])
      await pb
      expect(bandLog.indexOf(undefined)).toBeGreaterThan(0)
      expect(bandLog.slice(bandLog.indexOf(undefined)).every((l) => l === undefined)).toBe(true)
      expect(resultLog.filter((l) => l !== undefined)).toEqual([expect.stringMatching(/^\[gate\] 完了: ✓ 1 \(\d+\.\ds\)$/)])
    }))

  test('the band lists every agent and marks the one that waits', () =>
    withTmp(async (proj) => {
      const bandLog: Array<string | undefined> = []
      const a = agentGate(proj, 'a1', { bandLog })
      const b = agentGate(proj, 'a2', { bandLog })
      const exec = (g: Gate) => g.execOne('l', 'sleep 0.6', proj, 10, '', 'job', filesEnv(['x.py']), { root: proj })
      const pa = exec(a)
      await waitForSharedLock(proj)
      const pb = exec(b)
      await Promise.all([pa, pb])
      expect(bandLog.some((l) => l?.includes('\n  job $ sleep 0.6 (') && l.includes('\n  job $ sleep 0.6 待機中 ('))).toBe(true)
    }))

  test('runGate keeps the band until the last agent finishes', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, {
        rules: [
          { match: 'a.py', run: [{ cmd: 'sleep 0.2', name: 'fast' }] },
          { match: 'b.py', run: [{ cmd: 'sleep 1', name: 'slow' }] },
        ],
      })
      writeChangedFiles(proj, 'sess1--a1', 'a.py')
      writeChangedFiles(proj, 'sess1--a2', 'b.py')
      const bandLog: Array<string | undefined> = []
      const go = (agentId: string) => runGate(makeIo({ projectDir: proj, bandLog }), { sessionId: 'sess1', agentId, phase: 'rules' })
      await Promise.all([go('a1'), go('a2')])
      expect(bandLog.indexOf(undefined)).toBeGreaterThan(0)
      expect(bandLog.slice(bandLog.indexOf(undefined)).every((l) => l === undefined)).toBe(true)
    }))
})

describe('deferred commands in the checks phase', () => {
  test('a policy-less reserved check consumes the same command left in the deferred store', () =>
    withTmp(async (proj) => {
      const counter = path.join(proj, 'count.txt')
      const cmd = `echo x >> ${counter}`
      writeGateYaml(proj, {
        policy: false,
        rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
        consistency_checks: [{ name: 'chk', run: [{ cmd, name: 'chk-cmd' }] }],
      })
      writeChangedFiles(proj, 'sess1', 'x.py')
      expect((await rules(proj)).exitCode).toBe(0)
      writeDeferred(proj, 'sess1', [{ root: proj, cwd: proj, name: 'chk-cmd', cmd, timeout: 300, label: '.' }])
      expect((await checks(proj, 'sess1', { stopHookActive: true })).exitCode).toBe(0)
      expect(count(counter)).toBe(1)
    }))
})

describe('serializing across git worktrees of one repository', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', '-C', cwd, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  }
  const repoWithWorktrees = (base: string) => {
    const main = path.join(base, 'repo')
    fs.mkdirSync(main)
    git(main, 'init', '-q')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
    const inner = path.join(main, '.claude', 'worktrees', 'w')
    const outer = path.join(base, 'outside')
    git(main, 'worktree', 'add', '-q', '-b', 'w', inner)
    git(main, 'worktree', 'add', '-q', '-b', 'o', outer)
    return [main, inner, outer]
  }
  const runAll = (dirs: string[], marker: string, counter: string) => {
    const c = `echo start >> ${marker}; echo x >> ${counter}; sleep 0.4; echo end >> ${marker}`
    return Promise.all(dirs.map((d, i) => agentGate(d, `a${i}`).execOne('l', c, d, 10, '', 'heavy', filesEnv(['x.py']), { root: d })))
  }

  test('the main checkout and two worktrees run the same name one at a time, without sharing results', () =>
    withTmp(async (base) => {
      const dirs = repoWithWorktrees(base)
      const ids = await Promise.all(dirs.map((d) => sharedDirOf(d)))
      expect(new Set(ids).size).toBe(1)
      const marker = path.join(base, 'm.txt')
      const counter = path.join(base, 'c.txt')
      await runAll(dirs, marker, counter)
      expect(fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean)).toEqual(['start', 'end', 'start', 'end', 'start', 'end'])
      expect(count(counter)).toBe(3)
    }))

  test('different repositories get different shared directories', () =>
    withTmp(async (base) => {
      for (const d of ['x', 'y']) fs.mkdirSync(path.join(base, d))
      const a = repoWithWorktrees(path.join(base, 'x'))
      const b = repoWithWorktrees(path.join(base, 'y'))
      expect(await sharedDirOf(String(a[0]))).not.toBe(await sharedDirOf(String(b[0])))
    }))

  test('outside git, the same name in one project is still serialized', () =>
    withTmp(async (proj) => {
      const marker = path.join(proj, 'm.txt')
      const counter = path.join(proj, 'c.txt')
      // 同じ projectDir・同じキーなので結果は共有され得る（1 回か 2 回）。どちらでも重ならないこと
      await runAll([proj, proj], marker, counter)
      const lines = fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean)
      expect(lines).toEqual(lines.map((_, i) => (i % 2 === 0 ? 'start' : 'end')))
      expect(count(counter)).toBeGreaterThanOrEqual(1)
    }))
})
