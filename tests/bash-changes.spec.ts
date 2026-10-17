import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { bashChanges, bashStarted, mentionsWorktree, recordBashChanges, SKIP_COMMAND_RE } from '../src/bash-changes.ts'
import type { Dict } from '../src/pyutil.ts'
import { changedLines, changedPath, exists, statePath, writeGateYaml } from './helpers/gate.ts'
import { makeIo, rmTree, tmpDir, withTmp } from './helpers/node-io.ts'

const T0 = 1_700_000_000_000
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
/** コミット日時を ms で指定して git を呼ぶ（コミット履歴から拾う判定を、T0 基準の時計に合わせる）。 */
const gitAt = (ms: number, cwd: string, ...args: string[]) => {
  const date = `@${Math.floor(ms / 1000)} +0000`
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
}

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
  // 開始時刻（T0）より前のコミットにしておく。後のコミットは「このコマンドが触ったファイル」の候補になるため。
  gitAt(T0 - 3_600_000, proj, 'commit', '-q', '-m', 'init')
}

const setMtime = (p: string, ms: number) => fs.utimesSync(p, ms / 1000, ms / 1000)
const payload = (extra: Dict = {}): Dict => ({
  session_id: 'sess-1',
  tool_name: 'Bash',
  tool_input: { command: 'bun run format' },
  tool_use_id: 'tu1',
  ...extra,
})

// 実環境の ~/.claude/feedback を読まないよう、空の feedback ディレクトリを差す。
const FEEDBACK_DIR = tmpDir('bash-changes-fb-')
afterAll(() => rmTree(FEEDBACK_DIR))

/** now を可変にした io。開始時刻 start で bashStarted を呼べる。 */
function ioAt(proj: string, clock: { t: number }) {
  return makeIo({ projectDir: proj, now: () => clock.t, env: { CLAUDE_FEEDBACK_DIR: FEEDBACK_DIR } })
}

describe('mentionsWorktree', () => {
  test('matches the worktree path, not a name that only shares its prefix', () => {
    expect(mentionsWorktree('cd .claude/worktrees/w && bun test', 'w')).toBe(true)
    expect(mentionsWorktree('cat > /p/.claude/worktrees/w/a.ts', 'w')).toBe(true)
    expect(mentionsWorktree('ls .claude/worktrees/w', 'w')).toBe(true)
    expect(mentionsWorktree('ls .claude/worktrees/w-2/a', 'w')).toBe(false)
    expect(mentionsWorktree('bun run format', 'w')).toBe(false)
  })
})

