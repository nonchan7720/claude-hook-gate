// plugins/codex/scripts/install-hooks.sh: プラグインのルート（スクリプトの場所から求める）を --root にして `feedback-gate codex install-hooks` を呼ぶ。
// バイナリは hook.sh と同じく FEEDBACK_GATE_BIN、無ければキャッシュ、無ければリリースから（scripts/install-binary.sh）。
// 本体（Go）の単体テストは internal/hookgate/codex_install_hooks_test.go。ここでは本物のバイナリで一通り（書く → 写しが黙る → 外す）も確かめる。
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { feedbackGateBin } from './helpers/go-binary.ts'
import { MISSING_DOGWOOD_BIN, REPO_ROOT, rmTree, tmpDir } from './helpers/node-io.ts'
import { installNotice, makePluginRoot } from './helpers/release-fixture.ts'

const SCRIPT = path.join(REPO_ROOT, 'plugins', 'codex', 'scripts', 'install-hooks.sh')
const BASH = Bun.which('bash') ?? '/bin/bash'
const HOOK = (event: string) => `bash "${REPO_ROOT}/plugins/codex/scripts/hook.sh" ${event}`

function withDir<T>(body: (dir: string) => T): T {
  const dir = tmpDir()
  try {
    return body(dir)
  } finally {
    rmTree(dir)
  }
}

const { CLAUDE_PROJECT_DIR: _cpd, CLAUDE_PLUGIN_ROOT: _cpr, PLUGIN_ROOT: _pr, CODEX_HOME: _ch, ...base } = process.env as Record<string, string>

const run = (args: string[], env: Record<string, string>, cwd?: string) =>
  spawnSync(BASH, [SCRIPT, ...args], { encoding: 'utf8', env: { ...base, ...env }, cwd })

describe('plugins/codex/scripts/install-hooks.sh', () => {
  test('runs feedback-gate codex install-hooks --root <repository root> with the arguments, and returns its exit code', () =>
    withDir((dir) => {
      const calls = path.join(dir, 'calls.txt')
      const fake = path.join(dir, 'fake')
      fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s|%s\\n' "$*" "$CLAUDE_PLUGIN_ROOT" >> "${calls}"\nexit 4\n`, { mode: 0o755 })
      const r = run(['--project', 'x', '--remove'], { FEEDBACK_GATE_BIN: fake })
      expect(r.status).toBe(4)
      expect(fs.readFileSync(calls, 'utf8')).toBe(`codex install-hooks --root ${REPO_ROOT} --project x --remove|${REPO_ROOT}\n`)
    }))

  test('without a binary it fails (exit 1) with the install notice, unlike hook.sh which stays silent', () =>
    withDir((dir) => {
      // バイナリの探索はリポジトリの .claude-plugin/plugin.json の version で行われる。ダウンロードの道具を隠して失敗させる。
      const bin = path.join(dir, 'bin')
      fs.mkdirSync(bin)
      for (const c of ['dirname', 'uname', 'mkdir', 'find', 'touch', 'mktemp', 'rm', 'sed', 'head', 'tr', 'sha256sum']) {
        const real = Bun.which(c)
        if (real) fs.symlinkSync(real, path.join(bin, c))
      }
      const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version as string
      const r = spawnSync(BASH, [SCRIPT], { encoding: 'utf8', env: { PATH: bin, HOME: dir, FEEDBACK_GATE_CACHE_DIR: path.join(dir, 'cache') } })
      expect(r.status).toBe(1)
      expect(r.stderr).toBe(installNotice(version, 'no-download-tool'))
      expect(fs.existsSync(path.join(dir, '.codex', 'hooks.json'))).toBe(false)
      void makePluginRoot
    }))

  test('end to end: writes ~/.codex/hooks.json, a copy stays silent while the plugin-layer hook runs in the session, --remove takes it out', () =>
    withDir((home) => {
      const bin = feedbackGateBin()
      const target = path.join(home, '.codex', 'hooks.json')
      const r = run([], { FEEDBACK_GATE_BIN: bin, HOME: home })
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
      expect(r.stdout).toContain(`added 7 hook group(s)`)
      const doc = JSON.parse(fs.readFileSync(target, 'utf8')) as {
        hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>
      }
      expect(Object.keys(doc.hooks).sort()).toEqual([
        'PermissionRequest',
        'PostToolUse',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'SubagentStop',
        'UserPromptSubmit',
      ])
      expect(doc.hooks.PreToolUse?.[0]).toEqual({
        matcher: 'Bash|apply_patch|spawn_agent|send_input',
        hooks: [{ type: 'command', command: HOOK('PreToolUse') }],
      })
      expect(doc.hooks.Stop?.[0]?.hooks[0]).toEqual({ type: 'command', command: HOOK('Stop'), timeout: 600 })

      // 写された hook.sh を Codex のように呼ぶ（PLUGIN_ROOT なし）: UserPromptSubmit は rules を additionalContext に出す。
      const proj = tmpDir()
      const feedback = path.join(home, 'fb')
      const env = { ...base, HOME: home, CLAUDE_FEEDBACK_DIR: feedback, FEEDBACK_GATE_BIN: bin, DOGWOOD_BIN: MISSING_DOGWOOD_BIN, LANG: 'en_US.UTF-8' }
      const payload = JSON.stringify({ session_id: 'thr_x', cwd: proj, hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
      const hook = (extra: Record<string, string>) =>
        spawnSync(BASH, [path.join(REPO_ROOT, 'plugins', 'codex', 'scripts', 'hook.sh'), 'UserPromptSubmit'], {
          input: payload,
          encoding: 'utf8',
          env: { ...env, ...extra },
          cwd: proj,
        })
      try {
        const copy = hook({})
        expect(copy.status).toBe(0)
        expect(copy.stdout).toContain('additionalContext')
        // 同じセッションでプラグイン層（PLUGIN_ROOT あり）が走るとマーカーが書かれ、以後、写しは何も出さない。
        const plugin = hook({ PLUGIN_ROOT: REPO_ROOT })
        expect(plugin.status).toBe(0)
        expect(plugin.stdout).toContain('additionalContext')
        expect(fs.existsSync(path.join(feedback, '.codex_plugin_seen', 'thr_x'))).toBe(true)
        const silent = hook({})
        expect(silent.status).toBe(0)
        expect(silent.stdout).toBe('')
        expect(silent.stderr).toBe('')
      } finally {
        rmTree(proj)
      }

      const removed = run(['--remove'], { FEEDBACK_GATE_BIN: bin, HOME: home })
      expect(removed.status).toBe(0)
      expect(removed.stdout).toContain('removed 7 feedback-gate hook group(s)')
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ hooks: {} })
    }))
})
