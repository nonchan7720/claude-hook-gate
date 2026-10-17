// `claude plugin test .` で実行する、実際のエンジンの上でのテスト（バンドル済みの hooks/register.js を読む）。
// ロジック本体のテストは tests/（bun test）にある。ここではエンジン API（$.fs / $.process / $.env / $.session）への
// 結線と、classic hook の戻り値への変換だけを、メモリ上のファイルシステムで確かめる。
import { expect, mock, test } from 'claude-code/testing'

type Files = Record<string, string>

const BUNDLED = /\/rules\/feedback_rules(\.en)?\.md$/

// 同梱の rules/ は常に存在し、その内容は BUNDLED_TEXT として読めることにする。
type Run = { exitCode: number; stdout: string }

// run: process.run の応答（argv ごと）。既定はすべて成功。
// mtimeMs: fs.stat / fs.list が返す mtime（既定 0。Bash の変更検出のテストでは開始時刻以降にする）。
const setup = (
  // biome-ignore lint/suspicious/noExplicitAny: エンジンの On 型は Claude Code の外では参照できないため緩く受ける
  on: any,
  files: Files = {},
  env: Record<string, string> = {},
  run: (argv: string[]) => Run = () => ({ exitCode: 0, stdout: '' }),
  mtimeMs = 0,
) => {
  const dirs = new Set<string>(['/proj'])
  for (const f of Object.keys(files)) for (let d = f.slice(0, f.lastIndexOf('/')); d.length > 0; d = d.slice(0, d.lastIndexOf('/'))) dirs.add(d)
  const runs: string[][] = []
  const statuses: (string | undefined)[] = []
  const invalidations: string[] = []
  // 既定の言語は日本語（期待値は日本語で書かれている）。LANG を差し替えるか options.language で切り替える。
  mock.env(on, { HOME: '/h', LANG: 'ja_JP.UTF-8', ...env })
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
      .map((p) => ({ name: p.slice((e.path ?? '').length + 1), kind: 'file', size: 0, mtimeMs, isLink: false })),
  }))
  on('fs.stat', (_$: unknown, e: { path: string }) => {
    if (e.path in files) return { value: { kind: 'file', size: 0, mtimeMs, isLink: false } }
    if (dirs.has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'rm') for (const p of e.argv.slice(1).filter((a) => !a.startsWith('-'))) delete files[p]
    if (e.argv[0] === 'mv') {
      const [src, dst] = e.argv.slice(-2) as [string, string]
      if (src in files) {
        files[dst] = files[src] as string
        delete files[src]
      }
    }
    const r = run(e.argv)
    return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStop'])
    on(`classic.${ev}`, () => ({}))
  on('ui.status', (_$: unknown, e: { text: string | undefined }) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', (_$: unknown, e: { event: string }) => {
    invalidations.push(e.event)
    return { value: undefined }
  })
  // 実タイマーを走らせない。
  on('clock.every', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ran' as never }))
  return { runs, files, statuses, invalidations }
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

test('PreToolUse: 別ファイルのルールが壊れていても（YAML・正規表現・enforce の形）他の deny は効き、壊れたファイルは記録・注入される', async ($, on) => {
  const { files } = setup(on, {
    '/h/.claude/feedback/no_rm.md': rule('no_rm', 6, "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    message: forbidden\n    severity: deny\n"),
    '/h/.claude/feedback/aa_regex.md': rule('aa_regex', 6, "enforce:\n  - event: pre_bash\n    when: 'go\\s+test(?i)\\s'\n    message: x\n"),
    '/h/.claude/feedback/aa_null.md': rule('aa_null', 6, 'enforce:\n  -\n'),
    '/h/.claude/feedback/aa_dict.md': rule('aa_dict', 6, 'enforce:\n  event: pre_bash\n  when: rm\n'),
    '/h/.claude/feedback/zz_yaml.md': rule('zz_yaml', 3, "enforce:\n  - event: pre_bash\n    when: 'it's'\n    message: x\n"),
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('no_rm (count: 6): forbidden')
  expect(files['/h/.claude/feedback/.violations.jsonl']).toContain('no_rm')
  const errors = files['/h/.claude/feedback/.errors.jsonl'] ?? ''
  for (const f of ['aa_regex', 'aa_null', 'aa_dict', 'zz_yaml']) expect(errors).toContain(`/h/.claude/feedback/${f}.md`)
  const p = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(p.additionalContext?.[1]).toContain('次のルールファイルが読めず無効になっています')
  expect(p.additionalContext?.[1]).toContain('- /h/.claude/feedback/zz_yaml.md: ファイルを読めません: ')
})

test('PreToolUse: 違反したルールの count を自動で上げ、同じセッションでは 1 回だけ', async ($, on) => {
  const { files } = setup(on, {
    '/h/.claude/feedback/no_rm.md': rule('no_rm', 3, "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    message: forbidden\n    severity: deny\n"),
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })
  expect(r.text).toContain('no_rm (count: 3): forbidden')
  expect(r.text).toContain('count を 3 → 4 に上げました')
  expect(files['/h/.claude/feedback/no_rm.md']).toContain('\ncount: 4\n')
  await $.tool.call({ tool: 'Bash', command: 'rm -rf y' })
  expect(files['/h/.claude/feedback/no_rm.md']).toContain('\ncount: 4\n')
  expect(Object.keys(files).filter((f) => f.endsWith('.tmp'))).toEqual([])
})

test('PreToolUse: autoCount が false なら count を上げない', { options: { autoCount: false } }, async ($, on) => {
  const { files } = setup(on, {
    '/h/.claude/feedback/no_rm.md': rule('no_rm', 3, "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    message: forbidden\n    severity: deny\n"),
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf x' })
  expect(r.text).not.toContain('上げました')
  expect(files['/h/.claude/feedback/no_rm.md']).toContain('\ncount: 3\n')
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

// Bash の変更検出: git rev-parse は /proj、ls-files は src/a.ts（未追跡）を返す。それ以外の git は空で成功。
const bashGit = (argv: string[]): Run => {
  if (argv[0] !== 'git') return { exitCode: 0, stdout: '' }
  if (argv.includes('rev-parse')) return { exitCode: 0, stdout: '/proj\n' }
  if (argv.includes('--others')) return { exitCode: 0, stdout: 'src/a.ts\0' }
  return { exitCode: 0, stdout: '' }
}
const consoleLogRule = rule(
  'no_console_log',
  4,
  "enforce:\n  - event: post_edit\n    path: 'src/**/*.ts'\n    when: 'console\\.log'\n    message: no console.log\n",
)

/** Bash の PreToolUse を通し、gate.yaml の無い PJ で feedback 側に置かれた開始時刻ファイルの tool_use_id を返す。 */
// biome-ignore lint/suspicious/noExplicitAny: 同上
const startBash = async ($: any, files: Files, command: string): Promise<string> => {
  await $.tool.call({ tool: 'Bash', command })
  const started = Object.keys(files).filter((f) => f.startsWith('/h/.claude/feedback/.bash_started/bash_started.sess-1--'))
  expect(started.length).toBe(1)
  return String(JSON.parse(files[started[0] as string] as string).tool_use_id)
}

test('PostToolUse(Bash): gate.yaml が無くても、Bash が書いたファイルに post_edit がかかり block になる', async ($, on) => {
  const files: Files = { '/h/.claude/feedback/ncl.md': consoleLogRule, '/proj/src/a.ts': 'console.log(1)\n' }
  setup(on, files, {}, bashGit, 1_700_000_000_000)
  const toolUseId = await startBash($, files, 'cat > src/a.ts <<EOF')
  const r = await $.classic.PostToolUse({
    session_id: 'sess-1',
    tool_name: 'Bash',
    tool_input: { command: 'cat > src/a.ts <<EOF' },
    tool_response: {},
    tool_use_id: toolUseId,
  } as never)
  expect(r.block).toContain('no_console_log (count: 4): no console.log (src/a.ts: content matched')
  expect(Object.keys(files).some((f) => f.startsWith('/proj/.claude/'))).toBe(false)
})

test('PostToolUse(Bash): git の履歴操作では検査しない', async ($, on) => {
  const files: Files = { '/h/.claude/feedback/ncl.md': consoleLogRule, '/proj/src/a.ts': 'console.log(1)\n' }
  setup(on, files, {}, bashGit, 1_700_000_000_000)
  const toolUseId = await startBash($, files, 'git rebase main')
  const r = await $.classic.PostToolUse({
    session_id: 'sess-1',
    tool_name: 'Bash',
    tool_input: { command: 'git rebase main' },
    tool_response: {},
    tool_use_id: toolUseId,
  } as never)
  expect(r.block).toBeUndefined()
})

test('PostToolUse: 実行中はステータス行を使わず帯を描き直させ、終わったら結果を 1 行でステータス行に残す', async ($, on) => {
  const files: Files = { '/proj/.claude/gate.yaml': JSON.stringify({ policy: false, rules: [{ match: '**/*.py', run: ['echo linting'] }] }) }
  const { statuses, invalidations } = setup(on, files)
  await $.classic.PostToolUse({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
  expect(statuses.some((s) => s?.startsWith('[gate] 実行中'))).toBe(false)
  expect(statuses.at(-1)).toBe('[gate] 完了: ✓ 1 (0.0s)')
  expect(invalidations).toContain('ui.render')
})

test('language: options.language が en なら英語で出す', { options: { language: 'en' } }, async ($, on) => {
  const files: Files = { '/proj/.claude/gate.yaml': JSON.stringify({ policy: false, rules: [{ match: '**/*.py', run: ['echo linting'] }] }) }
  const { statuses } = setup(on, files)
  await $.classic.PostToolUse({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
  expect(statuses.at(-1)).toBe('[gate] done: ✓ 1 (0.0s)')
})

test('language: 既定（auto）は環境変数 LANG に従う', async ($, on) => {
  const files: Files = { '/proj/.claude/gate.yaml': JSON.stringify({ policy: false, rules: [{ match: '**/*.py', run: ['echo linting'] }] }) }
  const { statuses } = setup(on, files, { LANG: 'en_US.UTF-8' })
  await $.classic.PostToolUse({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
  expect(statuses.at(-1)).toBe('[gate] done: ✓ 1 (0.0s)')
})

const BAND = { surface: 'terminal', component: 'AbovePrompt', requestId: 'r1', props: { hasSurvey: false, isWorking: false } } as const

// biome-ignore lint/suspicious/noExplicitAny: エンジンの On 型は Claude Code の外では参照できないため緩く受ける
const beneathBand = (on: any) => {
  const engineBand = { type: 'Text', children: ['engine band'] }
  on('ui.render', { component: 'AbovePrompt' }, () => engineBand)
  return engineBand
}

test('ui.render AbovePrompt: 実行中の項目がある間は複数行の木を返す', async ($, on) => {
  const started = 1_700_000_000_000 - 3000
  setup(on, {
    '/proj/.claude/.gate-status/running/sess-1.a1.json': JSON.stringify([
      { name: 'typecheck', cmd: 'bun run typecheck', started, result: 'ok', ended: started + 700 },
      { name: 'test', cmd: 'bun run test', started },
    ]),
    '/proj/.claude/.gate-status/running/sess-9.b1.json': JSON.stringify([{ name: 'other', cmd: 'pnpm test', started }]),
  })
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
  const files: Files = {}
  setup(on, files)
  const engineBand = beneathBand(on)
  expect(await $.ui.render(BAND)).toEqual(engineBand)
  files['/proj/.claude/.gate-status/running/sess-1.a1.json'] = JSON.stringify([{ name: 'lint', cmd: 'x', started, result: 'ok', ended: started + 100 }])
  expect(await $.ui.render(BAND)).toEqual(engineBand)
  files['/proj/.claude/.gate-status/running/sess-1.a1.json'] = JSON.stringify([{ name: 'test', cmd: 'x', started }])
  expect(await $.ui.render({ ...BAND, props: { hasSurvey: true, isWorking: false } })).toEqual(engineBand)
})

test('Stop: 予約済みの consistency_checks の実行中は帯に出て、終わったらステータス行に結果が残る', async ($, on) => {
  const files: Files = {
    '/proj/.claude/gate.yaml': JSON.stringify({
      policy: false,
      rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
      consistency_checks: [{ name: 'chk', run: ['echo checking'] }],
    }),
  }
  const { statuses } = setup(on, files)
  await $.classic.PostToolUse({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
  statuses.length = 0
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  expect(statuses.some((s) => s?.startsWith('[gate] 実行中'))).toBe(false)
  expect(statuses.at(-1)).toBe('[gate] 完了: ✓ 1 (0.0s)')
})

test('Stop: 検証がすべて通ったら一度だけ結果を報告してブロックし、続きの Stop は通す', async ($, on) => {
  const files: Files = {
    '/proj/.claude/gate.yaml': JSON.stringify({
      policy: false,
      rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
      consistency_checks: [{ name: 'chk', run: [{ cmd: 'echo checking', name: 'lint' }] }],
    }),
  }
  setup(on, files)
  await $.classic.PostToolUse({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
  const first = await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  expect(first.block).toContain('検証がすべて通りました: lint ✓')
  const second = await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: true })
  expect(second.block).toBeUndefined()
})

test('Stop: 成功報告ブロックでは通知せず、その続きの Stop で一度だけ完了通知する', async ($, on) => {
  const files: Files = {
    '/proj/.claude/gate.yaml': JSON.stringify({
      policy: false,
      rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
      consistency_checks: [{ name: 'chk', run: [{ cmd: 'echo checking', name: 'lint' }] }],
    }),
  }
  const { runs } = setup(on, files)
  const notified = () => runs.filter((argv) => argv[0] === 'osascript').length
  await $.classic.PostToolUse({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  expect(notified()).toBe(0)
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: true })
  expect(notified()).toBe(1)
})

test('Stop: 失敗ブロックの続きの Stop では通知しない', async ($, on) => {
  const files: Files = {
    '/proj/.claude/gate.yaml': JSON.stringify({
      policy: false,
      rules: [{ match: '**/*.py', run: ['true'], run_checks: ['chk'] }],
      consistency_checks: [{ name: 'chk', run: ['echo broken; exit 1'] }],
    }),
  }
  const { runs } = setup(on, files, {}, (argv) => ({ exitCode: argv[0] === 'sh' && argv[2]?.includes('echo broken') ? 1 : 0, stdout: '' }))
  await $.classic.PostToolUse({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: 'x.py' }, tool_response: {}, tool_use_id: 't1' })
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: true })
  expect(runs.filter((argv) => argv[0] === 'osascript').length).toBe(0)
})

test('PreToolUse: 検証コマンドを走らせない呼び出しではステータス行に触らない', async ($, on) => {
  const { statuses } = setup(on)
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(statuses).toEqual([])
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

test('followup: きっかけの Bash で後続コマンドを求め、実行されるまで Stop を止め、失敗は PostToolUseFailure で組み立て直させる', async ($, on) => {
  const { files } = setup(on, {
    '/h/.claude/followup/pr_checks.md': "---\nname: pr_checks\nwhen: '^gh pr create'\nrun: 'gh pr checks {{pr}} --watch'\nargs:\n  pr: 'PR 番号'\n---\n",
  })
  const bash = (command: string, extra: Record<string, unknown> = {}) => ({
    session_id: 'sess-1',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: {},
    tool_use_id: 't1',
    ...extra,
  })
  const r = await $.classic.PostToolUse(bash('gh pr create --fill'))
  expect(r.additionalContext?.join('\n')).toContain('[followup] `gh pr create --fill` を実行したので、続けて次の後続コマンドを実行してください（pr_checks）:')
  expect(r.additionalContext?.join('\n')).toContain('  {{pr}}: PR 番号')
  expect(Object.keys(files)).toContain('/h/.claude/followup/.pending/sess-1.json')
  const stop = await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  expect(stop.block).toContain('まだ実行していない後続コマンドがあります')
  const failed = await $.classic.PostToolUseFailure({ ...bash('gh pr checks abc --watch', { tool_use_id: 't2' }), error: 'Exit code 1' } as never)
  expect(failed.additionalContext?.join('\n')).toContain('（pr_checks）が失敗しました（試行 1/3）')
  const done = await $.classic.PostToolUse(bash('gh pr checks 12 --watch', { tool_use_id: 't3' }))
  expect(done.additionalContext?.join('\n')).toContain('（pr_checks）が成功しました')
  expect(Object.keys(files)).not.toContain('/h/.claude/followup/.pending/sess-1.json')
  const again = await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: true })
  expect(again.block).toBeUndefined()
})

test('followup: 引数が pattern で埋まれば hook がバックグラウンドで起動し、結果を Stop で渡す', async ($, on) => {
  const files: Files = {
    '/h/.claude/followup/pr_checks.md':
      "---\nname: pr_checks\nwhen: '^gh pr create'\nrun: 'gh pr checks {{pr}} --watch'\nargs:\n  pr:\n    pattern: 'pull/(\\d+)'\n---\n",
  }
  // 起動スクリプト（sh -c <script> sh <cmd> <log> <exit> <pid>）は実行せず、終わったことにして exit / pid を書く。
  const launches: string[] = []
  setup(on, files, {}, (argv) => {
    if (argv[0] === 'sh' && argv.length === 8 && String(argv[2]).includes('setsid')) {
      const [, , , , cmd, log, exit, pid] = argv as [string, string, string, string, string, string, string, string]
      launches.push(cmd)
      files[log] = `${files[log] ?? ''}all checks passed\n`
      files[exit] = '0\n'
      files[pid] = '4242\n'
    }
    return { exitCode: 0, stdout: '' }
  })
  const r = await $.classic.PostToolUse({
    session_id: 'sess-1',
    tool_name: 'Bash',
    tool_input: { command: 'gh pr create' },
    tool_response: { stdout: 'https://github.com/o/r/pull/12\n', stderr: '' },
    tool_use_id: 't1',
  })
  expect(r.additionalContext?.join('\n')).toContain('後続コマンド（pr_checks）をバックグラウンドで開始しました: `gh pr checks 12 --watch`')
  expect(launches).toEqual(['gh pr checks 12 --watch'])
  const stop = await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  expect(stop.block).toContain('後続コマンド `gh pr checks 12 --watch`（pr_checks）が終了しました（exit 0、')
  expect(stop.block).toContain('\nall checks passed')
  expect(Object.keys(files)).not.toContain('/h/.claude/followup/.pending/sess-1.json')
  const again = await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: true })
  expect(again.block).toBeUndefined()
})

test('PostToolUse(Agent): 終わったサブエージェントの SubagentStop の結果が呼び出し元の context に入る', async ($, on) => {
  const files: Files = {
    '/h/.claude/feedback/chk.md': rule(
      'chk',
      4,
      "enforce:\n  - event: stop_check\n    changed: '**/*.py'\n    check: 'exit 1'\n    message: bad\n    severity: warn\n",
    ),
    '/proj/.claude/.gate-status/changed_files.sess-1--a.txt': 'x.py\n',
  }
  setup(on, files, {}, (argv) => ({ exitCode: argv[0] === 'sh' ? 1 : 0, stdout: '' }))
  await $.classic.SubagentStop({ session_id: 'sess-1', stop_hook_active: false, agent_id: 'a', agent_transcript_path: '', agent_type: 't' } as never)
  const r = await $.classic.PostToolUse({
    session_id: 'sess-1',
    tool_name: 'Agent',
    tool_input: {},
    tool_response: { agentId: 'a' },
    tool_use_id: 't1',
  } as never)
  expect(String(r.additionalContext)).toContain('サブエージェント t (a)')
  expect(String(r.additionalContext)).toContain('chk')
  expect(Object.keys(files).some((f) => f.includes('subagent_report.'))).toBe(false)
})
