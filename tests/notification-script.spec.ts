import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { REPO_ROOT, withTmp } from './helpers/node-io.ts'

// scripts/notification.sh（hooks/hooks.json の Notification command hook）: classic.Notification が走る環境では
// マーカー（<feedbackDir>/.classic_seen/<session>）を見て黙り、走らない環境（組織管理のガードが classic.* を飛ばす）では通知する。
const script = path.join(REPO_ROOT, 'scripts', 'notification.sh')
const hasJq = spawnSync('jq', ['--version']).status === 0

/** terminal-notifier / osascript の代役を置いた PATH で実行し、terminal-notifier に渡った引数を返す。 */
function run(root: string, payload: unknown, env: Record<string, string> = {}, withJq = true): { status: number | null; notified: string[] } {
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const log = path.join(root, 'notifier.log')
  fs.writeFileSync(path.join(bin, 'terminal-notifier'), `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'osascript'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
  // jq の無い環境を作るため、必要なコマンドだけをリンクした PATH を使う。
  const tools = path.join(root, 'tools')
  fs.mkdirSync(tools, { recursive: true })
  for (const name of ['bash', 'cat', 'git', 'basename', 'tr', 'dirname', ...(withJq ? ['jq'] : [])]) {
    const found = spawnSync('bash', ['-c', `command -v ${name}`])
      .stdout.toString()
      .trim()
    if (found && !fs.existsSync(path.join(tools, name))) fs.symlinkSync(found, path.join(tools, name))
  }
  const r = spawnSync('bash', [script, 'notify'], {
    input: JSON.stringify(payload),
    env: { PATH: `${bin}:${tools}`, HOME: root, TERM_PROGRAM: 'iTerm.app', ...env },
  })
  return { status: r.status, notified: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] }
}

describe.skipIf(!hasJq)('scripts/notification.sh', () => {
  test('is executable and its hook is registered in hooks.json', () => {
    expect(fs.statSync(script).mode & 0o111).not.toBe(0)
    const hooks = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8'))
    expect(hooks.hooks.Notification[0].hooks[0].command).toContain('scripts/notification.sh')
  })

  test('notifies when no classic marker exists, with the message and a Japanese label under a Japanese locale', () =>
    withTmp(async (root) => {
      const r = run(root, { session_id: 's1', cwd: root, message: 'hello' }, { LANG: 'ja_JP.UTF-8' })
      expect(r.status).toBe(0)
      expect(r.notified).toContain('hello')
      expect(r.notified.join('\n')).toContain('確認待ち')
    }))

  test('uses English for other locales and when no locale is set', () =>
    withTmp(async (root) => {
      expect(run(root, { session_id: 's1', cwd: root }, { LANG: 'C' }).notified.join('\n')).toContain('Waiting for you')
      fs.rmSync(path.join(root, 'notifier.log'))
      const r = run(root, { session_id: 's1', cwd: root })
      expect(r.notified).toContain('Claude is waiting for your input')
    }))

  test('FEEDBACK_GATE_LANG wins over LANG, like src/i18n.ts', () =>
    withTmp(async (root) => {
      const r = run(root, { session_id: 's1', cwd: root }, { FEEDBACK_GATE_LANG: 'en', LANG: 'ja_JP.UTF-8' })
      expect(r.notified.join('\n')).toContain('Waiting for you')
    }))

  test('stays quiet when the classic marker of the session exists (default and CLAUDE_FEEDBACK_DIR locations)', () =>
    withTmp(async (root) => {
      const marker = path.join(root, '.claude', 'feedback', '.classic_seen', 's1')
      fs.mkdirSync(path.dirname(marker), { recursive: true })
      fs.writeFileSync(marker, '1\n')
      const quiet = run(root, { session_id: 's1', cwd: root })
      expect(quiet.status).toBe(0)
      expect(quiet.notified).toEqual([])
      // 別セッションのマーカーでは黙らない。
      expect(run(root, { session_id: 's2', cwd: root }).notified.length).toBeGreaterThan(0)
      fs.rmSync(path.join(root, 'notifier.log'))
      const custom = path.join(root, 'fb')
      fs.mkdirSync(path.join(custom, '.classic_seen'), { recursive: true })
      fs.writeFileSync(path.join(custom, '.classic_seen', 's3'), '1\n')
      expect(run(root, { session_id: 's3', cwd: root }, { CLAUDE_FEEDBACK_DIR: custom }).notified).toEqual([])
    }))

  test('exits 0 without jq', () =>
    withTmp(async (root) => {
      const r = run(root, { session_id: 's1', cwd: root }, {}, false)
      expect(r.status).toBe(0)
      expect(r.notified).toEqual([])
    }))
})
