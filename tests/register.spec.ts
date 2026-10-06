import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { register } from '../src/register.ts'
import { loadMod } from './helpers/fake-engine.ts'
import { exists, writeChangedFiles, writeGateYaml } from './helpers/gate.ts'
import { MISSING_DOGWOOD_BIN, rmTree, tmpDir } from './helpers/node-io.ts'

type Out = Record<string, unknown>

async function withMod<T>(
  body: (m: ReturnType<typeof loadMod>, proj: string, feedback: string, home: string) => Promise<T>,
  options: Record<string, unknown> = {},
): Promise<T> {
  const proj = tmpDir()
  const feedback = tmpDir()
  const home = tmpDir()
  try {
    const m = loadMod(register, { projectDir: proj, options, env: { HOME: home, CLAUDE_FEEDBACK_DIR: feedback, DOGWOOD_BIN: MISSING_DOGWOOD_BIN } })
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
