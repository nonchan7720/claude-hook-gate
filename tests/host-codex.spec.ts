// Codex 向けの Host（src/host-codex.ts）: Claude Code との違い（apply_patch、PermissionRequest、ask が無いこと、warn の渡し方）を
// normalize / render で吸収し、中核（src/hooks.ts）は共有する。中核の呼び出しは src/host.ts の runCore。
import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PluginOptions } from 'claude-code'
import { runCore } from '../src/host.ts'
import { claudeToolName, codexHost, normalize, render } from '../src/host-codex.ts'
import type { Io } from '../src/io.ts'
import type { Outcome } from '../src/outcome.ts'
import type { Dict } from '../src/pyutil.ts'
import { exists, writeGateYaml } from './helpers/gate.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

type Env = { proj: string; feedback: string; io: Io }

async function withEnv<T>(body: (env: Env) => Promise<T>): Promise<T> {
  const proj = tmpDir()
  const feedback = tmpDir()
  const io = makeIo({ projectDir: proj, env: { CLAUDE_FEEDBACK_DIR: feedback, PATH: '/nonexistent' }, autoCount: false })
  try {
    return await body({ proj, feedback, io })
  } finally {
    rmTree(proj)
    rmTree(feedback)
  }
}

const writeRule = (dir: string, name: string, count: number, enforce = '') =>
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: desc ${name}\ntype: feedback\ncount: ${count}\n${enforce}---\n\n${name} の本文。\n`,
  )

const noTodoPre = "enforce:\n  - event: pre_edit\n    path: '**/*.py'\n    when: 'TODO'\n    message: 'TODO を書かない'\n    severity: ask\n"
const noTodoPost = "enforce:\n  - event: post_edit\n    path: '**/*.py'\n    when: 'TODO'\n    message: 'TODO を残さない'\n"
const noRm = "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    message: forbidden\n    severity: deny\n"

const patch = (proj: string, body: string[], session = 'sess-1') => ({
  session_id: session,
  cwd: proj,
  hook_event_name: 'PreToolUse',
  tool_name: 'apply_patch',
  tool_input: { command: ['*** Begin Patch', ...body, '*** End Patch'].join('\n') },
  tool_use_id: 't1',
})

const options = { agentLaunchGuard: false, autoCount: false }

/** Codex の stdin の payload を normalize して中核に渡す（runHostHook の Io 作成と render を除いた部分）。 */
const runCodexHook = (io: Io, event: string, sessionId: string, opts: PluginOptions, payload: Dict) =>
  runCore(io, normalize(event, payload, io), sessionId, opts)
const outcomeToCodex = (io: Io, event: string, outcome: Outcome, stderr = '') => render(event, outcome, stderr, io)

describe('codexHost / normalize', () => {
  const io = makeIo({ projectDir: '/proj' })

  test('ホストの名前とイベント', () => {
    expect(codexHost.appName).toBe('Codex')
    expect([...codexHost.events]).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SubagentStop'])
    expect(codexHost.options({ FEEDBACK_GATE_AGENT_LAUNCH_GUARD: 'true', FEEDBACK_GATE_AUTO_COUNT: 'false', FEEDBACK_GATE_RULES_FILE: '/r.md' })).toEqual({
      language: undefined,
      agentLaunchGuard: true,
      autoCount: false,
      rulesFile: '/r.md',
    })
    expect(codexHost.options({ CLAUDE_PLUGIN_OPTION_agentLaunchGuard: 'true', CLAUDE_PLUGIN_OPTION_language: 'en' })).toMatchObject({
      language: 'en',
      agentLaunchGuard: true,
      autoCount: true,
    })
  })

  test('apply_patch はファイルごとの Edit / Write に、PermissionRequest は Notification に、未知のイベントは undefined', () => {
    const pre = normalize(
      'PreToolUse',
      { cwd: '/proj', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: a.py\n+x\n*** Update File: b.py\n+y\n*** End Patch' } },
      io,
    )
    expect(pre?.event).toBe('PreToolUse')
    expect(pre?.payloads.map((p) => [p.tool_name, (p.tool_input as Dict).file_path])).toEqual([
      ['Write', '/proj/a.py'],
      ['Edit', '/proj/b.py'],
    ])
    const perm = normalize('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' } }, io)
    expect(perm?.event).toBe('Notification')
    expect(perm?.payloads[0]?.message).toBe('rm x')
    expect(normalize('Stop', { stop_hook_active: false }, io)).toEqual({ event: 'Stop', payloads: [{ stop_hook_active: false }] })
    expect(normalize('SessionEnd', {}, io)).toBeUndefined()
  })
})

describe('claudeToolName', () => {
  test('spawn_agent → Agent、send_input → SendMessage、それ以外はそのまま', () => {
    expect(claudeToolName('spawn_agent')).toBe('Agent')
    expect(claudeToolName('send_input')).toBe('SendMessage')
    expect(claudeToolName('Bash')).toBe('Bash')
    expect(claudeToolName('apply_patch')).toBe('apply_patch')
  })
})

describe('runCodexHook: PreToolUse', () => {
  test('Bash はそのまま pre_bash で判定する', () =>
    withEnv(async ({ io, feedback }) => {
      writeRule(feedback, 'no_rm', 6, noRm)
      const r = await runCodexHook(io, 'PreToolUse', 'sess-1', options, { tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, tool_use_id: 't1' })
      expect(r.outcome.deny).toContain('no_rm (count: 6): forbidden')
    }))

  test('apply_patch はファイルごとに pre_edit で判定し、deny が ask に勝つ', () =>
    withEnv(async ({ io, feedback, proj }) => {
      writeRule(feedback, 'no_todo', 4, noTodoPre)
      writeRule(feedback, 'no_fixme', 6, noTodoPre.replace("'TODO'", "'FIXME'").replace('severity: ask', 'severity: deny'))
      const ask = await runCodexHook(io, 'PreToolUse', 'sess-1', options, patch(proj, ['*** Add File: a.py', '+# TODO']))
      expect(ask.outcome.ask).toContain('no_todo')
      expect(ask.outcome.deny).toBeUndefined()
      const both = await runCodexHook(
        io,
        'PreToolUse',
        'sess-2',
        options,
        patch(proj, ['*** Add File: a.py', '+# TODO', '*** Update File: b.py', '+# FIXME'], 'sess-2'),
      )
      expect(both.outcome.deny).toContain('no_fixme')
      expect(both.outcome.deny).toContain('no_todo')
      expect(both.outcome.ask).toBeUndefined()
      const clean = await runCodexHook(io, 'PreToolUse', 'sess-1', options, patch(proj, ['*** Add File: a.py', '+x = 1', '*** Delete File: z.py']))
      expect(clean.outcome).toEqual({})
    }))

  test('spawn_agent は Agent として agentLaunchGuard の対象になる（agent_type / message を読み替える）', () =>
    withEnv(async ({ io }) => {
      const payload = { tool_name: 'spawn_agent', tool_input: { agent_type: 'code-implementer', message: 'do it' }, tool_use_id: 't2' }
      expect((await runCodexHook(io, 'PreToolUse', 'sess-1', options, payload)).outcome).toEqual({})
      const r = await runCodexHook(io, 'PreToolUse', 'sess-1', { ...options, agentLaunchGuard: true }, payload)
      expect(r.outcome.ask).toContain('code-implementer に送るプロンプト:\n\ndo it')
    }))
})

describe('runCodexHook: PostToolUse', () => {
  test('apply_patch は各ファイルを記録して post_edit で検査し、gate の rules を 1 回走らせる', () =>
    withEnv(async ({ io, feedback, proj }) => {
      writeRule(feedback, 'no_todo', 4, noTodoPost)
      writeGateYaml(proj, { rules: [{ match: '**/*.py', run: ['echo ran >> ran.txt'] }] })
      fs.writeFileSync(path.join(proj, 'a.py'), '# TODO\n')
      fs.writeFileSync(path.join(proj, 'b.py'), 'x = 1\n')
      const payload = {
        ...patch(proj, ['*** Update File: a.py', '+# TODO', '*** Update File: b.py', '+x = 1']),
        hook_event_name: 'PostToolUse',
        tool_response: {},
      }
      const r = await runCodexHook(io, 'PostToolUse', 'sess-1', options, payload)
      expect(r.outcome.block).toContain('no_todo')
      // 記録した変更ファイルは rules フェーズが消費するので、gate のコマンドが 1 回だけ走ったことで確かめる。
      expect(fs.readFileSync(path.join(proj, 'ran.txt'), 'utf8')).toBe('ran\n')
    }))

  test('パッチでない apply_patch は何もしない', () =>
    withEnv(async ({ io }) => {
      const r = await runCodexHook(io, 'PostToolUse', 'sess-1', options, { tool_name: 'apply_patch', tool_input: { command: 'nope' }, tool_response: {} })
      expect(r.outcome).toEqual({})
    }))

  test('spawn_agent の結果（文字列 JSON の agent_id）からサブエージェントの報告を引く', () =>
    withEnv(async ({ io, proj }) => {
      const report = path.join(proj, '.claude', '.gate-status', 'subagent_report.sess-1--ag1.json')
      fs.mkdirSync(path.dirname(report), { recursive: true })
      fs.writeFileSync(report, JSON.stringify({ agentType: 'worker', gate: '[gate] NG' }))
      const r = await runCodexHook(io, 'PostToolUse', 'sess-1', options, {
        session_id: 'sess-1',
        tool_name: 'spawn_agent',
        tool_input: { message: 'p' },
        tool_response: JSON.stringify({ agent_id: 'ag1' }),
        tool_use_id: 't9',
      })
      expect(r.outcome.additionalContext?.join('')).toContain('worker (ag1)')
      expect(r.outcome.additionalContext?.join('')).toContain('[gate] NG')
      expect(exists(report)).toBe(false)
    }))
})

describe('runCodexHook: PermissionRequest / SessionStart', () => {
  test('PermissionRequest は何も返さない（通知だけ）', () =>
    withEnv(async ({ io }) => {
      const r = await runCodexHook(io, 'PermissionRequest', 'sess-1', options, { tool_name: 'Bash', tool_input: { command: 'ls' } })
      expect(r).toEqual({ outcome: {}, stderr: '' })
    }))

  test('SessionStart startup は自セッションの状態を消す', () =>
    withEnv(async ({ io, proj }) => {
      writeGateYaml(proj, { rules: [] })
      const changed = path.join(proj, '.claude', '.gate-status', 'changed_files.sess-1.txt')
      fs.mkdirSync(path.dirname(changed), { recursive: true })
      fs.writeFileSync(changed, 'a.py\n')
      await runCodexHook(io, 'SessionStart', 'sess-1', options, { session_id: 'sess-1', source: 'startup' })
      expect(exists(changed)).toBe(false)
    }))
})

describe('outcomeToCodex', () => {
  const io = makeIo({ projectDir: '/proj' })
  const parse = (stdout: string) => JSON.parse(stdout) as Record<string, unknown> & { hookSpecificOutput?: Record<string, unknown> }

  test('PreToolUse: deny はそのまま、ask は deny に落として理由に添える', () => {
    const deny = parse(outcomeToCodex(io, 'PreToolUse', { deny: 'no' }).stdout)
    expect(deny.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' })
    const ask = parse(outcomeToCodex(io, 'PreToolUse', { ask: 'sure?' }).stdout)
    expect(ask.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(ask.hookSpecificOutput?.permissionDecisionReason).toContain('sure?\n[feedback-gate] Codex の PreToolUse には ask が無い')
    // ask を含む出力に ask という判定は出さない（Codex では hook の失敗になる）。
    expect(outcomeToCodex(io, 'PreToolUse', { ask: 'sure?' }).stdout).not.toContain('"ask"')
  })

  test('PreToolUse: 判定が無く warn だけなら additionalContext、何も無ければ空', () => {
    const r = outcomeToCodex(io, 'PreToolUse', {}, '[feedback-guard] warn: x\n')
    expect(parse(r.stdout).hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', additionalContext: '[feedback-guard] warn: x' })
    expect(r.stderr).toBe('[feedback-guard] warn: x\n')
    expect(outcomeToCodex(io, 'PreToolUse', {}).stdout).toBe('')
  })

  test('PostToolUse: block は decision、warn と additionalContext は additionalContext にまとめる', () => {
    const block = parse(outcomeToCodex(io, 'PostToolUse', { block: 'fix it' }, 'warn\n').stdout)
    expect(block.decision).toBe('block')
    expect(block.reason).toBe('fix it')
    expect(block.hookSpecificOutput).toBeUndefined()
    const ctx = parse(outcomeToCodex(io, 'PostToolUse', { additionalContext: ['report'] }, 'warn\n').stdout)
    expect(ctx.decision).toBeUndefined()
    expect(ctx.hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: 'report\n\nwarn' })
  })

  test('Stop / SubagentStop: block は decision、warn は systemMessage、continue: false は残す', () => {
    const block = parse(outcomeToCodex(io, 'Stop', { block: 'not yet' }, 'warn\n').stdout)
    expect(block).toEqual({ decision: 'block', reason: 'not yet' })
    const warn = parse(outcomeToCodex(io, 'SubagentStop', {}, 'warn\n').stdout)
    expect(warn).toEqual({ systemMessage: 'warn' })
    const stop = parse(outcomeToCodex(io, 'Stop', { preventContinuation: true, stopReason: 'bye' }).stdout)
    expect(stop).toEqual({ continue: false, stopReason: 'bye' })
    expect(outcomeToCodex(io, 'Stop', { additionalContext: ['x'] }).stdout).toBe('')
  })

  test('UserPromptSubmit / SessionStart: additionalContext をつなぐ。PermissionRequest は常に空', () => {
    const r = parse(outcomeToCodex(io, 'UserPromptSubmit', { additionalContext: ['a', '', 'b'] }).stdout)
    expect(r.hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: 'a\n\nb' })
    expect(outcomeToCodex(io, 'SessionStart', {}).stdout).toBe('')
    expect(outcomeToCodex(io, 'PermissionRequest', { deny: 'x', additionalContext: ['y'] }, 'z').stdout).toBe('')
  })
})
