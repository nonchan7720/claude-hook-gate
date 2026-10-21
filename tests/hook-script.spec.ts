// scripts/hook.sh: classic.* が走った環境（マーカーあり）では黙り、無ければ feedback-gate（Go 製のバイナリ）の `claude <Event>` を呼ぶ。
// バイナリは FEEDBACK_GATE_BIN、無ければキャッシュ、無ければリリースから取ってくる（scripts/install-binary.sh）。
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { REPO_ROOT, rmTree, tmpDir } from './helpers/node-io.ts'
import { ageDays, FAKE_BINARY_SCRIPT, installNotice, makePluginRoot, makeRelease, releasePlatform } from './helpers/release-fixture.ts'

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'hook.sh')
const BASH = Bun.which('bash') ?? '/bin/bash'

type Setup = { dir: string; bin: string; feedback: string; calls: string; fake: string }
type Run = (event: string, stdin: string, env?: Record<string, string>) => ReturnType<typeof spawnSync>

/** 偽の feedback-gate を置く（FEEDBACK_GATE_BIN で渡す）。呼ばれたら引数・CLAUDE_PLUGIN_ROOT・標準入力を calls に追記し、exitCode で終わる。 */
function fakeBinary(s: Setup, exitCode = 0): void {
  fs.writeFileSync(
    s.fake,
    `#!/bin/sh\nprintf 'feedback-gate|%s|%s|' "$*" "$CLAUDE_PLUGIN_ROOT" >> "${s.calls}"\ncat >> "${s.calls}"\nprintf '\\n' >> "${s.calls}"\nexit ${exitCode}\n`,
  )
  fs.chmodSync(s.fake, 0o755)
}

/** コマンドを bin に張る（PATH を bin だけにして、curl / jq などの有無を制御するため）。 */
function link(s: Setup, name: string): void {
  const real = Bun.which(name)
  if (real) fs.symlinkSync(real, path.join(s.bin, name))
}

function withSetup(body: (s: Setup, run: Run) => void): void {
  const dir = tmpDir()
  const s: Setup = {
    dir,
    bin: path.join(dir, 'bin'),
    feedback: path.join(dir, 'feedback'),
    calls: path.join(dir, 'calls.txt'),
    fake: path.join(dir, 'fake-feedback-gate'),
  }
  fs.mkdirSync(s.bin)
  // スクリプトが使う基本のコマンド。
  for (const c of ['cat', 'tr', 'sed', 'head', 'dirname', 'printf']) link(s, c)
  try {
    body(s, (event, stdin, env = {}) =>
      spawnSync(BASH, [SCRIPT, event], {
        input: stdin,
        encoding: 'utf8',
        env: { PATH: s.bin, HOME: dir, CLAUDE_FEEDBACK_DIR: s.feedback, CLAUDE_PLUGIN_ROOT: '/plugin', FEEDBACK_GATE_BIN: s.fake, ...env },
      }),
    )
  } finally {
    rmTree(dir)
  }
}

/** ダウンロードに要るコマンド（curl, tar, gzip, チェックサム, mktemp など）を bin に張る。 */
function linkDownloadTools(s: Setup): void {
  for (const c of ['curl', 'tar', 'gzip', 'sha256sum', 'shasum', 'mktemp', 'mv', 'chmod', 'uname', 'mkdir', 'rm', 'cp', 'find', 'touch']) link(s, c)
}

/** curl / wget とチェックサム以外の、ダウンロードの前に install-binary.sh が使うコマンド（uname, mkdir, find, touch, mktemp, rm）。 */
function linkInstallBasics(s: Setup): void {
  for (const c of ['uname', 'mkdir', 'find', 'touch', 'mktemp', 'rm']) link(s, c)
}

const calls = (s: Setup): string => (fs.existsSync(s.calls) ? fs.readFileSync(s.calls, 'utf8') : '')
const mark = (s: Setup, id: string) => {
  fs.mkdirSync(path.join(s.feedback, '.classic_seen'), { recursive: true })
  fs.writeFileSync(path.join(s.feedback, '.classic_seen', id), '1\n')
}
const payload = JSON.stringify({ session_id: 'sess-1', cwd: '/x' })
const downloadable = releasePlatform() !== undefined

