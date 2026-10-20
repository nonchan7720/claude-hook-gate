// scripts/hook.sh: classic.* が走った環境（マーカーあり）では黙り、無ければ node（無ければ bun）で hooks/cli.js を呼ぶ。
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { REPO_ROOT, rmTree, tmpDir } from './helpers/node-io.ts'

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'hook.sh')
const BASH = Bun.which('bash') ?? '/bin/bash'

type Setup = { bin: string; feedback: string; calls: string }

/** bin に偽のランタイムを置く。呼ばれたら引数と標準入力を calls に追記し、exitCode で終わる。 */
function fakeRuntime(s: Setup, name: string, exitCode = 0): void {
  const file = path.join(s.bin, name)
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s|%s|' "${name}" "$*" >> "${s.calls}"\ncat >> "${s.calls}"\nprintf '\\n' >> "${s.calls}"\nexit ${exitCode}\n`)
  fs.chmodSync(file, 0o755)
}

/** コマンドを bin に張る（PATH を bin だけにして、node / bun / jq の有無を制御するため）。 */
function link(s: Setup, name: string): void {
  const real = Bun.which(name)
  if (real) fs.symlinkSync(real, path.join(s.bin, name))
}

function withSetup(body: (s: Setup, run: (event: string, stdin: string, env?: Record<string, string>) => ReturnType<typeof spawnSync>) => void): void {
  const dir = tmpDir()
  const s: Setup = { bin: path.join(dir, 'bin'), feedback: path.join(dir, 'feedback'), calls: path.join(dir, 'calls.txt') }
  fs.mkdirSync(s.bin)
  // スクリプトが使う基本のコマンド。
  for (const c of ['cat', 'tr', 'sed', 'head', 'dirname', 'printf']) link(s, c)
  try {
    body(s, (event, stdin, env = {}) =>
      spawnSync(BASH, [SCRIPT, event], {
        input: stdin,
        encoding: 'utf8',
        env: { PATH: s.bin, HOME: dir, CLAUDE_FEEDBACK_DIR: s.feedback, CLAUDE_PLUGIN_ROOT: '/plugin', ...env },
      }),
    )
  } finally {
    rmTree(dir)
  }
}

const calls = (s: Setup): string => (fs.existsSync(s.calls) ? fs.readFileSync(s.calls, 'utf8') : '')
const mark = (s: Setup, id: string) => {
  fs.mkdirSync(path.join(s.feedback, '.classic_seen'), { recursive: true })
  fs.writeFileSync(path.join(s.feedback, '.classic_seen', id), '1\n')
}
const payload = JSON.stringify({ session_id: 'sess-1', cwd: '/x' })

describe('scripts/hook.sh', () => {
  test('the marker for the session silences it: exit 0 and the runtime is not called', () =>
    withSetup((s, run) => {
      fakeRuntime(s, 'node')
      mark(s, 'sess-1')
      const r = run('Stop', payload)
      expect(r.status).toBe(0)
      expect(calls(s)).toBe('')
    }))

  test('without a marker it runs node hooks/cli.js <Event> and hands stdin over', () =>
    withSetup((s, run) => {
      fakeRuntime(s, 'node')
      mark(s, 'other-session')
      const r = run('PostToolUse', payload)
      expect(r.status).toBe(0)
      expect(calls(s)).toBe(`node|/plugin/hooks/cli.js PostToolUse|${payload}\n`)
    }))

  test('works without jq (sed reads session_id), and with jq when available', () =>
    withSetup((s, run) => {
      fakeRuntime(s, 'node')
      mark(s, 'sess-1')
      // jq は PATH に無い: sed で session_id を拾ってマーカーに当たる。
      expect(run('Stop', `{"cwd":"/x",\n"session_id" : "sess-1"}`).status).toBe(0)
      expect(calls(s)).toBe('')
      if (Bun.which('jq')) {
        link(s, 'jq')
        expect(run('Stop', payload).status).toBe(0)
        expect(calls(s)).toBe('')
      }
    }))

  test('a session_id with path characters cannot reach outside .classic_seen', () =>
    withSetup((s, run) => {
      fakeRuntime(s, 'node')
      // "../x" は "x" になる（. と / が落ちる）。マーカー x があればそれに当たる。
      mark(s, 'x')
      expect(run('Stop', JSON.stringify({ session_id: '../x' })).status).toBe(0)
      expect(calls(s)).toBe('')
    }))

  test('no runtime: exit 0 and nothing happens', () =>
    withSetup((s, run) => {
      const r = run('Stop', payload)
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(calls(s)).toBe('')
    }))
})
