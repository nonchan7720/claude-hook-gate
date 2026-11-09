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
  for (const c of ['printf', 'dirname', 'basename', 'cp', 'mv', 'mkdir', 'chmod', 'mktemp', 'cat', 'grep', 'rm']) {
    const real = Bun.which(c)
    if (real) fs.symlinkSync(real, path.join(s.bin, c))
  }
  fs.writeFileSync(
    path.join(dir, 'fake-codex'),
    `#!/bin/sh
printf 'codex|%s\\n' "$*" >> "${s.calls}"
case "$*" in
  "plugin marketplace upgrade"*) [ "\${FAKE_CODEX_UPGRADE_FAILS:-}" = 1 ] && exit 1 ;;
  "plugin add"*)
    [ "\${FAKE_CODEX_ADD_FAILS:-}" = 1 ] && exit 1
    if [ -n "\${FAKE_CODEX_NEW_VERSION:-}" ]; then
      d="${s.cache}/$FAKE_CODEX_NEW_VERSION/plugins/codex/scripts"
      mkdir -p "$d"
      printf '#!/bin/sh\\nprintf "%%s|%%s\\\\n" "new-$FAKE_CODEX_NEW_VERSION" "$*" >> "${s.calls}"\\n' > "$d/install-hooks.sh"
    fi ;;
esac
exit 0
`,
    { mode: 0o755 },
  )
  try {
    body(s, (args, env = {}, piped = false) => {
      const e: Record<string, string> = { PATH: s.bin, HOME: home, ...env }
      if (!('FEEDBACK_GATE_CODEX_BIN' in env)) e.FEEDBACK_GATE_CODEX_BIN = path.join(dir, 'no-such-codex')
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

  describe('feedback-gate-setup command', () => {
    const cmdPath = (s: Setup, d = path.join(s.home, '.local', 'bin')): string => path.join(d, 'feedback-gate-setup')
    // ダウンロードを無効にする（存在しない file:// URL）
    const noDl = (s: Setup): Record<string, string> => ({ FEEDBACK_GATE_SETUP_URL: `file://${path.join(s.dir, 'nope')}` })
    const rcLines = (f: string): string[] => fs.readFileSync(f, 'utf8').split('\n')

    test('running as a file installs an executable, identical copy and still runs the installer', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const r = run(['--project', '/x'])
        expect(r.status).toBe(0)
        const dst = cmdPath(s)
        expect(fs.readFileSync(dst, 'utf8')).toBe(fs.readFileSync(SCRIPT, 'utf8'))
        expect(fs.statSync(dst).mode & 0o777).toBe(0o755)
        expect(calls(s)).toBe('1.0.0|--project /x\n')
        expect(r.stderr).toContain(`feedback-gate: installed feedback-gate-setup into ${path.dirname(dst)}`)
      }))

    test('piped on stdin, copies the selected plugin version of setup.sh', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const copy = path.join(s.cache, '1.0.0', 'plugins', 'codex', 'scripts', 'setup.sh')
        fs.writeFileSync(copy, '#!/bin/bash\n# plugin copy\n')
        const r = run(['--project'], noDl(s), true)
        expect(r.status).toBe(0)
        expect(fs.readFileSync(cmdPath(s), 'utf8')).toBe('#!/bin/bash\n# plugin copy\n')
        expect(calls(s)).toBe('1.0.0|--project\n')
      }))

    test('piped without a plugin copy and without downloading: still succeeds and explains', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const r = run(['--project'], noDl(s), true)
        expect(r.status).toBe(0)
        expect(calls(s)).toBe('1.0.0|--project\n')
        expect(fs.existsSync(cmdPath(s))).toBe(false)
        expect(r.stderr).toContain('could not install feedback-gate-setup')
        expect(fs.readdirSync(path.join(s.home, '.local', 'bin'))).toEqual([])
      }))

    test.skipIf(!Bun.which('curl'))('piped without a plugin copy downloads from FEEDBACK_GATE_SETUP_URL', () =>
      withSetup((s, run) => {
        fs.symlinkSync(Bun.which('curl') as string, path.join(s.bin, 'curl'))
        install(s, ['1.0.0'])
        const remote = path.join(s.dir, 'remote-setup.sh')
        fs.writeFileSync(remote, '#!/bin/bash\n# remote\n')
        const r = run([], { FEEDBACK_GATE_SETUP_URL: `file://${remote}` }, true)
        expect(r.status).toBe(0)
        expect(fs.readFileSync(cmdPath(s), 'utf8')).toBe('#!/bin/bash\n# remote\n')
        expect(fs.statSync(cmdPath(s)).mode & 0o777).toBe(0o755)
      }),
    )

    test('--no-command skips the install and is not forwarded', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const r = run(['--project', '--no-command', '/x'])
        expect(r.status).toBe(0)
        expect(calls(s)).toBe('1.0.0|--project /x\n')
        expect(fs.existsSync(path.join(s.home, '.local'))).toBe(false)
      }))

    test('FEEDBACK_GATE_BIN_DIR is honored', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const d = path.join(s.dir, 'custom', 'bin')
        run([], { FEEDBACK_GATE_BIN_DIR: d + '/' })
        expect(fs.existsSync(cmdPath(s, d))).toBe(true)
        expect(fs.existsSync(path.join(s.home, '.local'))).toBe(false)
      }))

    test('adds the bin dir to .zshrc once, with a marker', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const rc = path.join(s.home, '.zshrc')
        fs.writeFileSync(rc, '# mine\n')
        const r = run([], { SHELL: '/bin/zsh' })
        run([], { SHELL: '/bin/zsh' })
        const lines = rcLines(rc)
        expect(lines.filter((l) => l === '# feedback-gate-setup').length).toBe(1)
        expect(lines.filter((l) => l === 'export PATH="$HOME/.local/bin:$PATH"').length).toBe(1)
        expect(lines[lines.indexOf('# feedback-gate-setup') + 1]).toBe('export PATH="$HOME/.local/bin:$PATH"')
        expect(r.stderr).toContain(`added ${path.join(s.home, '.local', 'bin')} to PATH in ~/.zshrc`)
        expect(fs.existsSync(path.join(s.home, '.bashrc'))).toBe(false)
      }))

    test('uses .bashrc for bash', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        run([], { SHELL: '/usr/bin/bash' })
        expect(fs.readFileSync(path.join(s.home, '.bashrc'), 'utf8')).toContain('# feedback-gate-setup\nexport PATH="$HOME/.local/bin:$PATH"\n')
        expect(fs.existsSync(path.join(s.home, '.zshrc'))).toBe(false)
      }))

    test('does not touch rc files when the dir is already in PATH', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const d = path.join(s.home, '.local', 'bin')
        run([], { SHELL: '/bin/zsh', PATH: `${s.bin}:${d}/` })
        expect(fs.existsSync(path.join(s.home, '.zshrc'))).toBe(false)
      }))

    test('FEEDBACK_GATE_NO_RC=1 only prints the line', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const r = run([], { SHELL: '/bin/zsh', FEEDBACK_GATE_NO_RC: '1' })
        expect(fs.existsSync(path.join(s.home, '.zshrc'))).toBe(false)
        expect(r.stderr).toContain('export PATH="$HOME/.local/bin:$PATH"')
      }))

    test('an unknown shell prints the line and writes nothing', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const r = run([], { SHELL: '/usr/bin/fish' })
        expect(fs.readdirSync(s.home).sort()).toEqual(['.codex', '.local'])
        expect(r.stderr).toContain('export PATH="$HOME/.local/bin:$PATH"')
      }))

    test('the installed command runs itself without failing on copying onto itself', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        run([])
        const dst = cmdPath(s)
        const before = fs.readFileSync(dst, 'utf8')
        const r = spawnSync(BASH, [dst, '--project'], { encoding: 'utf8', env: { PATH: s.bin, HOME: s.home } })
        expect(r.status).toBe(0)
        expect(fs.readFileSync(dst, 'utf8')).toBe(before)
        expect(r.stderr).not.toContain('could not install')
        expect(r.stderr).not.toContain('installed feedback-gate-setup')
        expect(calls(s)).toBe('1.0.0|\n1.0.0|--project\n')
      }))
  })

  describe('plugin update', () => {
    const codex = (s: Setup): Record<string, string> => ({ FEEDBACK_GATE_CODEX_BIN: path.join(s.dir, 'fake-codex') })
    const UP = 'codex|plugin marketplace upgrade hook-gate\n'
    const ADD = 'codex|plugin add feedback-gate@hook-gate\n'

    test('upgrades the marketplace, adds the plugin, then runs the newest version installer', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const r = run(['--project'], { ...codex(s), FAKE_CODEX_NEW_VERSION: '1.1.0' })
        expect(r.status).toBe(0)
        expect(calls(s)).toBe(`${UP}${ADD}new-1.1.0|--project\n`)
        expect(r.stderr).toContain('feedback-gate: running codex plugin marketplace upgrade hook-gate')
      }))

    test('falls back to marketplace add when the upgrade fails', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        run([], { ...codex(s), FAKE_CODEX_UPGRADE_FAILS: '1', FAKE_CODEX_NEW_VERSION: '1.1.0' })
        expect(calls(s)).toBe(`${UP}codex|plugin marketplace add nonchan7720/claude-hook-gate\n${ADD}new-1.1.0|\n`)
      }))

    test('without codex it says so and uses the installed version', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const r = run(['--project'])
        expect(r.status).toBe(0)
        expect(r.stderr).toContain('codex not found in PATH; skipping the plugin update and using the installed plugin')
        expect(calls(s)).toBe('1.0.0|--project\n')
      }))

    test('without codex and without a plugin the error mentions the skipped update', () =>
      withSetup((_s, run) => {
        const r = run([])
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('the plugin update was skipped')
      }))

    test('--no-update skips codex and is not forwarded (also with --no-command)', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const r = run(['--no-update', '--no-command', '--project'], codex(s))
        expect(r.status).toBe(0)
        expect(calls(s)).toBe('1.0.0|--project\n')
      }))

    test('FEEDBACK_GATE_PLUGIN_DIR means no codex calls', () =>
      withSetup((s, run) => {
        const root = path.join(s.dir, 'checkout')
        fakeInstall(s, root, 'checkout')
        run([], { ...codex(s), FEEDBACK_GATE_PLUGIN_DIR: root })
        expect(calls(s)).toBe('checkout|\n')
      }))

    test('a failing plugin add warns and falls back to the cached version', () =>
      withSetup((s, run) => {
        install(s, ['1.0.0'])
        const r = run([], { ...codex(s), FAKE_CODEX_ADD_FAILS: '1' })
        expect(r.status).toBe(0)
        expect(r.stderr).toContain('feedback-gate: codex plugin add failed; using the installed plugin if any')
        expect(calls(s)).toBe(`${UP}${ADD}1.0.0|\n`)
      }))
  })
})
