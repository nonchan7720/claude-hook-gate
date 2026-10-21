// Codex プラグインの CLI（Go 製の feedback-gate バイナリ、cmd/feedback-gate）: `feedback-gate codex <Event>` を子プロセスで起動し、Codex の command hook の規約
// （stdin の JSON → stdout の JSON / stderr / 終了コード）と、環境変数で受けるプラグイン設定を確かめる。
import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { writeGateYaml } from './helpers/gate.ts'
import { feedbackGateBin } from './helpers/go-binary.ts'
import { MISSING_DOGWOOD_BIN, REPO_ROOT, rmTree, tmpDir } from './helpers/node-io.ts'

type Out = Record<string, unknown>
type Json = {
  decision?: string
  reason?: string
  systemMessage?: string
  hookSpecificOutput?: { hookEventName: string; permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }
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

const { CLAUDE_PROJECT_DIR: _cpd, ...base } = process.env as Record<string, string>

// Codex プラグインのルートはリポジトリのルート（hook.sh が PLUGIN_ROOT を CLAUDE_PLUGIN_ROOT として feedback-gate に渡す）。
const PLUGIN_ROOT = REPO_ROOT

/** CLI を子プロセスで走らせる。Codex はプロジェクトの環境変数（CLAUDE_PROJECT_DIR など）を渡さないので、cwd は payload から取らせる。 */
async function hook(env: Env, event: string, payload: Out, extra: Record<string, string> = {}): Promise<Result> {
  // Codex は CLAUDE_PROJECT_DIR を渡さない（projectDir は payload の cwd から決まる）ので、親から漏れたものも落とす。
  const { LANG: _l, LC_ALL: _a, LC_MESSAGES: _m, FEEDBACK_GATE_LANG: _f, CLAUDE_AGENT_ID: _g, ...clean } = base
  const proc = Bun.spawn([feedbackGateBin(), 'codex', event], {
    cwd: env.proj,
    env: {
      ...clean,
      HOME: env.home,
      LANG: 'ja_JP.UTF-8',
      CLAUDE_FEEDBACK_DIR: env.feedback,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      DOGWOOD_BIN: MISSING_DOGWOOD_BIN,
      ...extra,
    },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'thr_1', cwd: env.proj, hook_event_name: event, model: 'gpt-5', ...payload })),
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
const noTodoPre = "enforce:\n  - event: pre_edit\n    path: '**/*.py'\n    when: 'TODO'\n    message: 'TODO を書かない'\n    severity: ask\n"
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, tool_use_id: 't1' })
const applyPatch = (body: string[]) => ({
  tool_name: 'apply_patch',
  tool_input: { command: ['*** Begin Patch', ...body, '*** End Patch'].join('\n') },
  tool_use_id: 't1',
})
const failingCheck = {
  rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
  consistency_checks: [{ name: 'chk', run: ['echo broken; exit 1'] }],
}