describe('scripts/hook.sh', () => {
  test('the marker for the session silences it: exit 0 and the binary is not called', () =>
    withSetup((s, run) => {
      fakeBinary(s)
      mark(s, 'sess-1')
      const r = run('Stop', payload)
      expect(r.status).toBe(0)
      expect(calls(s)).toBe('')
    }))

  test('without a marker it runs feedback-gate claude <Event> and hands stdin over', () =>
    withSetup((s, run) => {
      fakeBinary(s)
      mark(s, 'other-session')
      const r = run('PostToolUse', payload)
      expect(r.status).toBe(0)
      expect(calls(s)).toBe(`feedback-gate|claude PostToolUse|/plugin|${payload}\n`)
    }))

  test("the binary's exit code is the script's exit code", () =>
    withSetup((s, run) => {
      fakeBinary(s, 2)
      expect(run('Stop', payload).status).toBe(2)
    }))

  test('works without jq (sed reads session_id), and with jq when available', () =>
    withSetup((s, run) => {
      fakeBinary(s)
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
      fakeBinary(s)
      // "../x" は "x" になる（. と / が落ちる）。マーカー x があればそれに当たる。
      mark(s, 'x')
      expect(run('Stop', JSON.stringify({ session_id: '../x' })).status).toBe(0)
      expect(calls(s)).toBe('')
    }))

  test('no event: exit 0 without calling the binary', () =>
    withSetup((s, run) => {
      fakeBinary(s)
      expect(run('', payload).status).toBe(0)
      expect(calls(s)).toBe('')
    }))

  test.skipIf(!downloadable)('no FEEDBACK_GATE_BIN and no curl or wget: exit 0, nothing happens, one line on stderr says why', () =>
    withSetup((s, run) => {
      // uname / mkdir / find / touch / mktemp / rm とチェックサムはあるので、止まるのは curl / wget が無いところ。
      linkInstallBasics(s)
      for (const c of ['sha256sum', 'shasum']) link(s, c)
      const root = makePluginRoot(s.dir, '1.2.3')
      const cache = path.join(s.dir, 'cache')
      const r = run('Stop', payload, { FEEDBACK_GATE_BIN: '', CLAUDE_PLUGIN_ROOT: root, FEEDBACK_GATE_CACHE_DIR: cache })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(r.stderr).toBe(installNotice('1.2.3', 'no-download-tool'))
      expect(calls(s)).toBe('')
      expect(fs.existsSync(path.join(cache, '1.2.3', 'feedback-gate'))).toBe(false)
    }),
  )

  test.skipIf(!downloadable)('no sha256sum or shasum: fails closed, nothing is installed even though the download would work', () =>
    withSetup((s, run) => {
      linkDownloadTools(s)
      for (const c of ['sha256sum', 'shasum']) fs.rmSync(path.join(s.bin, c), { force: true })
      const root = makePluginRoot(s.dir, '1.2.3')
      const release = makeRelease(s.dir, '1.2.3')
      const cache = path.join(s.dir, 'cache')
      const r = run('Stop', payload, {
        FEEDBACK_GATE_BIN: '',
        CLAUDE_PLUGIN_ROOT: root,
        FEEDBACK_GATE_CACHE_DIR: cache,
        FEEDBACK_GATE_RELEASE_BASE_URL: `file://${release.base}`,
        CALLS: s.calls,
      })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(r.stderr).toBe(installNotice('1.2.3', 'no-sha256-tool'))
      expect(calls(s)).toBe('')
      expect(fs.existsSync(path.join(cache, '1.2.3', 'feedback-gate'))).toBe(false)
    }),
  )

  test.skipIf(!downloadable)('downloads the binary for the plugin version once, verifies it, caches it under <cache>/<version>/ and runs it', () =>
    withSetup((s, run) => {
      linkDownloadTools(s)
      const root = makePluginRoot(s.dir, '1.2.3')
      const release = makeRelease(s.dir, '1.2.3')
      const cache = path.join(s.dir, 'cache')
      // 別バージョンのキャッシュは、新しく入れたときに 30 日より古いものだけが片付く（新しいもの・現在のバージョンは残る）。
      // 前のフックが殺されて残った 60 分より古い作業ディレクトリも片付くが、新しいものは触らない。
      fs.mkdirSync(path.join(cache, '0.1.0'), { recursive: true })
      fs.writeFileSync(path.join(cache, '0.1.0', 'feedback-gate'), '#!/bin/sh\n')
      ageDays(path.join(cache, '0.1.0'), 40)
      fs.mkdirSync(path.join(cache, '0.2.0'), { recursive: true })
      fs.writeFileSync(path.join(cache, '0.2.0', 'feedback-gate'), '#!/bin/sh\n')
      fs.mkdirSync(path.join(cache, '1.2.3', '.download.stale'), { recursive: true })
      ageDays(path.join(cache, '1.2.3', '.download.stale'), 1)
      fs.mkdirSync(path.join(cache, '1.2.3', '.download.fresh'), { recursive: true })
      const env = {
        FEEDBACK_GATE_BIN: '',
        CLAUDE_PLUGIN_ROOT: root,
        FEEDBACK_GATE_CACHE_DIR: cache,
        FEEDBACK_GATE_RELEASE_BASE_URL: `file://${release.base}`,
        CALLS: s.calls,
      }
      const r = run('PostToolUse', payload, env)
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
      const installed = path.join(cache, '1.2.3', 'feedback-gate')
      expect(fs.statSync(installed).mode & 0o111).not.toBe(0)
      expect(calls(s)).toBe(`feedback-gate|claude PostToolUse|${root}|${payload}\n`)
      expect(fs.existsSync(path.join(cache, '0.1.0'))).toBe(false)
      expect(fs.existsSync(path.join(cache, '0.2.0', 'feedback-gate'))).toBe(true)
      // 自分の作業用のファイルは残さない。古い .download.* は消え、新しいもの（別のフックが使っているかもしれない）は残る。
      expect(fs.readdirSync(path.join(cache, '1.2.3')).sort()).toEqual(['.download.fresh', 'feedback-gate'])

      // 2 回目はキャッシュから動く（リリースが無くても）。
      rmTree(release.base)
      expect(run('Stop', payload, env).status).toBe(0)
      expect(calls(s)).toBe(`feedback-gate|claude PostToolUse|${root}|${payload}\nfeedback-gate|claude Stop|${root}|${payload}\n`)
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
        CLAUDE_PLUGIN_ROOT: root,
        FEEDBACK_GATE_CACHE_DIR: cache,
        FEEDBACK_GATE_RELEASE_BASE_URL: `file://${release.base}`,
        CALLS: s.calls,
      })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(r.stderr).toBe(installNotice('1.2.3', 'checksum-mismatch'))
      expect(calls(s)).toBe('')
      expect(fs.existsSync(path.join(cache, '1.2.3', 'feedback-gate'))).toBe(false)
    }),
  )

  test.skipIf(!downloadable)('a cached binary that is in use is touched, so a version dir last used long ago is not considered old afterwards', () =>
    withSetup((s, run) => {
      linkDownloadTools(s)
      const root = makePluginRoot(s.dir, '1.2.3')
      const cache = path.join(s.dir, 'cache')
      const vdir = path.join(cache, '1.2.3')
      fs.mkdirSync(vdir, { recursive: true })
      fs.writeFileSync(path.join(vdir, 'feedback-gate'), FAKE_BINARY_SCRIPT, { mode: 0o755 })
      ageDays(vdir, 40)
      const r = run('Stop', payload, { FEEDBACK_GATE_BIN: '', CLAUDE_PLUGIN_ROOT: root, FEEDBACK_GATE_CACHE_DIR: cache, CALLS: s.calls })
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
      expect(calls(s)).toBe(`feedback-gate|claude Stop|${root}|${payload}\n`)
      expect(Date.now() - fs.statSync(vdir).mtimeMs).toBeLessThan(5 * 60 * 1000)
    }),
  )

  test.skipIf(!downloadable)('two plugin versions sharing a cache do not evict each other', () =>
    withSetup((s, run) => {
      linkDownloadTools(s)
      const cache = path.join(s.dir, 'cache')
      const release = makeRelease(s.dir, '1.2.3')
      const other = path.join(cache, '0.9.0')
      fs.mkdirSync(other, { recursive: true })
      fs.writeFileSync(path.join(other, 'feedback-gate'), FAKE_BINARY_SCRIPT, { mode: 0o755 })
      const env = {
        FEEDBACK_GATE_BIN: '',
        CLAUDE_PLUGIN_ROOT: makePluginRoot(s.dir, '1.2.3'),
        FEEDBACK_GATE_CACHE_DIR: cache,
        FEEDBACK_GATE_RELEASE_BASE_URL: `file://${release.base}`,
        CALLS: s.calls,
      }
      expect(run('Stop', payload, env).status).toBe(0)
      expect(fs.existsSync(path.join(other, 'feedback-gate'))).toBe(true)
      expect(fs.existsSync(path.join(cache, '1.2.3', 'feedback-gate'))).toBe(true)
    }),
  )

  test.skipIf(!downloadable)('a release that does not exist: exit 0 and nothing runs', () =>
    withSetup((s, run) => {
      linkDownloadTools(s)
      const root = makePluginRoot(s.dir, '9.9.9')
      const release = makeRelease(s.dir, '1.2.3')
      const r = run('Stop', payload, {
        FEEDBACK_GATE_BIN: '',
        CLAUDE_PLUGIN_ROOT: root,
        FEEDBACK_GATE_CACHE_DIR: path.join(s.dir, 'cache'),
        FEEDBACK_GATE_RELEASE_BASE_URL: `file://${release.base}`,
        CALLS: s.calls,
      })
      expect(r.status).toBe(0)
      expect(r.stderr).toBe(installNotice('9.9.9', 'download-failed'))
      expect(calls(s)).toBe('')
    }),
  )
})
