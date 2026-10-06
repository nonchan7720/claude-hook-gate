// `claude plugin test .` で実行する、実際のエンジンの上でのテスト（バンドル済みの hooks/register.js を読む）。
// ロジック本体のテストは tests/（bun test）にある。ここではエンジン API（$.fs / $.process / $.env / $.session）への
// 結線と、classic hook の戻り値への変換だけを、メモリ上のファイルシステムで確かめる。
import { expect, mock, test } from 'claude-code/testing'

type Files = Record<string, string>

const BUNDLED = /\/rules\/feedback_rules\.md$/

// 同梱の rules/ は常に存在し、その内容は BUNDLED_TEXT として読めることにする。
type Run = { exitCode: number; stdout: string }

// run: process.run の応答（argv ごと）。既定はすべて成功。
// biome-ignore lint/suspicious/noExplicitAny: エンジンの On 型は Claude Code の外では参照できないため緩く受ける
const setup = (on: any, files: Files = {}, env: Record<string, string> = {}, run: (argv: string[]) => Run = () => ({ exitCode: 0, stdout: '' })) => {
  const dirs = new Set<string>(['/proj'])
  for (const f of Object.keys(files)) for (let d = f.slice(0, f.lastIndexOf('/')); d.length > 0; d = d.slice(0, d.lastIndexOf('/'))) dirs.add(d)
  const runs: string[][] = []
  mock.env(on, { HOME: '/h', ...env })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in files || dirs.has(e.path) || BUNDLED.test(e.path) }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: BUNDLED.test(e.path) ? 'BUNDLED' : (files[e.path] ?? '') }))
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
    if (dirs.has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    const r = run(e.argv)
    return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop']) on(`classic.${ev}`, () => ({}))
  on('tool.call', () => ({ result: 'ran' as never }))
  return { runs, files }
}

const rule = (name: string, count: number, enforce: string) => `---\nname: ${name}\ndescription: d\ntype: feedback\ncount: ${count}\n${enforce}---\n\nbody\n`

test('UserPromptSubmit: rulesFile のファイルがあればその内容だけが入る', async ($, on) => {
  setup(on, { '/h/.claude/feedback-gate/feedback_rules.md': 'CUSTOM' })
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r.additionalContext).toEqual(['CUSTOM'])
})

test('UserPromptSubmit: rulesFile のファイルが無ければ同梱版の内容が入る', async ($, on) => {
  setup(on)
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r.additionalContext).toEqual(['BUNDLED'])
})

test('UserPromptSubmit: ~/.claude/rules/feedback_rules.md は読まない', async ($, on) => {
  setup(on, { '/h/.claude/rules/feedback_rules.md': 'LEGACY' })
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r.additionalContext).toEqual(['BUNDLED'])
})

test('UserPromptSubmit: rulesFile を別パスに設定したらそこを読む', { options: { rulesFile: '~/custom/rules.md' } }, async ($, on) => {
  setup(on, { '/h/custom/rules.md': 'ELSEWHERE', '/h/.claude/feedback-gate/feedback_rules.md': 'DEFAULT' })
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r.additionalContext).toEqual(['ELSEWHERE'])
})

test('UserPromptSubmit: count >= 3 の feedback ルールが追記される', async ($, on) => {
  setup(on, { '/h/.claude/feedback/confirmed.md': rule('confirmed', 3, ''), '/h/.claude/feedback/low.md': rule('low', 1, '') })
  const r = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r.additionalContext?.[0]).toBe('BUNDLED')
  expect(r.additionalContext?.[1]).toContain('■ confirmed (これまで 3 回指摘されています)')
  expect(r.additionalContext?.[1]).not.toContain('low')
})

