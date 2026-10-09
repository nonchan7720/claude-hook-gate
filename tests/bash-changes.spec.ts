import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { bashChanges, bashStarted, recordBashChanges, SKIP_COMMAND_RE } from '../src/bash-changes.ts'
import type { Dict } from '../src/pyutil.ts'
import { changedLines, changedPath, exists, statePath, writeGateYaml } from './helpers/gate.ts'
import { makeIo, withTmp } from './helpers/node-io.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })

/** git init して、tracked.txt / old.txt（と gate.yaml）をコミットした PJ を作る。 */
function initRepo(proj: string, gateYaml = true): void {
  if (gateYaml) writeGateYaml(proj, { rules: [] })
  git(proj, 'init', '-q')
  git(proj, 'config', 'user.email', 't@example.com')
  git(proj, 'config', 'user.name', 't')
  fs.writeFileSync(path.join(proj, '.gitignore'), '.claude/.gate-status/\nignored.txt\n')
  fs.writeFileSync(path.join(proj, 'tracked.txt'), 'a\n')
  fs.writeFileSync(path.join(proj, 'old.txt'), 'a\n')
  git(proj, 'add', '.')
  git(proj, 'commit', '-q', '-m', 'init')
}

const T0 = 1_700_000_000_000
const setMtime = (p: string, ms: number) => fs.utimesSync(p, ms / 1000, ms / 1000)
const payload = (extra: Dict = {}): Dict => ({
  session_id: 'sess-1',
  tool_name: 'Bash',
  tool_input: { command: 'bun run format' },
  tool_use_id: 'tu1',
  ...extra,
})

/** now を可変にした io。開始時刻 start で bashStarted を呼べる。 */
function ioAt(proj: string, clock: { t: number }) {
  return makeIo({ projectDir: proj, now: () => clock.t })
}

describe('SKIP_COMMAND_RE', () => {
  test('matches git history / worktree commands', () => {
    for (const c of ['git rebase -i', 'git checkout -b x', 'git stash pop', 'git worktree add ../x', 'git -C sub pull --rebase', 'cd x && git merge main']) {
      expect(SKIP_COMMAND_RE.test(c)).toBe(true)
    }
  })
  test('does not match read-only git or other commands', () => {
    for (const c of ['git status', 'git diff', 'git log', 'bun run format', "sed -i 's/a/b/' x.txt"]) {
      expect(SKIP_COMMAND_RE.test(c)).toBe(false)
    }
  })
})

