// settings hook の CLI（Go 製の feedback-gate バイナリ、cmd/feedback-gate）: `feedback-gate claude <Event>` を子プロセスで起動し、classic の規約（stdin の JSON → stdout の JSON / stderr / 終了コード）を確かめる。
import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { exists, writeGateYaml } from './helpers/gate.ts'
import { feedbackGateBin } from './helpers/go-binary.ts'
import { MISSING_DOGWOOD_BIN, REPO_ROOT, rmTree, tmpDir } from './helpers/node-io.ts'

type Out = Record<string, unknown>
type Json = {
  decision?: string
  reason?: string
  hookSpecificOutput: { hookEventName: string; permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }
}
type Result = { exitCode: number; stdout: string; stderr: string; json: Json | undefined }

type Env = { proj: string; feedback: string; home: string }

async function withEnv<T>(body: (env: Env) => Promise<T>): Promise<T> {
  const env = { proj: tmpDir(), feedback: tmpDir(), home: tmpDir() }
  try {
    return await body(env)
  } finally {
    rmTree(env.proj)
    rmTree(env.feedback)
    rmTree(env.home)
  }
}

/** CLI を子プロセスで走らせる。session_id と cwd は既定で補う。extra はプラグイン設定などの環境変数。 */
async function hook(env: Env, event: string, payload: Out, extra: Record<string, string> = {}): Promise<Result> {
  const { LANG: _l, LC_ALL: _a, LC_MESSAGES: _m, FEEDBACK_GATE_LANG: _f, CLAUDE_AGENT_ID: _g, ...base } = process.env as Record<string, string>
  const proc = Bun.spawn([feedbackGateBin(), 'claude', event], {
    cwd: env.proj,
    env: {
      ...base,
      HOME: env.home,
      LANG: 'ja_JP.UTF-8',
      CLAUDE_FEEDBACK_DIR: env.feedback,
      CLAUDE_PROJECT_DIR: env.proj,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      DOGWOOD_BIN: MISSING_DOGWOOD_BIN,
      ...extra,
    },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'sess-1', cwd: env.proj, hook_event_name: event, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  let json: Json | undefined
  try {
    json = JSON.parse(stdout)
  } catch {
    json = undefined
  }
  return { exitCode, stdout, stderr, json }
}

const writeRule = (dir: string, name: string, count: number, enforce = '') =>
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: desc ${name}\ntype: feedback\ncount: ${count}\n${enforce}---\n\n${name} の本文。\n`,
  )

const noRm = "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    message: forbidden\n    severity: deny\n"
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, tool_use_id: 't1' })
const failingCheck = {
  rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
  consistency_checks: [{ name: 'chk', run: ['echo broken; exit 1'] }],
}

describe('PreToolUse', () => {
  test('deny: a rule violation is answered with permissionDecision deny', () =>
    withEnv(async (env) => {
      writeRule(env.feedback, 'no_rm', 6, noRm)
      const r = await hook(env, 'PreToolUse', bash('rm -rf x'))
      expect(r.exitCode).toBe(0)
      expect(r.json?.hookSpecificOutput.hookEventName).toBe('PreToolUse')
      expect(r.json?.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(r.json?.hookSpecificOutput.permissionDecisionReason).toContain('no_rm (count: 6): forbidden')
    }))

  test('ask: severity ask is answered with permissionDecision ask', () =>
    withEnv(async (env) => {
      writeRule(env.feedback, 'ask_rm', 4, noRm.replace('severity: deny', 'severity: ask'))
      const r = await hook(env, 'PreToolUse', bash('rm -rf x'))
      expect(r.json?.hookSpecificOutput.permissionDecision).toBe('ask')
      expect(r.json?.hookSpecificOutput.permissionDecisionReason).toContain('ask_rm')
    }))

  test('a clean call, and a tool that is not judged, print nothing (never allow)', () =>
    withEnv(async (env) => {
      writeRule(env.feedback, 'no_rm', 6, noRm)
      for (const payload of [bash('ls'), { tool_name: 'Read', tool_input: { file_path: '/a' } }]) {
        const r = await hook(env, 'PreToolUse', payload)
        expect(r.exitCode).toBe(0)
        expect(r.stdout).toBe('')
      }
    }))

  test('agentLaunchGuard comes from CLAUDE_PLUGIN_OPTION_agentLaunchGuard', () =>
    withEnv(async (env) => {
      const agent = { tool_name: 'Agent', tool_input: { subagent_type: 'code-implementer', prompt: 'do it' }, tool_use_id: 't2' }
      expect((await hook(env, 'PreToolUse', agent)).stdout).toBe('')
      expect((await hook(env, 'PreToolUse', agent, { CLAUDE_PLUGIN_OPTION_agentLaunchGuard: 'false' })).stdout).toBe('')
      const r = await hook(env, 'PreToolUse', agent, { CLAUDE_PLUGIN_OPTION_agentLaunchGuard: 'true' })
      expect(r.json?.hookSpecificOutput.permissionDecision).toBe('ask')
      expect(r.json?.hookSpecificOutput.permissionDecisionReason).toContain('code-implementer に送るプロンプト:\n\ndo it')
    }))
})

describe('PostToolUse', () => {
  const noTodo = "enforce:\n  - event: post_edit\n    path: '**/*.py'\n    when: 'TODO'\n    message: 'TODO を残さない'\n"

  test('block: a post_edit violation is answered with decision block and the reason', () =>
    withEnv(async (env) => {
      writeRule(env.feedback, 'no_todo', 4, noTodo)
      const file = path.join(env.proj, 'x.py')
      fs.writeFileSync(file, 'x = 1  # TODO\n')
      const r = await hook(env, 'PostToolUse', {
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
        tool_response: {},
        tool_use_id: 't1',
      })
      expect(r.exitCode).toBe(0)
      expect(r.json?.decision).toBe('block')
      expect(r.json?.reason).toContain('no_todo')
    }))

  test('additionalContext: the report of a finished subagent is handed to the caller', () =>
    withEnv(async (env) => {
      writeGateYaml(env.proj, failingCheck)
      await hook(env, 'PostToolUse', { agent_id: 'ag1', tool_name: 'Write', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
      const stop = await hook(env, 'SubagentStop', { agent_id: 'ag1', agent_type: 'worker' })
      expect(stop.json?.decision).toBe('block')
      const r = await hook(env, 'PostToolUse', { tool_name: 'Agent', tool_input: { prompt: 'p' }, tool_response: { agentId: 'ag1' }, tool_use_id: 't9' })
      expect(r.json?.hookSpecificOutput.hookEventName).toBe('PostToolUse')
      expect(r.json?.hookSpecificOutput.additionalContext).toContain('ag1')
      expect(r.json?.hookSpecificOutput.additionalContext).toContain('検証に失敗')
      expect(r.json?.decision).toBeUndefined()
    }))
})

describe('UserPromptSubmit', () => {
  test('additionalContext carries the bundled rules and the confirmed feedback', () =>
    withEnv(async (env) => {
      writeRule(env.feedback, 'confirmed', 3)
      writeRule(env.feedback, 'unconfirmed', 1)
      const r = await hook(env, 'UserPromptSubmit', { prompt: 'hi' })
      expect(r.exitCode).toBe(0)
      expect(r.json?.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
      const context: string = r.json?.hookSpecificOutput.additionalContext ?? ''
      const bundled = fs.readFileSync(path.join(REPO_ROOT, 'rules', 'feedback_rules.md'), 'utf8').trim()
      expect(context.startsWith(bundled)).toBe(true)
      expect(context).toContain('■ confirmed (これまで 3 回指摘されています)')
      expect(context).not.toContain('unconfirmed')
    }))

  test('rulesFile comes from CLAUDE_PLUGIN_OPTION_rulesFile', () =>
    withEnv(async (env) => {
      const custom = path.join(env.home, 'custom.md')
      fs.writeFileSync(custom, 'CUSTOM\n')
      const r = await hook(env, 'UserPromptSubmit', { prompt: 'hi' }, { CLAUDE_PLUGIN_OPTION_rulesFile: custom })
      expect(r.json?.hookSpecificOutput.additionalContext).toBe('CUSTOM')
    }))

  test('CLAUDE_PLUGIN_OPTION_language switches the language, and wins over the OS locale', () =>
    withEnv(async (env) => {
      writeRule(env.feedback, 'confirmed', 3)
      const auto = await hook(env, 'UserPromptSubmit', {}, { CLAUDE_PLUGIN_OPTION_language: 'auto' })
      expect(auto.json?.hookSpecificOutput.additionalContext).toContain('■ confirmed (これまで 3 回指摘されています)')
      const en = await hook(env, 'UserPromptSubmit', {}, { CLAUDE_PLUGIN_OPTION_language: 'en' })
      expect(en.json?.hookSpecificOutput.additionalContext).toContain('■ confirmed (pointed out 3 times so far)')
      const ja = await hook(env, 'UserPromptSubmit', {}, { CLAUDE_PLUGIN_OPTION_language: 'ja', LANG: 'en_US.UTF-8' })
      expect(ja.json?.hookSpecificOutput.additionalContext).toContain('■ confirmed (これまで 3 回指摘されています)')
    }))
})

describe('Stop', () => {
  test('block: reserved checks that fail are answered with decision block', () =>
    withEnv(async (env) => {
      writeGateYaml(env.proj, failingCheck)
      await hook(env, 'PostToolUse', { tool_name: 'Write', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
      const r = await hook(env, 'Stop', { stop_hook_active: false })
      expect(r.exitCode).toBe(0)
      expect(r.json?.decision).toBe('block')
      expect(r.json?.reason).toContain('検証に失敗しました（試行')
    }))
})

describe('SessionStart / Notification', () => {
  test('SessionStart startup drops this session state; resume keeps it', () =>
    withEnv(async (env) => {
      writeGateYaml(env.proj, { rules: [] })
      const changed = path.join(env.proj, '.claude', '.gate-status', 'changed_files.sess-1.txt')
      fs.mkdirSync(path.dirname(changed), { recursive: true })
      fs.writeFileSync(changed, 'a.py\n')
      const resume = await hook(env, 'SessionStart', { source: 'resume' })
      expect(resume.exitCode).toBe(0)
      expect(exists(changed)).toBe(true)
      const startup = await hook(env, 'SessionStart', { source: 'startup' })
      expect(startup.exitCode).toBe(0)
      expect(startup.stdout).toBe('')
      expect(exists(changed)).toBe(false)
    }))

  test('an unknown event is a usage error; broken stdin still exits 0', async () => {
    await withEnv(async (env) => {
      expect((await hook(env, 'Bogus', {})).exitCode).toBe(1)
      const proc = Bun.spawn([feedbackGateBin(), 'claude', 'Stop'], {
        cwd: env.proj,
        env: { ...process.env, HOME: env.home, CLAUDE_FEEDBACK_DIR: env.feedback, CLAUDE_PROJECT_DIR: env.proj, CLAUDE_PLUGIN_ROOT: REPO_ROOT },
        stdin: new TextEncoder().encode('not json'),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await proc.exited).toBe(0)
    })
  })
})
