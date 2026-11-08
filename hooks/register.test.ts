// `claude plugin test .` で実行する、実際のエンジンの上でのテスト（バンドル済みの hooks/register.js を読む）。
// 判定は Go 版（internal/hookgate）にあり、そのテストは Go と tests/（実際のバイナリを起動する結合テスト）にある。
// ここでは、mod が classic.* のイベントを $.process.spawn で scripts/hook.sh に渡すこと（argv / env / stdin）、
// Go の出力（stdout の JSON と stderr の画面の更新の行）を classic hook の戻り値と $.ui に戻すこと、/correct と帯の結線だけを、
// process.spawn をモックして確かめる。
import { expect, mock, test } from 'claude-code/testing'

type Files = Record<string, string>
type Spawned = { argv: string[]; cwd?: string; env?: Record<string, string>; input?: string }
// Go の出力: stdout の JSON（無ければ何も返さない）と、stderr の行。
type GoOut = { stdout?: Record<string, unknown>; stderr?: string[] }

const PREFIX = '@@feedback-gate '

// go: イベント名ごとの Go の出力（既定は何も返さない）。fail が真なら spawn は例外を投げる（起動できない・中断）。
const setup = (
  // biome-ignore lint/suspicious/noExplicitAny: エンジンの On 型は Claude Code の外では参照できないため緩く受ける
  on: any,
  go: Record<string, GoOut> = {},
  files: Files = {},
  env: Record<string, string> = {},
  fail = false,
) => {
  const spawned: Spawned[] = []
  const statuses: (string | undefined)[] = []
  const invalidations: string[] = []
  const commands: string[] = []
  mock.env(on, { HOME: '/h', LANG: 'ja_JP.UTF-8', ...env })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.cwd', () => ({ value: '/proj/sub' }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', (_$: unknown, e: { path?: string }) => ({
    value: Object.keys(files)
      .filter((p) => p.startsWith(`${e.path}/`) && !p.slice((e.path ?? '').length + 1).includes('/'))
      .map((p) => ({ name: p.slice((e.path ?? '').length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.stat', (_$: unknown, e: { path: string }) => {
    if (e.path in files) return { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('process.spawn', async function* (_$: unknown, e: Spawned) {
    spawned.push(e)
    if (fail) throw new Error('aborted')
    const event = e.argv.at(-1) ?? ''
    const out = go[event] ?? {}
    for (const line of out.stderr ?? []) yield { stream: 'stderr', text: `${line}\n` }
    if (out.stdout) yield { stream: 'stdout', text: `${JSON.stringify(out.stdout)}\n` }
    return { value: { code: 0, signal: null } }
  })
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop']) on(`classic.${ev}`, () => ({}))
  on('ui.status', (_$: unknown, e: { text: string | undefined }) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', (_$: unknown, e: { event: string }) => {
    invalidations.push(e.event)
    return { value: undefined }
  })
  on('command.register', (_$: unknown, e: { name: string }) => {
    commands.push(e.name)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ran' as never }))
  return { spawned, statuses, invalidations, files, commands }
}

const input = (s: Spawned): Record<string, unknown> => JSON.parse(s.input ?? '{}')

test('UserPromptSubmit: scripts/hook.sh を FEEDBACK_GATE_FROM_MOD 付きで起動し、stdout の context を返す', async ($, on) => {
  const { spawned, files } = setup(on, {
    UserPromptSubmit: { stdout: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'RULES\n\nCONFIRMED' } } },
  })
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r.additionalContext).toEqual(['RULES\n\nCONFIRMED'])
  expect(spawned).toHaveLength(1)
  const [s] = spawned
  expect(s?.argv.slice(0, 1)).toEqual(['bash'])
  expect(s?.argv.slice(1)).toEqual([expect.stringMatching(/\/scripts\/hook\.sh$/), 'UserPromptSubmit'])
  expect(s?.cwd).toBe('/proj/sub')
  expect(s?.env).toMatchObject({ CLAUDE_PROJECT_DIR: '/proj', FEEDBACK_GATE_FROM_MOD: '1', FEEDBACK_GATE_EVENTS: 'stderr' })
  expect(typeof s?.env?.CLAUDE_PLUGIN_ROOT).toBe('string')
  expect(input(s as Spawned)).toMatchObject({ prompt: 'hi', hook_event_name: 'UserPromptSubmit' })
  // settings hook を黙らせるマーカーは書く（scripts/hook.sh が見る）。
  expect(Object.keys(files)).toEqual(['/h/.claude/feedback/.classic_seen/sess-1'])
})

test('プラグイン設定は CLAUDE_PLUGIN_OPTION_<key> で渡す', { options: { language: 'en', autoCount: false, rulesFile: '~/r.md' } }, async ($, on) => {
  const { spawned } = setup(on)
  await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(spawned[0]?.env).toMatchObject({
    CLAUDE_PLUGIN_OPTION_language: 'en',
    CLAUDE_PLUGIN_OPTION_autoCount: 'false',
    CLAUDE_PLUGIN_OPTION_rulesFile: '~/r.md',
  })
})

test('PreToolUse: Go の deny はツール呼び出しを止め、payload は classic の形で渡る', async ($, on) => {
  const { spawned } = setup(on, {
    PreToolUse: {
      stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no_rm (count: 6): forbidden' } },
    },
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('no_rm (count: 6): forbidden')
  expect(input(spawned[0] as Spawned)).toMatchObject({
    session_id: 'sess-1',
    cwd: '/proj/sub',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf x' },
  })
})

// ask は tool.call の結果には現れないため、プラグインの下に置いた classic.PreToolUse の呼び出し回数で
// 「ask を返して後続へ流さなかった」ことを確かめる（ask の無い結果は next へ流れて 1 回呼ばれる）。
// biome-ignore lint/suspicious/noExplicitAny: 同上
const countBeneath = (on: any) => {
  const seen: unknown[] = []
  on('classic.PreToolUse', (_$: unknown, e: unknown) => {
    seen.push(e)
    return {}
  })
  return seen
}

test('PreToolUse: Go が何も返さなければ後続へ流し、対象外のツールでは Go を起動しない', async ($, on) => {
  const { spawned } = setup(on)
  const beneath = countBeneath(on)
  const ok = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ok.isError).toBeUndefined()
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'x', prompt: 'p' })
  expect(spawned.map((s) => input(s).tool_name)).toEqual(['Bash'])
  expect(beneath.length).toBe(3)
})

test('PreToolUse: agentLaunchGuard が true なら Agent も Go に渡し、ask なら後続へ流さない', { options: { agentLaunchGuard: true } }, async ($, on) => {
  const { spawned } = setup(on, {
    PreToolUse: { stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'full text' } } },
  })
  const beneath = countBeneath(on)
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-implementer', prompt: 'p' })
  expect(spawned.map((s) => input(s).tool_name)).toEqual(['Agent'])
  expect(beneath.length).toBe(0)
})

test('PostToolUse: Go の block を返し、matcher 外のツールでは Go を起動しない', async ($, on) => {
  const { spawned } = setup(on, { PostToolUse: { stdout: { decision: 'block', reason: '[gate] fmt failed' } } })
  const r = await $.classic.PostToolUse({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
  expect(r.block).toBe('[gate] fmt failed')
  const other = await $.classic.PostToolUse({ session_id: 'sess-1', tool_name: 'Glob', tool_input: {}, tool_response: {}, tool_use_id: 't2' })
  expect(other.block).toBeUndefined()
  expect(spawned).toHaveLength(1)
})

test('処理中の表示: stderr の画面の更新の行を $.ui.status / $.ui.invalidate に渡し、結果には混ぜない', async ($, on) => {
  const { statuses, invalidations } = setup(on, {
    PostToolUse: {
      stderr: [
        `${PREFIX}{"redraw":true}`,
        `${PREFIX}{"progress":"[feedback-guard] 評価中: x"}`,
        'plain warning',
        `${PREFIX}{"result":"[gate] 完了: ✓ 1 (0.1s)"}`,
        `${PREFIX}{"progress":""}`,
      ],
      stdout: { decision: 'block', reason: 'r' },
    },
  })
  const r = await $.classic.PostToolUse({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
  expect(r.block).toBe('r')
  expect(statuses).toEqual(['[feedback-guard] 評価中: x', '[gate] 完了: ✓ 1 (0.1s)', undefined])
  expect(invalidations).toEqual(['ui.render'])
})

test('Stop / SubagentStop: Go の block と systemMessage を返す', async ($, on) => {
  setup(on, {
    Stop: { stdout: { decision: 'block', reason: 'checks failed', systemMessage: 'see log' } },
    SubagentStop: { stdout: { decision: 'block', reason: 'stop_check' } },
  })
  const r = await $.classic.Stop({ stop_hook_active: false })
  expect(r.block).toBe('checks failed')
  expect(r.systemMessage).toBe('see log')
  const s = await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'a1' })
  expect(s.block).toBe('stop_check')
})

test('Notification / SessionStart: Go を起動し、結果は後続へ流す', async ($, on) => {
  const { spawned } = setup(on, { SessionStart: { stdout: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'S' } } } })
  const n = await $.classic.Notification({ message: 'm', notification_type: 'idle_prompt' })
  expect(n.block).toBeUndefined()
  const s = await $.classic.SessionStart({ source: 'startup' })
  expect(s.additionalContext).toEqual(['S'])
  expect(spawned.map((x) => x.argv.at(-1))).toEqual(['Notification', 'SessionStart'])
})

test('Go を起動できない・中断されたときは何も返さず後続へ流す', async ($, on) => {
  setup(on, {}, {}, {}, true)
  const beneath = countBeneath(on)
  const r = await $.classic.Stop({ stop_hook_active: false })
  expect(r.block).toBeUndefined()
  const t = await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })
  expect(t.isError).toBeUndefined()
  expect(beneath.length).toBe(1)
})

