import { test, expect, mock } from 'claude-code/testing'

type Call = { argv: readonly string[]; init?: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } }
type Ran = { exitCode?: number; stdout?: string; stderr?: string }

// スクリプトはプラグイン同梱（${$.plugin.root}/scripts/）。root の実値はテスト環境依存なので、
// process.run の argv では `<root>/scripts/` を HOOKS に正規化して扱う。
const HOOKS = 'SCRIPTS'
const normalize = (argv: readonly string[]) => argv.map(a => a.replace(/^.*\/scripts\//, `${HOOKS}/`))

// 'process.run' の下に置くダミー。argv を連結した文字列で結果を引く。
const setup = (on: any, results: Record<string, Ran> = {}, files: Record<string, string> = {}, exists: boolean | ((path: string) => boolean) = true) => {
  const calls: Call[] = []
  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: typeof exists === 'function' ? exists(e.path) : exists }))
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop']) {
    on(`classic.${ev}`, () => ({}))
  }
  on('tool.call', () => ({ result: 'ran' as never }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? '' }))
  on('process.run', (_$: unknown, e: Call) => {
    calls.push({ ...e, argv: normalize(e.argv) })
    const r = results[normalize(e.argv).join(' ')] ?? {}
    return {
      value: {
        exitCode: r.exitCode ?? 0,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  return calls
}

test('SessionStart: reset-gate.sh を呼び、テキスト出力を additionalContext にする', async ($, on) => {
  const calls = setup(on, { [`bash ${HOOKS}/reset-gate.sh`]: { stdout: 'reset done\n' } })
  const r = await $.classic.SessionStart({ source: 'startup' })
  expect(calls.length).toBe(1)
  expect(calls[0]!.argv).toEqual(['bash', `${HOOKS}/reset-gate.sh`])
  expect(calls[0]!.init?.env?.CLAUDE_PROJECT_DIR).toBe('/proj')
  expect(JSON.parse(calls[0]!.init!.stdin!).session_id).toBeDefined()
  expect(r.additionalContext).toEqual(['reset done'])
})

const INJECT = { [`python3 ${HOOKS}/feedback-inject.py`]: { stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'inj' } }) } }
const BUNDLED_PATH = /\/rules\/feedback_rules\.md$/
const BUNDLED_TEXT = 'BUNDLED'
// files に無いパスは存在しない扱い。同梱の rules/ と scripts/ は常に存在する。
const existsIn = (files: Record<string, string>) => (path: string) => path in files || BUNDLED_PATH.test(path) || /\/scripts\//.test(path)
const withBundled = (files: Record<string, string>) => {
  const all: Record<string, string> = { ...files }
  return new Proxy(all, { get: (t, k: string) => (BUNDLED_PATH.test(k) ? BUNDLED_TEXT : t[k]) })
}

test('UserPromptSubmit: rulesFile のファイルがあればその内容だけが入る', async ($, on) => {
  const files = { '/h/.claude/feedback-gate/feedback_rules.md': 'CUSTOM' }
  setup(on, INJECT, withBundled(files), existsIn(files))
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r.additionalContext).toEqual(['CUSTOM', 'inj'])
})

test('UserPromptSubmit: rulesFile のファイルが無ければ同梱版の内容が入る', async ($, on) => {
  setup(on, INJECT, withBundled({}), existsIn({}))
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r.additionalContext).toEqual([BUNDLED_TEXT, 'inj'])
})

test('UserPromptSubmit: ~/.claude/rules/feedback_rules.md は読まない', async ($, on) => {
  const files = { '/h/.claude/rules/feedback_rules.md': 'LEGACY' }
  setup(on, INJECT, withBundled(files), existsIn(files))
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r.additionalContext).toEqual([BUNDLED_TEXT, 'inj'])
})

test('UserPromptSubmit: rulesFile を別パスに設定したらそこを読む', { options: { rulesFile: '~/custom/rules.md' } }, async ($, on) => {
  const files = { '/h/custom/rules.md': 'ELSEWHERE', '/h/.claude/feedback-gate/feedback_rules.md': 'DEFAULT' }
  setup(on, INJECT, withBundled(files), existsIn(files))
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r.additionalContext).toEqual(['ELSEWHERE', 'inj'])
})

test('UserPromptSubmit: feedback-inject.py の block を返す', async ($, on) => {
  setup(on, { [`python3 ${HOOKS}/feedback-inject.py`]: { stdout: JSON.stringify({ decision: 'block', reason: 'no' }) } })
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r.block).toBe('no')
})

test('存在しないスクリプトは実行しない', async ($, on) => {
  const calls = setup(on, {}, {}, false)
  const r = await $.classic.SessionStart({ source: 'startup' })
  expect(calls.length).toBe(0)
  expect(r.additionalContext).toBeUndefined()
})

test('PreToolUse: exit 2 は deny、stdin は classic の形に組み立てられる', async ($, on) => {
  const calls = setup(on, { [`python3 ${HOOKS}/feedback-guard.py`]: { exitCode: 2, stderr: 'forbidden' } })
  const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('forbidden')
  const stdin = JSON.parse(calls[0]!.init!.stdin!)
  expect(stdin.hook_event_name).toBe('PreToolUse')
  expect(stdin.tool_name).toBe('Bash')
  expect(stdin.tool_input).toEqual({ command: 'rm -rf x' })
  expect(stdin.tool_use_id).toBeDefined()
  expect(stdin.tool_use_id).not.toBe('')
})

test('PreToolUse: permissionDecision deny、exit 1 は無視、対象外ツールは実行しない', async ($, on) => {
  const calls = setup(on, {
    [`python3 ${HOOKS}/feedback-guard.py`]: {
      stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'why' } }),
    },
  })
  const denied = await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })
  expect(denied.text).toContain('why')
  const before = calls.length
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  expect(calls.length).toBe(before)
})

