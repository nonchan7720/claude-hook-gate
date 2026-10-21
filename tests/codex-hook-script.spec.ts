// plugins/codex/scripts/hook.sh: PLUGIN_ROOT（無ければスクリプトの場所から求めたリポジトリのルート）を CLAUDE_PLUGIN_ROOT として、
// feedback-gate（Go 製のバイナリ）の `codex <Event>` を呼ぶ。バイナリは FEEDBACK_GATE_BIN、無ければキャッシュ、無ければリリースから取ってくる（scripts/install-binary.sh）。
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { REPO_ROOT, rmTree, tmpDir } from './helpers/node-io.ts'
import { makePluginRoot, makeRelease, releasePlatform } from './helpers/release-fixture.ts'

const SCRIPT = path.join(REPO_ROOT, 'plugins', 'codex', 'scripts', 'hook.sh')
const BASH = Bun.which('bash') ?? '/bin/bash'

type Setup = { dir: string; bin: string; calls: string; fake: string }
type Run = (event: string, stdin: string, env?: Record<string, string>) => ReturnType<typeof spawnSync>

/** 偽の feedback-gate を置く（FEEDBACK_GATE_BIN で渡す）。呼ばれたら引数・CLAUDE_PLUGIN_ROOT・標準入力を calls に追記し、exitCode で終わる。 */
function fakeBinary(s: Setup, exitCode = 0): void {
  fs.writeFileSync(
    s.fake,
    `#!/bin/sh\nprintf 'feedback-gate|%s|%s|' "$*" "$CLAUDE_PLUGIN_ROOT" >> "${s.calls}"\ncat >> "${s.calls}"\nprintf '\\n' >> "${s.calls}"\nexit ${exitCode}\n`,
  )
  fs.chmodSync(s.fake, 0o755)
}

function link(s: Setup, name: string): void {
  const real = Bun.which(name)
  if (real) fs.symlinkSync(real, path.join(s.bin, name))
}

function withSetup(body: (s: Setup, run: Run) => void): void {
  const dir = tmpDir()
  const s: Setup = { dir, bin: path.join(dir, 'bin'), calls: path.join(dir, 'calls.txt'), fake: path.join(dir, 'fake-feedback-gate') }
  fs.mkdirSync(s.bin)
  for (const c of ['dirname', 'printf', 'cat', 'sed', 'head', 'tr']) link(s, c)
  try {
    body(s, (event, stdin, env = {}) =>
      spawnSync(BASH, [SCRIPT, event], { input: stdin, encoding: 'utf8', env: { PATH: s.bin, HOME: dir, FEEDBACK_GATE_BIN: s.fake, ...env } }),
    )
  } finally {
    rmTree(dir)
  }
}

/** ダウンロードに要るコマンド（curl, tar, gzip, チェックサム, mktemp など）を bin に張る。 */
function linkDownloadTools(s: Setup): void {
  for (const c of ['curl', 'tar', 'gzip', 'sha256sum', 'shasum', 'mktemp', 'mv', 'chmod', 'uname', 'mkdir', 'rm', 'cp']) link(s, c)
}

const calls = (s: Setup): string => (fs.existsSync(s.calls) ? fs.readFileSync(s.calls, 'utf8') : '')
const payload = JSON.stringify({ session_id: 'thr_1', cwd: '/x' })
const downloadable = releasePlatform() !== undefined

describe('plugins/codex/scripts/hook.sh', () => {
  test('runs feedback-gate codex <Event> under PLUGIN_ROOT, passing the stdin and the root as CLAUDE_PLUGIN_ROOT, and returns its exit code', () =>
    withSetup((s, run) => {
      fakeBinary(s, 3)
      const r = run('PreToolUse', payload, { PLUGIN_ROOT: '/plugin' })
      expect(r.status).toBe(3)
      expect(calls(s)).toBe(`feedback-gate|codex PreToolUse|/plugin|${payload}\n`)
    }))

  test('CLAUDE_PLUGIN_ROOT is accepted too, and without either the root is the repository root above the script', () =>
    withSetup((s, run) => {
      fakeBinary(s)
      run('Stop', payload, { CLAUDE_PLUGIN_ROOT: '/compat' })
      run('Stop', payload)
      expect(calls(s)).toBe(`feedback-gate|codex Stop|/compat|${payload}\nfeedback-gate|codex Stop|${REPO_ROOT}|${payload}\n`)
    }))

  test('no event: exit 0 without calling the binary', () =>
    withSetup((s, run) => {
      fakeBinary(s)
      expect(run('', payload).status).toBe(0)
      expect(calls(s)).toBe('')
    }))

  test('no FEEDBACK_GATE_BIN and no curl or wget: exit 0 and nothing happens', () =>
    withSetup((s, run) => {
      const root = makePluginRoot(s.dir, '1.2.3')
      const cache = path.join(s.dir, 'cache')
      const r = run('Stop', payload, { FEEDBACK_GATE_BIN: '', PLUGIN_ROOT: root, FEEDBACK_GATE_CACHE_DIR: cache })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(r.stderr).toBe('')
      expect(calls(s)).toBe('')
      expect(fs.existsSync(path.join(cache, '1.2.3', 'feedback-gate'))).toBe(false)
    }))

  test.skipIf(!downloadable)('downloads the binary for the plugin version, verifies it, caches it under <cache>/<version>/ and runs it', () =>
    withSetup((s, run) => {
      linkDownloadTools(s)
      const root = makePluginRoot(s.dir, '1.2.3')
      const release = makeRelease(s.dir, '1.2.3')
      const cache = path.join(s.dir, 'cache')
      const env = {
        FEEDBACK_GATE_BIN: '',
        PLUGIN_ROOT: root,
        FEEDBACK_GATE_CACHE_DIR: cache,
        FEEDBACK_GATE_RELEASE_BASE_URL: `file://${release.base}`,
        CALLS: s.calls,
      }
      const r = run('SessionStart', payload, env)
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
      expect(fs.statSync(path.join(cache, '1.2.3', 'feedback-gate')).mode & 0o111).not.toBe(0)
      expect(calls(s)).toBe(`feedback-gate|codex SessionStart|${root}|${payload}\n`)

      // 2 回目はキャッシュから動く（リリースが無くても）。
      rmTree(release.base)
      expect(run('Stop', payload, env).status).toBe(0)
      expect(calls(s)).toBe(`feedback-gate|codex SessionStart|${root}|${payload}\nfeedback-gate|codex Stop|${root}|${payload}\n`)
    }),
  )

  test.skipIf(!downloadable)('a checksum mismatch: exit 0, nothing is installed and nothing runs', () =>
    withSetup((s, run) => {
      linkDownloadTools(s)
      const root = makePluginRoot(s.dir, '1.2.3')
      const release = makeRelease(s.dir, '1.2.3', { tamper: true })
      const cache = path.join(s.dir, 'cache')
      const r = run('Stop', payload, {
        FEEDBACK_GATE_BIN: '',
        PLUGIN_ROOT: root,
        FEEDBACK_GATE_CACHE_DIR: cache,
        FEEDBACK_GATE_RELEASE_BASE_URL: `file://${release.base}`,
        CALLS: s.calls,
      })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(calls(s)).toBe('')
      expect(fs.existsSync(path.join(cache, '1.2.3', 'feedback-gate'))).toBe(false)
    }),
  )
})
