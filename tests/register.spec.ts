import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { register } from '../src/register.ts'
import { publishRunning } from '../src/running-registry.ts'
import { loadMod } from './helpers/fake-engine.ts'
import { exists, writeChangedFiles, writeGateYaml } from './helpers/gate.ts'
import { MISSING_DOGWOOD_BIN, makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

type Out = Record<string, unknown>

const statusLog: Array<string | undefined> = []
const invalidateLog: string[] = []
const runLog: string[][] = []
const timerLog: number[] = []
const commandLog: Array<{ name: string; description: string }> = []
// true の間、遅延表示の待ち時間（$.clock.every）は既に経過したものとして扱う。
let elapsed = false
// 完了通知は最初に osascript で前面ウィンドウを調べるので、その実行回数を通知を試みた回数として数える
const notifyCount = () => runLog.filter((argv) => argv[0] === 'osascript').length

async function withMod<T>(
  body: (m: ReturnType<typeof loadMod>, proj: string, feedback: string, home: string) => Promise<T>,
  options: Record<string, unknown> = {},
  env: Record<string, string> = {},
): Promise<T> {
  const proj = tmpDir()
  const feedback = tmpDir()
  const home = tmpDir()
  statusLog.length = 0
  invalidateLog.length = 0
  runLog.length = 0
  timerLog.length = 0
  commandLog.length = 0
  elapsed = false
  try {
    const m = loadMod(register, {
      projectDir: proj,
      options,
      statusLog,
      invalidateLog,
      runLog,
      timerLog,
      commandLog,
      elapsed: () => elapsed,
      stubCommands: ['osascript', 'terminal-notifier'],
      env: { HOME: home, CLAUDE_FEEDBACK_DIR: feedback, DOGWOOD_BIN: MISSING_DOGWOOD_BIN, ...env },
    })
    return await body(m, proj, feedback, home)
  } finally {
    rmTree(proj)
    rmTree(feedback)
    rmTree(home)
  }
}

const writeRule = (dir: string, name: string, count: number, enforce = '') =>
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: desc ${name}\ntype: feedback\ncount: ${count}\n${enforce}---\n\n${name} の本文。\n`,
  )

describe('SessionStart', () => {
  test('startup resets the session state and adds no context', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, { rules: [] })
      writeChangedFiles(proj, 'sess-1', 'a.py')
      const r = (await m.call('classic.SessionStart', { source: 'startup', session_id: 'sess-1' })) as Out
      expect(r.additionalContext).toBeUndefined()
      expect(exists(path.join(proj, '.claude', '.gate-status', 'changed_files.sess-1.txt'))).toBe(false)
    }))

  test('resume keeps the state', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, { rules: [] })
      writeChangedFiles(proj, 'sess-1', 'a.py')
      await m.call('classic.SessionStart', { source: 'resume', session_id: 'sess-1' })
      expect(exists(path.join(proj, '.claude', '.gate-status', 'changed_files.sess-1.txt'))).toBe(true)
    }))
})

describe('/correct', () => {
  test('session.start registers the command', () =>
    withMod(async (m) => {
      await m.call('session.start', {})
      expect(commandLog.map((c) => c.name)).toEqual(['correct'])
      expect(commandLog[0]?.description).toContain('feedback ルール')
    }))

  test('the command description follows the language', () =>
    withMod(
      async (m) => {
        await m.call('session.start', {})
        expect(commandLog[0]?.description).toBe('Aggregate the feedback rules and the violation log, and propose count bumps and enforce additions')
      },
      { language: 'en' },
    ))

  test('command.run returns the report text', () =>
    withMod(async (m) => {
      const r = (await m.call('command.run', { command: 'correct', args: '' })) as Out
      expect(String(r.text).startsWith('[correct] 直近 30d')).toBe(true)
    }))

  test('command.run reports in English when LANG is not Japanese and language is auto', () =>
    withMod(
      async (m) => {
        const r = (await m.call('command.run', { command: 'correct', args: '' })) as Out
        expect(String(r.text)).toBe(
          '[correct] last 30d: 0 rules / 0 violations\nNo proposals.\n`/correct apply` writes the count bumps of the bump proposals to the files (enforce is proposal only).',
        )
      },
      { language: 'auto' },
      { LANG: 'en_US.UTF-8' },
    ))

  test('FEEDBACK_GATE_LANG overrides the OS locale when language is auto', () =>
    withMod(
      async (m) => {
        const r = (await m.call('command.run', { command: 'correct', args: '' })) as Out
        expect(String(r.text).startsWith('[correct] 直近 30d')).toBe(true)
      },
      {},
      { LANG: 'en_US.UTF-8', FEEDBACK_GATE_LANG: 'ja' },
    ))

  test('language ja wins over an English LANG', () =>
    withMod(
      async (m) => {
        const r = (await m.call('command.run', { command: 'correct', args: '' })) as Out
        expect(String(r.text).startsWith('[correct] 直近 30d')).toBe(true)
      },
      { language: 'ja' },
      { LANG: 'en_US.UTF-8' },
    ))
})

describe('UserPromptSubmit', () => {
  test('without a custom rules file the bundled rules and confirmed feedback are injected', () =>
    withMod(async (m, _proj, feedback) => {
      writeRule(feedback, 'confirmed', 3)
      writeRule(feedback, 'unconfirmed', 1)
      const r = (await m.call('classic.UserPromptSubmit', { prompt: 'hi' })) as { additionalContext: string[] }
      const bundled = fs.readFileSync(path.join(import.meta.dir, '..', 'rules', 'feedback_rules.md'), 'utf8').trim()
      expect(r.additionalContext[0]).toBe(bundled)
      expect(r.additionalContext[1]).toContain('■ confirmed (これまで 3 回指摘されています)')
      expect(r.additionalContext[1]).not.toContain('unconfirmed')
    }))

  test('a rules file at the default path replaces the bundled one', () =>
    withMod(async (m, _proj, _feedback, home) => {
      fs.mkdirSync(path.join(home, '.claude', 'feedback-gate'), { recursive: true })
      fs.writeFileSync(path.join(home, '.claude', 'feedback-gate', 'feedback_rules.md'), 'CUSTOM\n')
      const r = (await m.call('classic.UserPromptSubmit', { prompt: 'hi' })) as { additionalContext: string[] }
      expect(r.additionalContext).toEqual(['CUSTOM'])
    }))

  test('~/.claude/rules/feedback_rules.md is never read', () =>
    withMod(async (m, _proj, _feedback, home) => {
      fs.mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true })
      fs.writeFileSync(path.join(home, '.claude', 'rules', 'feedback_rules.md'), 'LEGACY\n')
      const r = (await m.call('classic.UserPromptSubmit', { prompt: 'hi' })) as { additionalContext: string[] }
      expect(r.additionalContext).not.toContain('LEGACY')
    }))

  test('with language en the bundled English rules and English feedback header are injected', () =>
    withMod(
      async (m, _proj, feedback) => {
        writeRule(feedback, 'confirmed', 3)
        const r = (await m.call('classic.UserPromptSubmit', { prompt: 'hi' })) as { additionalContext: string[] }
        const bundled = fs.readFileSync(path.join(import.meta.dir, '..', 'rules', 'feedback_rules.en.md'), 'utf8').trim()
        expect(r.additionalContext[0]).toBe(bundled)
        expect(r.additionalContext[1]).toContain('# Confirmed feedback rules (count >= 3)')
        expect(r.additionalContext[1]).toContain('■ confirmed (pointed out 3 times so far)')
      },
      { language: 'en' },
    ))

  test('a custom rules file is used as is whatever the language', () =>
    withMod(
      async (m, _proj, _feedback, home) => {
        fs.mkdirSync(path.join(home, '.claude', 'feedback-gate'), { recursive: true })
        fs.writeFileSync(path.join(home, '.claude', 'feedback-gate', 'feedback_rules.md'), 'CUSTOM\n')
        const r = (await m.call('classic.UserPromptSubmit', { prompt: 'hi' })) as { additionalContext: string[] }
        expect(r.additionalContext).toEqual(['CUSTOM'])
      },
      { language: 'en' },
    ))

  test('rulesFile option points to another path', () =>
    withMod(
      async (m, _proj, _feedback, home) => {
        fs.mkdirSync(path.join(home, 'custom'), { recursive: true })
        fs.writeFileSync(path.join(home, 'custom', 'rules.md'), 'ELSEWHERE\n')
        const r = (await m.call('classic.UserPromptSubmit', { prompt: 'hi' })) as { additionalContext: string[] }
        expect(r.additionalContext).toEqual(['ELSEWHERE'])
      },
      { rulesFile: '~/custom/rules.md' },
    ))
})

describe('PreToolUse', () => {
  const denyRule = "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    message: 'forbidden'\n    severity: deny\n"

  test('a violating Bash call is denied with the rule message', () =>
    withMod(async (m, _proj, feedback) => {
      writeRule(feedback, 'no_rm', 6, denyRule)
      const r = (await m.call('classic.PreToolUse', { tool: 'Bash', command: 'rm -rf x', tool_use_id: 't1' })) as Out
      expect(String(r.deny)).toContain('no_rm (count: 6): forbidden')
    }))

  test('an ask decision is returned without passing to the next hook', () =>
    withMod(async (m, _proj, feedback) => {
      writeRule(feedback, 'confirm_rm', 4, denyRule.replace('severity: deny', 'severity: ask'))
      let reached = false
      const r = (await m.call('classic.PreToolUse', { tool: 'Bash', command: 'rm -rf x' }, async () => {
        reached = true
        return {}
      })) as Out
      expect(String(r.ask)).toContain('confirm_rm')
      expect(reached).toBe(false)
    }))

  test('a clean Bash call and non-target tools pass through', () =>
    withMod(async (m, _proj, feedback) => {
      writeRule(feedback, 'no_rm', 6, denyRule)
      expect(await m.call('classic.PreToolUse', { tool: 'Bash', command: 'ls' })).toEqual({})
      let reached = false
      await m.call('classic.PreToolUse', { tool: 'Read', file_path: '/a' }, async () => {
        reached = true
        return {}
      })
      expect(reached).toBe(true)
    }))

  test('Agent / SendMessage are ignored unless agentLaunchGuard is on', () =>
    withMod(async (m) => {
      let reached = 0
      const next = async () => {
        reached++
        return {}
      }
      await m.call('classic.PreToolUse', { tool: 'Agent', subagent_type: 'code-implementer', prompt: 'p' }, next)
      await m.call('classic.PreToolUse', { tool: 'SendMessage', to: 'x', message: 'm' }, next)
      expect(reached).toBe(2)
    }))

  test('agentLaunchGuard asks with the full prompt', () =>
    withMod(
      async (m) => {
        let reached = false
        const r = (await m.call('classic.PreToolUse', { tool: 'Agent', subagent_type: 'code-implementer', prompt: 'do it' }, async () => {
          reached = true
          return {}
        })) as Out
        expect(String(r.ask)).toContain('code-implementer に送るプロンプト:\n\ndo it')
        expect(reached).toBe(false)
        const s = (await m.call('classic.PreToolUse', { tool: 'SendMessage', to: 'git-operator', message: 'm' })) as Out
        expect(s.ask).toBeUndefined()
      },
      { agentLaunchGuard: true },
    ))
})

describe('PostToolUse', () => {
  test('records the changed file and runs the rules phase; failures block', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['echo lint-failed; exit 1'] }] })
      const r = (await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: 'x.py' }, tool_response: {} })) as Out
      expect(String(r.block)).toContain('lint-failed')
      // 失敗したファイルは CHANGED に残る
      expect(fs.readFileSync(path.join(proj, '.claude', '.gate-status', 'changed_files.sess-1.txt'), 'utf8')).toBe('x.py\n')
    }))

  test('Bash: files written between PreToolUse and PostToolUse are recorded and the rules run', () =>
    withMod(async (m, proj) => {
      for (const args of [
        ['init', '-q'],
        ['config', 'user.email', 't@example.com'],
        ['config', 'user.name', 't'],
      ])
        execFileSync('git', args, { cwd: proj })
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['echo lint-failed; exit 1'] }] })
      // gate.yaml 自体が未追跡の変更として拾われないよう、先にコミットしておく
      for (const args of [
        ['add', '.'],
        ['commit', '-q', '-m', 'init'],
      ])
        execFileSync('git', args, { cwd: proj })
      await m.call('classic.PreToolUse', { tool: 'Bash', command: 'gen', tool_use_id: 'tu1' })
      fs.writeFileSync(path.join(proj, 'x.py'), 'x = 1\n')
      const r = (await m.call('classic.PostToolUse', {
        session_id: 'sess-1',
        tool_name: 'Bash',
        tool_input: { command: 'gen' },
        tool_response: {},
        tool_use_id: 'tu1',
      })) as Out
      expect(String(r.block)).toContain('lint-failed')
      expect(fs.readFileSync(path.join(proj, '.claude', '.gate-status', 'changed_files.sess-1.txt'), 'utf8')).toBe(`${path.join(proj, 'x.py')}\n`)
    }))

  test('a post_edit feedback rule blocks on the edited file content', () =>
    withMod(async (m, proj, feedback) => {
      writeRule(feedback, 'no_todo', 4, "enforce:\n  - event: post_edit\n    path: '**/*.py'\n    when: 'TODO'\n    message: 'TODO を残さない'\n")
      fs.writeFileSync(path.join(proj, 'x.py'), 'x = 1  # TODO\n')
      const r = (await m.call('classic.PostToolUse', {
        session_id: 'sess-1',
        tool_name: 'Edit',
        tool_input: { file_path: path.join(proj, 'x.py') },
        tool_response: {},
      })) as Out
      expect(String(r.block)).toContain('no_todo')
      expect(String(r.block)).toContain('TODO を残さない')
    }))

  test('non-edit tools do nothing', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['true'] }] })
      let reached = false
      await m.call('classic.PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'x.py' } }, async () => {
        reached = true
        return {}
      })
      expect(reached).toBe(true)
      expect(exists(path.join(proj, '.claude', '.gate-status'))).toBe(false)
    }))
})

describe('Stop / SubagentStop / Notification', () => {
  test('Stop blocks while reserved checks fail', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, {
        rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
        consistency_checks: [{ name: 'chk', run: ['echo broken; exit 1'] }],
      })
      await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'x.py' } })
      const r = (await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: false })) as Out
      expect(String(r.block)).toContain('consistency checks 失敗')
    }))

  test('Stop blocks once to report success, then the follow-up Stop passes', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, {
        rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
        consistency_checks: [{ name: 'chk', run: [{ cmd: 'true', name: 'lint' }] }],
      })
      await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'x.py' } })
      const first = (await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: false })) as Out
      expect(String(first.block)).toContain('検証がすべて通りました: lint ✓')
      const second = (await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: true })) as Out
      expect(second.block).toBeUndefined()
    }))

  test('the follow-up Stop after the success report notifies completion once; the report block itself does not', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, {
        rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
        consistency_checks: [{ name: 'chk', run: [{ cmd: 'true', name: 'lint' }] }],
      })
      await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'x.py' } })
      await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: false })
      expect(notifyCount()).toBe(0)
      await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: true })
      expect(notifyCount()).toBe(1)
      // 印は消費済みなので、さらに続く stop_hook_active の Stop では鳴らない
      await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: true })
      expect(notifyCount()).toBe(1)
    }))

  test('the follow-up Stop after a failure block does not notify', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, {
        rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
        consistency_checks: [{ name: 'chk', run: ['echo broken; exit 1'] }],
      })
      await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'x.py' } })
      await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: false })
      await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: true })
      expect(notifyCount()).toBe(0)
    }))

  test('a Stop with stop_hook_active and no report marker does not notify', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, { rules: [] })
      await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: true })
      expect(notifyCount()).toBe(0)
    }))

  test('Stop passes when nothing is pending', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, { rules: [] })
      const r = (await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: true })) as Out
      expect(r.block).toBeUndefined()
    }))

  test('SubagentStop runs the gate checks and the feedback stop check; the first block wins', () =>
    withMod(async (m, proj, feedback) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }], consistency_checks: [{ name: 'chk', run: ['exit 1'] }] })
      writeRule(
        feedback,
        'readme',
        4,
        "enforce:\n  - event: stop_check\n    changed: '**/*.py'\n    check: 'exit 1'\n    message: 'bad'\n    severity: block\n",
      )
      await m.call('classic.PostToolUse', { session_id: 'sess-1', agent_id: 'a1', tool_name: 'Write', tool_input: { file_path: 'x.py' } })
      const r = (await m.call('classic.SubagentStop', { session_id: 'sess-1', agent_id: 'a1', stop_hook_active: false })) as Out
      expect(String(r.block)).toContain('consistency checks 失敗')
    }))

  test('a blocked gate run never draws on the status line while running, and leaves its result there', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, {
        rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
        consistency_checks: [{ name: 'chk', run: ['exit 1'] }],
      })
      await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'x.py' } })
      statusLog.length = 0
      invalidateLog.length = 0
      const blocked = (await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: false })) as Out
      expect(String(blocked.block)).toContain('consistency checks 失敗')
      expect(statusLog.some((t) => t?.startsWith('[gate] 実行中'))).toBe(false)
      expect(statusLog.at(-1)).toMatch(/^\[gate\] 完了: ✗ 1 \(\d+\.\ds\)$/)
      expect(invalidateLog).toContain('ui.render')
    }))

  test('PostToolUse leaves the rules-phase result on the status line and asks the band to redraw', () =>
    withMod(async (m, proj) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [{ cmd: 'true', name: 'fmt' }] }] })
      await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'x.py' } })
      expect(statusLog.filter((t) => t !== undefined)).toEqual([expect.stringMatching(/^\[gate\] 完了: ✓ 1 \(\d+\.\ds\)$/)])
      expect(statusLog.at(-1)).toMatch(/^\[gate\] 完了: ✓ 1 /)
      expect(invalidateLog).toContain('ui.render')
    }))

  test('PreToolUse shows the evaluated rule only after 3 seconds, and clears even on deny', () =>
    withMod(async (m, _proj, feedback) => {
      writeRule(feedback, 'no_rm', 6, "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    check: 'false'\n    message: 'forbidden'\n    severity: deny\n")
      elapsed = true
      const r = (await m.call('classic.PreToolUse', { tool: 'Bash', command: 'rm -rf x' })) as Out
      expect(String(r.deny)).toContain('no_rm')
      expect(timerLog).toEqual([3000])
      expect(statusLog).toEqual(['[feedback-guard] 評価中: no_rm', undefined])
    }))

  test('PreToolUse that finishes within 3 seconds never touches the status line', () =>
    withMod(async (m, proj, feedback) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [{ cmd: 'true', name: 'fmt' }] }] })
      writeRule(feedback, 'no_rm', 6, "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    check: 'false'\n    message: 'forbidden'\n    severity: deny\n")
      await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'x.py' } })
      statusLog.length = 0
      timerLog.length = 0
      const r = (await m.call('classic.PreToolUse', { tool: 'Bash', command: 'rm -rf x' })) as Out
      expect(String(r.deny)).toContain('no_rm')
      expect(timerLog).toEqual([3000])
      expect(statusLog).toEqual([])
    }))

  test('PreToolUse returns the status line to the gate summary after showing the evaluated rule', () =>
    withMod(async (m, proj, feedback) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [{ cmd: 'true', name: 'fmt' }] }] })
      writeRule(feedback, 'no_rm', 6, "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    check: 'false'\n    message: 'forbidden'\n    severity: deny\n")
      await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'x.py' } })
      statusLog.length = 0
      elapsed = true
      await m.call('classic.PreToolUse', { tool: 'Bash', command: 'rm -rf x' })
      expect(statusLog).toEqual(['[feedback-guard] 評価中: no_rm', expect.stringMatching(/^\[gate\] 完了: ✓ 1 \(\d+\.\ds\)$/)])
    }))

  test('the kept gate summary is dropped once the next gate command starts', () =>
    withMod(async (m, proj, feedback) => {
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: [{ cmd: 'true', name: 'fmt' }] }] })
      writeRule(feedback, 'no_rm', 6, "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    check: 'false'\n    message: 'forbidden'\n    severity: deny\n")
      await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'x.py' } })
      await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: 'y.py' } })
      statusLog.length = 0
      elapsed = true
      await m.call('classic.PreToolUse', { tool: 'Bash', command: 'rm -rf x' })
      expect(statusLog.at(-1)).toMatch(/^\[gate\] 完了: ✓ 1 /)
      expect(statusLog.filter((t) => t?.startsWith('[gate]')).length).toBe(1)
    }))

  describe('ui.render AbovePrompt band', () => {
    const idle = { type: 'Text', children: ['engine band'] }
    const input = (hasSurvey = false) => ({ surface: 'terminal', component: 'AbovePrompt', requestId: 'r1', props: { hasSurvey, isWorking: false } })
    const render = (m: ReturnType<typeof loadMod>, hasSurvey = false) => m.call('ui.render', input(hasSurvey), async () => idle)
    const ownerIo = (proj: string) => makeIo({ projectDir: proj })

    test('draws a column of lines while something is running', () =>
      withMod(async (m, proj) => {
        const started = Date.now()
        await publishRunning(ownerIo(proj), 'sess-1.a1', [
          { name: 'typecheck', cmd: 'bun run typecheck', started, result: 'ok', ended: started + 700 },
          { name: 'test', cmd: 'bun run test', started },
        ])
        const tree = (await render(m)) as unknown as { type: string; children: Array<{ children: string[] }> }
        expect(tree.type).toBe('Box')
        const lines = tree.children.map((c) => c.children[0])
        expect(lines[0]).toBe('[gate] 実行中:')
        expect(lines[1]).toBe('  typecheck ✓ (0.7s)')
        expect(lines[2]).toMatch(/^ {2}test \$ bun run test \(\d+s\)$/)
      }))

    test('goes back to the engine band once everything has finished or nothing is listed', () =>
      withMod(async (m, proj) => {
        expect(await render(m)).toBe(idle as never)
        const started = Date.now()
        await publishRunning(ownerIo(proj), 'sess-1.a1', [{ name: 'lint', cmd: 'x', started, result: 'ok', ended: started + 100 }])
        expect(await render(m)).toBe(idle as never)
      }))

    test('shows only the own session, including its subagents', () =>
      withMod(async (m, proj) => {
        const started = Date.now()
        await publishRunning(ownerIo(proj), 'sess-9.b1', [{ name: 'other', cmd: 'x', started }])
        expect(await render(m)).toBe(idle as never)
        await publishRunning(ownerIo(proj), 'sess-1--agent.c1', [{ name: 'sub', cmd: 'x', started }])
        const tree = (await render(m)) as unknown as { children: Array<{ children: string[] }> }
        expect(tree.children.map((c) => c.children[0])).toEqual(['[gate] 実行中:', expect.stringMatching(/^ {2}sub \$ x /)])
      }))

    test('yields to a survey', () =>
      withMod(async (m, proj) => {
        await publishRunning(ownerIo(proj), 'sess-1.a1', [{ name: 'test', cmd: 'x', started: Date.now() }])
        expect(await render(m, true)).toBe(idle as never)
      }))
  })

  test('hooks that run nothing leave the status line alone', () =>
    withMod(async (m, proj, feedback) => {
      writeGateYaml(proj, { rules: [] })
      writeRule(feedback, 'no_rm', 6, "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    message: 'forbidden'\n    severity: deny\n")
      await m.call('classic.PreToolUse', { tool: 'Bash', command: 'ls' })
      await m.call('classic.PreToolUse', { tool: 'Read', file_path: '/a' })
      await m.call('classic.PostToolUse', { session_id: 'sess-1', tool_name: 'Read' })
      await m.call('classic.Stop', { session_id: 'sess-1', stop_hook_active: true })
      expect(statusLog).toEqual([])
    }))

  test('Notification never blocks and always continues to the next hook', () =>
    withMod(async (m) => {
      let reached = false
      const r = (await m.call('classic.Notification', { message: 'm', notification_type: 'idle_prompt' }, async () => {
        reached = true
        return {}
      })) as Out
      expect(reached).toBe(true)
      expect(r.block).toBeUndefined()
    }))
})