test('PreToolUse: exit 1 は無視して通す', async ($, on) => {
  setup(on, { [`python3 ${HOOKS}/feedback-guard.py`]: { exitCode: 1, stderr: 'boom' } })
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.isError).toBeUndefined()
  expect(r.deny).toBeUndefined()
})

test('PostToolUse: record-changes.sh → stop-test-gate.sh rules の順で呼び、block は stderr', async ($, on) => {
  const calls = setup(on, { [`bash ${HOOKS}/stop-test-gate.sh rules`]: { exitCode: 2, stderr: 'lint failed' } })
  const r = await $.classic.PostToolUse({
    tool_name: 'Edit',
    tool_input: { file_path: '/a' },
    tool_response: {},
    tool_use_id: 't1',
  })
  expect(calls.map(c => c.argv.slice(1).join(' '))).toEqual([`${HOOKS}/record-changes.sh`, `${HOOKS}/stop-test-gate.sh rules`])
  expect(calls[1]!.init?.timeoutMs).toBe(600000)
  expect(r.block).toBe('lint failed')
})

test('PostToolUse: 対象外ツールは何も実行しない', async ($, on) => {
  const calls = setup(on)
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 't1' })
  expect(calls.length).toBe(0)
})

test('Notification: notify を呼び、結果は使わない', async ($, on) => {
  const calls = setup(on, { [`bash ${HOOKS}/notification.sh notify`]: { exitCode: 2, stderr: 'x', stdout: '{"decision":"block","reason":"x"}' } })
  const r = await $.classic.Notification({ message: 'm', notification_type: 'idle_prompt' })
  expect(calls.length).toBe(1)
  expect(r.block).toBeUndefined()
})

test('Stop: continue:false と block を返す', async ($, on) => {
  const calls = setup(on, {
    [`bash ${HOOKS}/all-stop.sh`]: { stdout: JSON.stringify({ continue: false, stopReason: 'stop it', decision: 'block', reason: 'r' }) },
  })
  const r = await $.classic.Stop({ stop_hook_active: false })
  expect(calls[0]!.init?.timeoutMs).toBe(600000)
  expect(r.preventContinuation).toBe(true)
  expect(r.stopReason).toBe('stop it')
  expect(r.block).toBe('r')
})

test('SubagentStop: checks → feedback-stop-check の順、最初の block を優先、context は連結', async ($, on) => {
  const calls = setup(on, {
    [`bash ${HOOKS}/stop-test-gate.sh checks`]: { exitCode: 2, stderr: 'first' },
    [`python3 ${HOOKS}/feedback-stop-check.py`]: {
      stdout: JSON.stringify({ decision: 'block', reason: 'second', hookSpecificOutput: { additionalContext: 'ctx' } }),
    },
  })
  const r = await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'a', agent_transcript_path: '', agent_type: 't' } as never)
  expect(calls.length).toBe(2)
  expect(r.block).toBe('first')
  expect(r.additionalContext).toEqual(['ctx'])
})

const askJson = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm' } })

// ask は tool.call の結果には現れないため、プラグインの下に置いた classic.PreToolUse の呼び出し回数で
// 「ask を返して後続へ流さなかった」ことを確かめる（ask の無い結果は next へ流れて 1 回呼ばれる）。
const countBeneath = (on: any) => {
  const seen: unknown[] = []
  on('classic.PreToolUse', (_$: unknown, e: unknown) => {
    seen.push(e)
    return {}
  })
  return seen
}

test('PreToolUse: agentLaunchGuard が false なら Agent / SendMessage で agent-launch-guard.sh を呼ばない', async ($, on) => {
  const calls = setup(on, { [`bash ${HOOKS}/agent-launch-guard.sh`]: { stdout: askJson } })
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-implementer', prompt: 'p' })
  await $.tool.call({ tool: 'SendMessage', to: 'x', message: 'm' })
  expect(calls.length).toBe(0)
})

test(
  'PreToolUse: agentLaunchGuard が true なら Agent / SendMessage で agent-launch-guard.sh を呼び ask を返す',
  { options: { agentLaunchGuard: true } },
  async ($, on) => {
    const calls = setup(on, { [`bash ${HOOKS}/agent-launch-guard.sh`]: { stdout: askJson } })
    const beneath = countBeneath(on)
    await $.tool.call({ tool: 'Agent', subagent_type: 'code-implementer', prompt: 'p' })
    await $.tool.call({ tool: 'SendMessage', to: 'x', message: 'm' })
    expect(calls.map(c => c.argv.join(' '))).toEqual([`bash ${HOOKS}/agent-launch-guard.sh`, `bash ${HOOKS}/agent-launch-guard.sh`])
    const stdin = JSON.parse(calls[0]!.init!.stdin!)
    expect(stdin.hook_event_name).toBe('PreToolUse')
    expect(stdin.tool_name).toBe('Agent')
    expect(stdin.tool_input).toEqual({ subagent_type: 'code-implementer', prompt: 'p' })
    expect(beneath.length).toBe(0)
  },
)

test(
  'PreToolUse: agentLaunchGuard が true でも agent-launch-guard.sh が何も返さなければ後続へ流す',
  { options: { agentLaunchGuard: true } },
  async ($, on) => {
    setup(on)
    const beneath = countBeneath(on)
    await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', prompt: 'p' })
    expect(beneath.length).toBe(1)
  },
)

test('PreToolUse: agentLaunchGuard が true でも Bash は feedback-guard.py だけを呼ぶ', { options: { agentLaunchGuard: true } }, async ($, on) => {
  const calls = setup(on)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(calls.map(c => c.argv.join(' '))).toEqual([`python3 ${HOOKS}/feedback-guard.py`])
})