describe('PreToolUse', () => {
  test('deny: a pre_bash violation is answered with permissionDecision deny', () =>
    withEnv(async (env) => {
      writeRule(env.feedback, 'no_rm', 6, noRm)
      const r = await hook(env, 'PreToolUse', bash('rm -rf x'))
      expect(r.exitCode).toBe(0)
      expect(r.json?.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
      expect(r.json?.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(r.json?.hookSpecificOutput?.permissionDecisionReason).toContain('no_rm (count: 6): forbidden')
    }))

  test('apply_patch: an ask on a file in the patch becomes deny with the Codex note; the retry is a warn in additionalContext', () =>
    withEnv(async (env) => {
      writeRule(env.feedback, 'no_todo', 4, noTodoPre)
      const first = await hook(env, 'PreToolUse', applyPatch(['*** Add File: a.py', '+# TODO']))
      expect(first.json?.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(first.json?.hookSpecificOutput?.permissionDecisionReason).toContain('no_todo (count: 4): TODO を書かない')
      expect(first.json?.hookSpecificOutput?.permissionDecisionReason).toContain('Codex の PreToolUse には ask が無い')
      const again = await hook(env, 'PreToolUse', applyPatch(['*** Add File: a.py', '+# TODO']))
      expect(again.json?.hookSpecificOutput?.permissionDecision).toBeUndefined()
      expect(again.json?.hookSpecificOutput?.additionalContext).toContain('[feedback-guard] warn: no_todo')
    }))

  test('a clean call, and a tool that is not judged, print nothing', () =>
    withEnv(async (env) => {
      writeRule(env.feedback, 'no_rm', 6, noRm)
      for (const payload of [bash('ls'), applyPatch(['*** Delete File: a.py']), { tool_name: 'update_plan', tool_input: { plan: [] } }]) {
        const r = await hook(env, 'PreToolUse', payload)
        expect(r.exitCode).toBe(0)
        expect(r.stdout).toBe('')
      }
    }))

  test('agentLaunchGuard comes from FEEDBACK_GATE_AGENT_LAUNCH_GUARD and applies to spawn_agent', () =>
    withEnv(async (env) => {
      const agent = { tool_name: 'spawn_agent', tool_input: { agent_type: 'code-implementer', message: 'do it' }, tool_use_id: 't2' }
      expect((await hook(env, 'PreToolUse', agent)).stdout).toBe('')
      const r = await hook(env, 'PreToolUse', agent, { FEEDBACK_GATE_AGENT_LAUNCH_GUARD: 'true' })
      expect(r.json?.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(r.json?.hookSpecificOutput?.permissionDecisionReason).toContain('code-implementer に送るプロンプト:\n\ndo it')
    }))

  test('FEEDBACK_GATE_ASK_AGENT_TYPES / FEEDBACK_GATE_ALLOW_RECIPIENTS replace the lists for spawn_agent / send_input', () =>
    withEnv(async (env) => {
      const on = { FEEDBACK_GATE_AGENT_LAUNCH_GUARD: 'true', FEEDBACK_GATE_ASK_AGENT_TYPES: 'worker', FEEDBACK_GATE_ALLOW_RECIPIENTS: 'ops' }
      const spawn = (type: string) => ({ tool_name: 'spawn_agent', tool_input: { agent_type: type, message: 'do it' }, tool_use_id: 't3' })
      const send = (id: string) => ({ tool_name: 'send_input', tool_input: { agent_id: id, message: 'hi' }, tool_use_id: 't4' })
      expect((await hook(env, 'PreToolUse', spawn('worker'), on)).json?.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect((await hook(env, 'PreToolUse', spawn('code-implementer'), on)).stdout).toBe('')
      expect((await hook(env, 'PreToolUse', send('ops'), on)).stdout).toBe('')
      expect((await hook(env, 'PreToolUse', send('git-operator'), on)).json?.hookSpecificOutput?.permissionDecision).toBe('deny')
    }))
})

describe('PostToolUse', () => {
  const noTodo = "enforce:\n  - event: post_edit\n    path: '**/*.py'\n    when: 'TODO'\n    message: 'TODO を残さない'\n"

  test('block: a post_edit violation on a patched file is answered with decision block', () =>
    withEnv(async (env) => {
      writeRule(env.feedback, 'no_todo', 4, noTodo)
      fs.writeFileSync(path.join(env.proj, 'x.py'), 'x = 1  # TODO\n')
      const r = await hook(env, 'PostToolUse', { ...applyPatch(['*** Update File: x.py', '+x = 1  # TODO']), tool_response: 'Done' })
      expect(r.exitCode).toBe(0)
      expect(r.json?.decision).toBe('block')
      expect(r.json?.reason).toContain('no_todo')
    }))

  test('the files of a patch are recorded and the matching gate rules run, without CLAUDE_PROJECT_DIR', () =>
    withEnv(async (env) => {
      writeGateYaml(env.proj, { rules: [{ match: '**/*.py', run: ['echo ran >> ran.txt'] }] })
      fs.mkdirSync(path.join(env.proj, 'src'))
      fs.writeFileSync(path.join(env.proj, 'src', 'a.py'), 'x = 1\n')
      const r = await hook(env, 'PostToolUse', { ...applyPatch(['*** Add File: src/a.py', '+x = 1']), tool_response: 'Done' })
      expect(r.exitCode).toBe(0)
      expect(fs.readFileSync(path.join(env.proj, 'ran.txt'), 'utf8')).toBe('ran\n')
    }))
})

describe('UserPromptSubmit', () => {
  test('additionalContext carries the bundled rules of the plugin and the confirmed feedback', () =>
    withEnv(async (env) => {
      writeRule(env.feedback, 'confirmed', 3)
      const r = await hook(env, 'UserPromptSubmit', { prompt: 'hi' })
      expect(r.exitCode).toBe(0)
      const context: string = r.json?.hookSpecificOutput?.additionalContext ?? ''
      const bundled = fs.readFileSync(path.join(PLUGIN_ROOT, 'rules', 'feedback_rules.md'), 'utf8').trim()
      expect(context.startsWith(bundled)).toBe(true)
      expect(context).toContain('■ confirmed (これまで 3 回指摘されています)')
    }))

  test('rulesFile comes from FEEDBACK_GATE_RULES_FILE; FEEDBACK_GATE_LANG switches the language', () =>
    withEnv(async (env) => {
      const custom = path.join(env.home, 'custom.md')
      fs.writeFileSync(custom, 'CUSTOM\n')
      expect((await hook(env, 'UserPromptSubmit', { prompt: 'hi' }, { FEEDBACK_GATE_RULES_FILE: custom })).json?.hookSpecificOutput?.additionalContext).toBe(
        'CUSTOM',
      )
      writeRule(env.feedback, 'confirmed', 3)
      const en = await hook(env, 'UserPromptSubmit', {}, { FEEDBACK_GATE_LANG: 'en' })
      expect(en.json?.hookSpecificOutput?.additionalContext).toContain('■ confirmed (pointed out 3 times so far)')
    }))
})

describe('Stop / SubagentStop', () => {
  test('block: reserved checks that fail are answered with decision block', () =>
    withEnv(async (env) => {
      writeGateYaml(env.proj, failingCheck)
      await hook(env, 'PostToolUse', { ...applyPatch(['*** Add File: x.py', '+x = 1']), tool_response: 'Done' })
      const r = await hook(env, 'Stop', { stop_hook_active: false, last_assistant_message: 'done' })
      expect(r.exitCode).toBe(0)
      expect(r.json?.decision).toBe('block')
      expect(r.json?.reason).toContain('検証に失敗しました（試行')
    }))

  test('the report of a finished subagent is handed to the caller through spawn_agent', () =>
    withEnv(async (env) => {
      writeGateYaml(env.proj, failingCheck)
      await hook(env, 'PostToolUse', { agent_id: 'ag1', ...applyPatch(['*** Add File: x.py', '+x = 1']), tool_response: 'Done' })
      const stop = await hook(env, 'SubagentStop', { agent_id: 'ag1', agent_type: 'worker', stop_hook_active: false })
      expect(stop.json?.decision).toBe('block')
      const r = await hook(env, 'PostToolUse', {
        tool_name: 'spawn_agent',
        tool_input: { message: 'p' },
        tool_response: { agent_id: 'ag1' },
        tool_use_id: 't9',
      })
      expect(r.json?.hookSpecificOutput?.additionalContext).toContain('ag1')
      expect(r.json?.hookSpecificOutput?.additionalContext).toContain('検証に失敗')
    }))
})

describe('SessionStart / PermissionRequest', () => {
  test('SessionStart startup drops this session state and prints nothing', () =>
    withEnv(async (env) => {
      writeGateYaml(env.proj, { rules: [] })
      const changed = path.join(env.proj, '.claude', '.gate-status', 'changed_files.thr_1.txt')
      fs.mkdirSync(path.dirname(changed), { recursive: true })
      fs.writeFileSync(changed, 'a.py\n')
      const r = await hook(env, 'SessionStart', { source: 'startup' })
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toBe('')
      expect(fs.existsSync(changed)).toBe(false)
    }))

  test('PermissionRequest prints nothing; an unknown event is a usage error; broken stdin still exits 0', async () => {
    await withEnv(async (env) => {
      const r = await hook(env, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } })
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toBe('')
      expect((await hook(env, 'Notification', {})).exitCode).toBe(1)
      const proc = Bun.spawn([feedbackGateBin(), 'codex', 'Stop'], {
        cwd: env.proj,
        env: { ...base, HOME: env.home, CLAUDE_FEEDBACK_DIR: env.feedback, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
        stdin: new TextEncoder().encode('not json'),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await proc.exited).toBe(0)
    })
  })
})

describe('plugins/codex layout', () => {
  test('hooks.json wires every Codex event to scripts/hook.sh under PLUGIN_ROOT, and the manifests at the repository root point at it', () => {
    const dir = path.join(REPO_ROOT, 'plugins', 'codex')
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      'PermissionRequest',
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'SubagentStop',
      'UserPromptSubmit',
    ])
    for (const [event, groups] of Object.entries(hooks.hooks)) {
      for (const g of groups) for (const h of g.hooks) expect(h.command).toBe(`bash "\${PLUGIN_ROOT}/plugins/codex/scripts/hook.sh" ${event}`)
    }
    for (const rel of ['scripts/hook.sh', 'README.md', 'README_ja.md']) expect(fs.existsSync(path.join(dir, rel))).toBe(true)
    // 静的ファイル（rules/、scripts/dogwood/）を二重に持たないよう、Codex のプラグインのルートはリポジトリのルート。
    const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
    const compat = read('.codex-plugin/plugin.json') as { name: string; version: string; hooks: string }
    const portable = read('plugin.json') as { name: string; version: string; extensions: { 'com.openai': { hooks: string } } }
    const claude = read('.claude-plugin/plugin.json') as { version: string }
    const marketplace = read('.agents/plugins/marketplace.json') as { name: string; plugins: Array<{ name: string; source: { path: string } }> }
    expect(compat).toMatchObject({ name: 'feedback-gate', version: claude.version, hooks: './plugins/codex/hooks/hooks.json' })
    expect(portable).toMatchObject({
      name: 'feedback-gate',
      version: claude.version,
      extensions: { 'com.openai': { hooks: './plugins/codex/hooks/hooks.json' } },
    })
    expect(marketplace.name).toBe('hook-gate')
    expect(marketplace.plugins[0]).toMatchObject({ name: 'feedback-gate', source: { path: './' } })
    expect(fs.existsSync(path.join(REPO_ROOT, 'plugins', 'codex', 'rules'))).toBe(false)
  })
})
