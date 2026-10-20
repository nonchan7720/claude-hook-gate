// plugins/codex/scripts/hook.sh: node（無ければ bun）で plugins/codex/hooks/cli.js を呼ぶ。どちらも無ければ exit 0。
// Claude Code 版（scripts/hook.sh）と違い、mod が無いのでマーカーによる二重起動の判定は無い。
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { REPO_ROOT, rmTree, tmpDir } from './helpers/node-io.ts'

const PLUGIN = path.join(REPO_ROOT, 'plugins', 'codex')
const SCRIPT = path.join(PLUGIN, 'scripts', 'hook.sh')
const BASH = Bun.which('bash') ?? '/bin/bash'

type Setup = { bin: string; calls: string }

/** bin に偽のランタイムを置く。呼ばれたら引数・CLAUDE_PLUGIN_ROOT・標準入力を calls に追記し、exitCode で終わる。 */
function fakeRuntime(s: Setup, name: string, exitCode = 0): void {
  const file = path.join(s.bin, name)
  fs.writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s|%s|%s|' "${name}" "$*" "$CLAUDE_PLUGIN_ROOT" >> "${s.calls}"\ncat >> "${s.calls}"\nprintf '\\n' >> "${s.calls}"\nexit ${exitCode}\n`,
  )
  fs.chmodSync(file, 0o755)
}

function link(s: Setup, name: string): void {
  const real = Bun.which(name)
  if (real) fs.symlinkSync(real, path.join(s.bin, name))
}

function withSetup(body: (s: Setup, run: (event: string, stdin: string, env?: Record<string, string>) => ReturnType<typeof spawnSync>) => void): void {
  const dir = tmpDir()
  const s: Setup = { bin: path.join(dir, 'bin'), calls: path.join(dir, 'calls.txt') }
  fs.mkdirSync(s.bin)
  for (const c of ['dirname', 'printf', 'cat']) link(s, c)
  try {
    body(s, (event, stdin, env = {}) => spawnSync(BASH, [SCRIPT, event], { input: stdin, encoding: 'utf8', env: { PATH: s.bin, HOME: dir, ...env } }))
  } finally {
    rmTree(dir)
  }
}

const calls = (s: Setup): string => (fs.existsSync(s.calls) ? fs.readFileSync(s.calls, 'utf8') : '')
const payload = JSON.stringify({ session_id: 'thr_1', cwd: '/x' })

describe('plugins/codex/scripts/hook.sh', () => {
  test('runs hooks/cli.js of CLAUDE_PLUGIN_ROOT with node, passing the event and stdin, and returns its exit code', () =>
    withSetup((s, run) => {
      fakeRuntime(s, 'node', 3)
      const r = run('PreToolUse', payload, { CLAUDE_PLUGIN_ROOT: '/plugin' })
      expect(r.status).toBe(3)
      expect(calls(s)).toBe(`node|/plugin/hooks/cli.js PreToolUse|/plugin|${payload}\n`)
    }))

  test('PLUGIN_ROOT (the Codex name) is accepted, and without either the root is the plugin directory of the script', () =>
    withSetup((s, run) => {
      fakeRuntime(s, 'node')
      run('Stop', payload, { PLUGIN_ROOT: '/codex-plugin' })
      run('Stop', payload)
      expect(calls(s)).toBe(`node|/codex-plugin/hooks/cli.js Stop|/codex-plugin|${payload}\nnode|${PLUGIN}/hooks/cli.js Stop|${PLUGIN}|${payload}\n`)
    }))

  test('bun is used when there is no node; without both, exit 0 and nothing runs', () =>
    withSetup((s, run) => {
      expect(run('Stop', payload).status).toBe(0)
      expect(calls(s)).toBe('')
      fakeRuntime(s, 'bun')
      expect(run('Stop', payload, { CLAUDE_PLUGIN_ROOT: '/plugin' }).status).toBe(0)
      expect(calls(s)).toBe(`bun|/plugin/hooks/cli.js Stop|/plugin|${payload}\n`)
    }))

  test('no event: exit 0 without calling the runtime', () =>
    withSetup((s, run) => {
      fakeRuntime(s, 'node')
      expect(run('', payload).status).toBe(0)
      expect(calls(s)).toBe('')
    }))
})