describe('SKIP_COMMAND_RE', () => {
  test('matches git history / worktree commands', () => {
    for (const c of ['git rebase -i', 'git checkout -b x', 'git stash pop', 'git worktree add ../x', 'git -C sub pull --rebase', 'cd x && git merge main']) {
      expect(SKIP_COMMAND_RE.test(c)).toBe(true)
    }
  })
  test('does not match read-only git or other commands', () => {
    for (const c of [
      'git status',
      'git diff',
      'git log',
      'bun run format',
      "sed -i 's/a/b/' x.txt",
      'git commit -m "fix checkout flow"',
      'git add -A && git commit -m "restore the reset button"',
      'git -C .claude/worktrees/w commit -m merge',
    ]) {
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

  test('does nothing without gate.yaml (and without post_edit / pre_edit feedback rules)', () =>
    withTmp(async (proj) => {
      initRepo(proj, false)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      await bashStarted(io, payload())
      expect(exists(statePath(proj, 'bash_started', 'sess-1', 'json'))).toBe(false)
      expect(exists(statePath(proj, 'bash_started', 'sess-1--tu1', 'json'))).toBe(false)
      expect(exists(path.join(FEEDBACK_DIR, '.bash_started'))).toBe(false)
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
      // 別の tool_use_id の開始時刻は別のファイルなので、残ったまま（次の Bash の開始時か、セッション開始時に掃かれる）
      expect(exists(statePath(proj, 'bash_started', 'sess-1--other', 'json'))).toBe(true)
      expect(exists(statePath(proj, 'bash_started', 'sess-1--tu1', 'json'))).toBe(false)
    }))

  test('keys the start time by tool_use_id and removes it once used', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      await bashStarted(io, payload({ tool_use_id: 'toolu_01/AB' }))
      // ファイル名に使えない文字は _ に置き換える
      expect(exists(statePath(proj, 'bash_started', 'sess-1--toolu_01_AB', 'json'))).toBe(true)
      expect(exists(statePath(proj, 'bash_started', 'sess-1', 'json'))).toBe(false)
      fs.writeFileSync(path.join(proj, 'new.txt'), 'new\n')
      setMtime(path.join(proj, 'new.txt'), T0 + 500)
      expect(await recordBashChanges(io, payload({ tool_use_id: 'toolu_01/AB' }))).toEqual([path.join(proj, 'new.txt')])
      expect(exists(statePath(proj, 'bash_started', 'sess-1--toolu_01_AB', 'json'))).toBe(false)
    }))

  test('falls back to the state id when there is no tool_use_id', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      const p = payload({ tool_use_id: undefined, agent_id: 'a1' })
      await bashStarted(io, p)
      expect(exists(statePath(proj, 'bash_started', 'sess-1--a1', 'json'))).toBe(true)
      fs.writeFileSync(path.join(proj, 'new.txt'), 'new\n')
      setMtime(path.join(proj, 'new.txt'), T0 + 500)
      expect(await recordBashChanges(io, p)).toEqual([path.join(proj, 'new.txt')])
      expect(exists(statePath(proj, 'bash_started', 'sess-1--a1', 'json'))).toBe(false)
    }))

  test('sweeps start files of the same session older than 2h, keeping recent ones and other sessions', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      const old = statePath(proj, 'bash_started', 'sess-1--failed', 'json')
      const recent = statePath(proj, 'bash_started', 'sess-1--running', 'json')
      const other = statePath(proj, 'bash_started', 'sess-2--failed', 'json')
      for (const [f, t] of [
        [old, T0 - 3 * 60 * 60 * 1000],
        [recent, T0 - 60 * 1000],
        [other, T0 - 3 * 60 * 60 * 1000],
      ] as const) {
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, '{}\n')
        setMtime(f, t)
      }
      await bashStarted(io, payload())
      expect(exists(old)).toBe(false)
      expect(exists(recent)).toBe(true)
      expect(exists(other)).toBe(true)
      expect(exists(statePath(proj, 'bash_started', 'sess-1--tu1', 'json'))).toBe(true)
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

  test('records under the agent-suffixed state id of PostToolUse even when PreToolUse had no agent id', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      // エンジンは classic.PreToolUse にエージェント ID を渡さない。PostToolUse（stdin JSON）には agent_id が入る。
      await bashStarted(io, payload())
      expect(exists(statePath(proj, 'bash_started', 'sess-1--tu1', 'json'))).toBe(true)
      fs.writeFileSync(path.join(proj, 'new.txt'), 'new\n')
      setMtime(path.join(proj, 'new.txt'), T0 + 500)
      expect(await recordBashChanges(io, payload({ agent_id: 'a1' }))).toEqual([path.join(proj, 'new.txt')])
      expect(changedLines(proj, 'sess-1--a1')).toEqual([path.join(proj, 'new.txt')])
      expect(exists(changedPath(proj, 'sess-1'))).toBe(false)
    }))

  test('keeps the commands of two agents apart by tool_use_id', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      await bashStarted(io, payload({ tool_use_id: 'tu-a' }))
      clock.t = T0 + 10_000
      await bashStarted(io, payload({ tool_use_id: 'tu-b' }))
      fs.writeFileSync(path.join(proj, 'a.txt'), 'a\n')
      setMtime(path.join(proj, 'a.txt'), T0 + 1000)
      fs.writeFileSync(path.join(proj, 'b.txt'), 'b\n')
      setMtime(path.join(proj, 'b.txt'), T0 + 11_000)
      // b の開始（T0+10s）より前に書かれた a.txt は b のものではない
      expect(await recordBashChanges(io, payload({ tool_use_id: 'tu-b', agent_id: 'b' }))).toEqual([path.join(proj, 'b.txt')])
      expect((await recordBashChanges(io, payload({ tool_use_id: 'tu-a', agent_id: 'a' }))).sort()).toEqual([
        path.join(proj, 'a.txt'),
        path.join(proj, 'b.txt'),
      ])
      expect(changedLines(proj, 'sess-1--a').sort()).toEqual([path.join(proj, 'a.txt'), path.join(proj, 'b.txt')])
      expect(changedLines(proj, 'sess-1--b')).toEqual([path.join(proj, 'b.txt')])
    }))

  test('records files committed within the same command', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      await bashStarted(io, payload({ tool_input: { command: 'cat > a.txt <<EOF ... EOF && git add -A && git commit -m wip' } }))
      fs.writeFileSync(path.join(proj, 'a.txt'), 'new\n')
      fs.writeFileSync(path.join(proj, 'tracked.txt'), 'changed\n')
      for (const f of ['a.txt', 'tracked.txt']) setMtime(path.join(proj, f), T0 + 500)
      git(proj, 'add', '-A')
      gitAt(T0 + 1000, proj, 'commit', '-q', '-m', 'wip')
      const got = await recordBashChanges(io, payload({ tool_input: { command: 'git commit' } }))
      expect(got.sort()).toEqual([path.join(proj, 'a.txt'), path.join(proj, 'tracked.txt')])
    }))

  test('does not record files of commits made before the start', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      fs.writeFileSync(path.join(proj, 'a.txt'), 'new\n')
      setMtime(path.join(proj, 'a.txt'), T0 - 60_000)
      git(proj, 'add', '-A')
      gitAt(T0 - 60_000, proj, 'commit', '-q', '-m', 'earlier')
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      await bashStarted(io, payload())
      expect(await recordBashChanges(io, payload())).toEqual([])
    }))

  test('records files written into a worktree under .claude/worktrees while cwd is the main checkout', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      gitAt(T0 - 3_600_000, proj, 'worktree', 'add', '-q', '.claude/worktrees/w', '-b', 'w')
      const wt = path.join(proj, '.claude', 'worktrees', 'w')
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      const p = payload({ cwd: proj, tool_input: { command: `cat > ${wt}/new.txt <<'EOF'\nnew\nEOF\nsed -i s/a/changed/ .claude/worktrees/w/tracked.txt` } })
      await bashStarted(io, p)
      fs.writeFileSync(path.join(wt, 'new.txt'), 'new\n')
      fs.writeFileSync(path.join(wt, 'tracked.txt'), 'changed\n')
      for (const f of ['new.txt', 'tracked.txt']) setMtime(path.join(wt, f), T0 + 500)
      const got = await recordBashChanges(io, p)
      expect(got.sort()).toEqual([path.join(wt, 'new.txt'), path.join(wt, 'tracked.txt')])
      expect(changedLines(proj, 'sess-1').sort()).toEqual([path.join(wt, 'new.txt'), path.join(wt, 'tracked.txt')])
    }))

  test('does not record files written meanwhile in a worktree the command does not mention (another session editing there)', () =>
    withTmp(async (proj) => {
      initRepo(proj)
      gitAt(T0 - 3_600_000, proj, 'worktree', 'add', '-q', '.claude/worktrees/other', '-b', 'other')
      gitAt(T0 - 3_600_000, proj, 'worktree', 'add', '-q', '.claude/worktrees/other-2', '-b', 'other-2')
      const other = path.join(proj, '.claude', 'worktrees', 'other')
      const clock = { t: T0 }
      const io = ioAt(proj, clock)
      // other-2 だけを指すコマンド。other は名前の接頭辞が同じだけで、指していない。
      const p = payload({ cwd: proj, tool_input: { command: 'echo x > new.txt && ls .claude/worktrees/other-2' } })
      await bashStarted(io, p)
      fs.writeFileSync(path.join(proj, 'new.txt'), 'x\n')
      fs.writeFileSync(path.join(other, 'red.test.ts'), 'expect(1).toBe(2)\n')
      for (const f of [path.join(proj, 'new.txt'), path.join(other, 'red.test.ts')]) setMtime(f, T0 + 500)
      expect(await recordBashChanges(io, p)).toEqual([path.join(proj, 'new.txt')])
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