test('PreToolUse: ルール違反の Bash は deny、stdin 相当の組み立ても通る', async ($, on) => {
  setup(on, {
    '/h/.claude/feedback/no_rm.md': rule('no_rm', 6, "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    message: forbidden\n    severity: deny\n"),
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('no_rm (count: 6): forbidden')
})

test('PreToolUse: 違反が無ければ通し、対象外ツールは何も実行しない', async ($, on) => {
  const { runs } = setup(on, {
    '/h/.claude/feedback/no_rm.md': rule('no_rm', 6, "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    message: forbidden\n    severity: deny\n"),
  })
  const ok = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(ok.isError).toBeUndefined()
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  expect(runs).toEqual([])
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

test('PreToolUse: agentLaunchGuard が false なら Agent / SendMessage を確認しない', async ($, on) => {
  setup(on)
  const beneath = countBeneath(on)
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-implementer', prompt: 'p' })
  await $.tool.call({ tool: 'SendMessage', to: 'x', message: 'm' })
  expect(beneath.length).toBe(2)
})

test('PreToolUse: agentLaunchGuard が true なら ask を返して後続へ流さない', { options: { agentLaunchGuard: true } }, async ($, on) => {
  setup(on)
  const beneath = countBeneath(on)
  await $.tool.call({ tool: 'Agent', subagent_type: 'code-implementer', prompt: 'p' })
  await $.tool.call({ tool: 'SendMessage', to: 'x', message: 'm' })
  expect(beneath.length).toBe(0)
})

test('PreToolUse: agentLaunchGuard が true でも対象外の宛先は後続へ流す', { options: { agentLaunchGuard: true } }, async ($, on) => {
  setup(on)
  const beneath = countBeneath(on)
  await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', prompt: 'p' })
  await $.tool.call({ tool: 'SendMessage', to: 'git-operator', message: 'm' })
  expect(beneath.length).toBe(2)
})

test('PostToolUse: gate.yaml が無ければ何も記録せず、対象外ツールは何もしない', async ($, on) => {
  const { files, runs } = setup(on)
  const r = await $.classic.PostToolUse({ tool_name: 'Edit', tool_input: { file_path: '/a' }, tool_response: {}, tool_use_id: 't1' })
  expect(r.block).toBeUndefined()
  await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 't1' })
  expect(Object.keys(files)).toEqual([])
  expect(runs).toEqual([])
})

test('PostToolUse: 変更ファイルを記録し、rules フェーズの失敗は block になる', async ($, on) => {
  const files: Files = { '/proj/.claude/gate.yaml': JSON.stringify({ rules: [{ match: '**/*.py', run: ['echo lint failed; exit 1'] }] }) }
  const { runs } = setup(on, files, {}, (argv) => (argv[0] === 'sh' ? { exitCode: 1, stdout: 'lint failed\n' } : { exitCode: 0, stdout: '' }))
  const r = await $.classic.PostToolUse({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
  expect(files['/proj/.claude/.gate-status/changed_files.sess-1.txt']).toBe('x.py\n')
  expect(runs.some((a) => a[0] === 'sh')).toBe(true)
  expect(r.block).toContain('lint failed')
})

test('Notification: 結果は使わず後続へ流す', async ($, on) => {
  setup(on)
  const r = await $.classic.Notification({ message: 'm', notification_type: 'idle_prompt' })
  expect(r.block).toBeUndefined()
})

test('Stop: gate.yaml が無ければ何も止めない', async ($, on) => {
  setup(on)
  const r = await $.classic.Stop({ stop_hook_active: false })
  expect(r.block).toBeUndefined()
  expect(r.preventContinuation).toBeUndefined()
})

test('SubagentStop: gate.yaml が無くても feedback ルールの stop_check が評価される', async ($, on) => {
  setup(
    on,
    {
      '/h/.claude/feedback/chk.md': rule(
        'chk',
        4,
        "enforce:\n  - event: stop_check\n    changed: '**/*.py'\n    check: 'exit 1'\n    message: bad\n    severity: block\n",
      ),
      '/proj/.claude/.gate-status/changed_files.sess-1--a.txt': 'x.py\n',
    },
    {},
    (argv) => ({ exitCode: argv[0] === 'sh' ? 1 : 0, stdout: '' }),
  )
  const r = await $.classic.SubagentStop({ session_id: 'sess-1', stop_hook_active: false, agent_id: 'a', agent_transcript_path: '', agent_type: 't' } as never)
  expect(r.block).toContain('chk')
})