describe('recordBashChanges', () => {
  test('records only files whose mtime is at or after the start', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      // 開始前から変更されていた古いファイル
      fs.writeFileSync(path.join(proj, 'old.txt'), 'edited before\n')
      setMtime(path.join(proj, 'old.txt'), T0 - 60_000)
      await bashStarted(io, payload())
      fs.writeFileSync(path.join(proj, 'tracked.txt'), 'edited by bash\n')
      setMtime(path.join(proj, 'tracked.txt'), T0 + 1000)
      const got = await recordBashChanges(io, payload())
      expect(got).toEqual([path.join(proj, 'tracked.txt')])
      expect(changedLines(proj, 'sess-1')).toEqual([path.join(proj, 'tracked.txt')])
    }))

  test('picks up both modified and untracked files, but not ignored ones', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      await bashStarted(io, payload())
      fs.writeFileSync(path.join(proj, 'tracked.txt'), 'changed\n')
      fs.writeFileSync(path.join(proj, 'new.txt'), 'new\n')
      fs.writeFileSync(path.join(proj, 'ignored.txt'), 'ignored\n')
      for (const f of ['tracked.txt', 'new.txt', 'ignored.txt']) setMtime(path.join(proj, f), T0 + 500)
      const got = await recordBashChanges(io, payload())
      expect(got.sort()).toEqual([path.join(proj, 'new.txt'), path.join(proj, 'tracked.txt')])
    }))

  test('keeps a file whose mtime is within the 2s slack before the start', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      await bashStarted(io, payload())
      fs.writeFileSync(path.join(proj, 'tracked.txt'), 'changed\n')
      setMtime(path.join(proj, 'tracked.txt'), T0 - 1500)
      expect(await recordBashChanges(io, payload())).toEqual([path.join(proj, 'tracked.txt')])
    }))

  test('does nothing without gate.yaml', () =>
    withTmp(async (proj) => {
      initRepo(proj, false)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      await bashStarted(io, payload())
      expect(exists(statePath(proj, 'bash_started', 'sess-1', 'json'))).toBe(false)
      fs.writeFileSync(path.join(proj, 'tracked.txt'), 'changed\n')
      setMtime(path.join(proj, 'tracked.txt'), T0 + 500)
      expect(await recordBashChanges(io, payload())).toEqual([])
      expect(exists(changedPath(proj, 'sess-1'))).toBe(false)
    }))

  test('does nothing without bash_started or with a different tool_use_id', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      fs.writeFileSync(path.join(proj, 'tracked.txt'), 'changed\n')
      setMtime(path.join(proj, 'tracked.txt'), T0 + 500)
      expect(await recordBashChanges(io, payload())).toEqual([])
      await bashStarted(io, payload({ tool_use_id: 'other' }))
      expect(await recordBashChanges(io, payload())).toEqual([])
      expect(exists(changedPath(proj, 'sess-1'))).toBe(false)
      // 不一致でも開始時刻のファイルは片付く
      expect(exists(statePath(proj, 'bash_started', 'sess-1', 'json'))).toBe(false)
    }))

  test('does not record for git history commands', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      const p = payload({ tool_input: { command: 'git checkout -b feature' } })
      await bashStarted(io, p)
      fs.writeFileSync(path.join(proj, 'tracked.txt'), 'changed\n')
      setMtime(path.join(proj, 'tracked.txt'), T0 + 500)
      expect(await recordBashChanges(io, p)).toEqual([])
      expect(exists(changedPath(proj, 'sess-1'))).toBe(false)
    }))

  test('does not duplicate lines when called twice; the second call returns nothing', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      fs.writeFileSync(path.join(proj, 'tracked.txt'), 'changed\n')
      setMtime(path.join(proj, 'tracked.txt'), T0 + 500)
      await bashStarted(io, payload())
      expect(await recordBashChanges(io, payload())).toHaveLength(1)
      await bashStarted(io, payload({ tool_use_id: 'tu2' }))
      expect(await recordBashChanges(io, payload({ tool_use_id: 'tu2' }))).toEqual([])
      expect(changedLines(proj, 'sess-1')).toEqual([path.join(proj, 'tracked.txt')])
    }))

  test('excludes files under .claude/.gate-status/', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      // .gitignore されていなくても除外される
      fs.writeFileSync(path.join(proj, '.gitignore'), 'ignored.txt\n')
      setMtime(path.join(proj, '.gitignore'), T0 - 60_000)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      await bashStarted(io, payload())
      const state = path.join(proj, '.claude', '.gate-status', 'gate_trace.sess-1.jsonl')
      fs.writeFileSync(state, '{}\n')
      setMtime(state, T0 + 500)
      fs.writeFileSync(path.join(proj, 'new.txt'), 'new\n')
      setMtime(path.join(proj, 'new.txt'), T0 + 500)
      const got = await recordBashChanges(io, payload())
      expect(got).toEqual([path.join(proj, 'new.txt')])
    }))

  test('uses the agent-suffixed state id', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      const p = payload({ agent_id: 'a1' })
      await bashStarted(io, p)
      expect(exists(statePath(proj, 'bash_started', 'sess-1--a1', 'json'))).toBe(true)
      fs.writeFileSync(path.join(proj, 'new.txt'), 'new\n')
      setMtime(path.join(proj, 'new.txt'), T0 + 500)
      expect(await recordBashChanges(io, p)).toEqual([path.join(proj, 'new.txt')])
      expect(changedLines(proj, 'sess-1--a1')).toEqual([path.join(proj, 'new.txt')])
    }))

  test('returns nothing outside a git repository', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [] })
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      await bashStarted(io, payload())
      expect(await recordBashChanges(io, payload())).toEqual([])
    }))
})

describe('bashChanges', () => {
  test('runs the rules phase only when something was recorded', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.txt', run: ['echo lint-failed; exit 1'] }] })
      initRepo(proj, false)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      await bashStarted(io, payload())
      const none = await bashChanges(io, payload())
      expect(none.exitCode).toBe(0)
      expect(none.stdout + none.stderr).not.toContain('lint-failed')
      await bashStarted(io, payload({ tool_use_id: 'tu2' }))
      fs.writeFileSync(path.join(proj, 'new.txt'), 'new\n')
      setMtime(path.join(proj, 'new.txt'), T0 + 500)
      const r = await bashChanges(io, payload({ tool_use_id: 'tu2' }))
      expect(r.stdout + r.stderr).toContain('lint-failed')
    }))
})
