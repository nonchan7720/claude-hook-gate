// plugins/codex/scripts/setup.sh: Codex のプラグインキャッシュから最新バージョンを選び、その install-hooks.sh に引数を渡して実行する。
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { REPO_ROOT, rmTree, tmpDir } from './helpers/node-io.ts'

const SCRIPT = path.join(REPO_ROOT, 'plugins', 'codex', 'scripts', 'setup.sh')
const BASH = Bun.which('bash') ?? '/bin/bash'
const INSTALL = path.join('plugins', 'codex', 'scripts', 'install-hooks.sh')

type Setup = { dir: string; bin: string; calls: string; home: string; cache: string }
type Run = (args: string[], env?: Record<string, string>, piped?: boolean) => ReturnType<typeof spawnSync>

/** root に偽の install-hooks.sh を置く。呼ばれたら tag と引数を calls に追記し、exitCode で終わる。 */
function fakeInstall(s: Setup, root: string, tag: string, exitCode = 0): void {
  const file = path.join(root, INSTALL)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s|%s\\n' "${tag}" "$*" >> "${s.calls}"\nexit ${exitCode}\n`)
  fs.chmodSync(file, 0o755)
}

function withSetup(body: (s: Setup, run: Run) => void): void {
  const dir = tmpDir()
  const home = path.join(dir, 'home')
  const s: Setup = {
    dir,
    bin: path.join(dir, 'bin'),
    calls: path.join(dir, 'calls.txt'),
    home,
    cache: path.join(home, '.codex', 'plugins', 'cache', 'hook-gate', 'feedback-gate'),
  }
  fs.mkdirSync(s.bin)
  fs.mkdirSync(home, { recursive: true })
  for (const c of ['printf', 'dirname', 'basename']) {
    const real = Bun.which(c)
    if (real) fs.symlinkSync(real, path.join(s.bin, c))
  }
  try {
    body(s, (args, env = {}, piped = false) => {
      const e = { PATH: s.bin, HOME: home, ...env }
      return piped
        ? spawnSync(BASH, ['-s', '--', ...args], { input: fs.readFileSync(SCRIPT, 'utf8'), encoding: 'utf8', env: e })
        : spawnSync(BASH, [SCRIPT, ...args], { encoding: 'utf8', env: e })
    })
  } finally {
    rmTree(dir)
  }
}

const calls = (s: Setup): string => (fs.existsSync(s.calls) ? fs.readFileSync(s.calls, 'utf8') : '')
const install = (s: Setup, versions: string[]): void => {
  for (const v of versions) fakeInstall(s, path.join(s.cache, v), v)
}

describe('plugins/codex/scripts/setup.sh', () => {
  test('picks the newest version by number, ignoring non-version and incomplete directories, and forwards the arguments', () =>
    withSetup((s, run) => {
      install(s, ['0.9.1', '0.19.0', '0.10.0', 'v0.18.0'])
      fs.mkdirSync(path.join(s.cache, 'tmp', 'plugins'), { recursive: true })
      fs.mkdirSync(path.join(s.cache, '0.99.0'))
      const r = run(['--project', '/x'])
      expect(r.status).toBe(0)
      expect(calls(s)).toBe('0.19.0|--project /x\n')
      expect(r.stderr).toContain(`feedback-gate: using ${path.join(s.cache, '0.19.0')}`)
    }))

  test('0.10.0 beats 0.9.1 (numeric, not lexical)', () =>
    withSetup((s, run) => {
      install(s, ['0.9.1', '0.10.0'])
      run([])
      expect(calls(s)).toBe('0.10.0|\n')
    }))

  test('a release beats its prerelease', () => {
    for (const order of [
      ['1.0.0', '1.0.0-rc.1'],
      ['1.0.0-rc.1', '1.0.0'],
    ])
      withSetup((s, run) => {
        install(s, order)
        run([])
        expect(calls(s)).toBe('1.0.0|\n')
      })
  })

  test('honors CODEX_HOME', () =>
    withSetup((s, run) => {
      const other = path.join(s.dir, 'other')
      fakeInstall(s, path.join(other, 'plugins', 'cache', 'hook-gate', 'feedback-gate', '2.0.0'), 'other-2.0.0')
      install(s, ['9.0.0'])
      run([], { CODEX_HOME: other })
      expect(calls(s)).toBe('other-2.0.0|\n')
    }))

  test('FEEDBACK_GATE_PLUGIN_DIR overrides the cache lookup', () =>
    withSetup((s, run) => {
      install(s, ['9.0.0'])
      const root = path.join(s.dir, 'checkout')
      fakeInstall(s, root, 'checkout')
      const r = run(['--print'], { FEEDBACK_GATE_PLUGIN_DIR: root })
      expect(r.status).toBe(0)
      expect(calls(s)).toBe('checkout|--print\n')
    }))

  test('without an installed plugin it explains how to install it and exits 1', () =>
    withSetup((s, run) => {
      const r = run(['--project'])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('codex plugin marketplace add nonchan7720/claude-hook-gate')
      expect(r.stderr).toContain(s.cache)
      expect(calls(s)).toBe('')
    }))

  test("returns install-hooks.sh's exit code", () =>
    withSetup((s, run) => {
      fakeInstall(s, path.join(s.cache, '1.2.3'), '1.2.3', 3)
      expect(run([]).status).toBe(3)
    }))

  test('works when piped into bash on stdin', () =>
    withSetup((s, run) => {
      install(s, ['0.9.1', '0.10.0'])
      const r = run(['--project', '/x'], {}, true)
      expect(r.status).toBe(0)
      expect(calls(s)).toBe('0.10.0|--project /x\n')
    }))
})