const BAND = { surface: 'terminal', component: 'AbovePrompt', requestId: 'r1', props: { hasSurvey: false, isWorking: false } } as const

// biome-ignore lint/suspicious/noExplicitAny: エンジンの On 型は Claude Code の外では参照できないため緩く受ける
const beneathBand = (on: any) => {
  const engineBand = { type: 'Text', children: ['engine band'] }
  on('ui.render', { component: 'AbovePrompt' }, () => engineBand)
  return engineBand
}

test('ui.render AbovePrompt: Go が書いた実行中の一覧を、自セッションの分だけ複数行の木にする', async ($, on) => {
  const started = 1_700_000_000_000 - 3000
  setup(
    on,
    {},
    {
      '/proj/.claude': '',
      '/proj/.claude/.gate-status/running/sess-1.a1.json': JSON.stringify([
        { name: 'typecheck', cmd: 'bun run typecheck', started, result: 'ok', ended: started + 700 },
        { name: 'test', cmd: 'bun run test', started },
      ]),
      '/proj/.claude/.gate-status/running/sess-9.b1.json': JSON.stringify([{ name: 'other', cmd: 'pnpm test', started }]),
    },
  )
  beneathBand(on)
  const tree = await $.ui.render(BAND)
  expect(tree).toEqual({
    type: 'Box',
    props: { flexDirection: 'column' },
    children: ['[gate] 実行中:', '  typecheck ✓ (0.7s)', '  test $ bun run test (3s)'].map((line) => ({ type: 'Text', children: [line] })),
  })
})

test('ui.render AbovePrompt: 全部終わっているか何も無ければエンジンの帯に戻り、アンケート中は譲る', async ($, on) => {
  const started = 1_700_000_000_000 - 3000
  const files: Files = { '/proj/.claude': '' }
  setup(on, {}, files)
  const engineBand = beneathBand(on)
  expect(await $.ui.render(BAND)).toEqual(engineBand)
  files['/proj/.claude/.gate-status/running/sess-1.a1.json'] = JSON.stringify([{ name: 'lint', cmd: 'x', started, result: 'ok', ended: started + 100 }])
  expect(await $.ui.render(BAND)).toEqual(engineBand)
  files['/proj/.claude/.gate-status/running/sess-1.a1.json'] = JSON.stringify([{ name: 'test', cmd: 'x', started }])
  expect(await $.ui.render({ ...BAND, props: { hasSurvey: true, isWorking: false } })).toEqual(engineBand)
})
