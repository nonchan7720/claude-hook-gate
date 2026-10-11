import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { feedbackGuard } from '../src/feedback-guard.ts'
import { feedbackPostEdit } from '../src/feedback-post-edit.ts'
import { AUTO_COUNT_MAX, countStatePath, readCountLine, replaceCountLine } from '../src/feedback-rules.ts'
import { feedbackStopCheck } from '../src/feedback-stop-check.ts'
import type { Dict } from '../src/pyutil.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

// 違反を検出したときの count の自動引き上げ（autoBumpCounts）を、3 つの hook 経由で確かめる。
describe('feedback auto count', () => {
  let feedbackDir: string
  let projectDir: string

  // frontmatter の外（本文）にも count: 行や似たキーを置き、count 行以外が一切変わらないことを確かめる。
  const ruleText = (name: string, count: number, enforce: string[]): string =>
    ['---', `name: ${name}`, 'description: test', 'type: feedback', `count: ${count}`, 'max_count: 9', ...enforce, '---', '', '本文', 'count: 1', ''].join('\n')

  const bashRule = (count: number, dir = feedbackDir, name = 'no_go_test'): string => {
    const p = path.join(dir, `${name}.md`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      p,
      ruleText(name, count, [
        'enforce:',
        '  - event: pre_bash',
        "    when: '\\bgo test\\b'",
        "    message: 'hook に任せる'",
        '  - event: pre_bash',
        "    when: 'go test ./\\.\\.\\.'",
      ]),
    )
    return p
  }

  const countOf = (p: string): number | undefined => readCountLine(fs.readFileSync(p, 'utf8'))

  const guard = (sessionId: string | undefined, opts: { autoCount?: boolean; lang?: 'ja' | 'en' } = {}) =>
    feedbackGuard(makeIo({ projectDir, env: { CLAUDE_FEEDBACK_DIR: feedbackDir }, ...opts }), {
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      tool_name: 'Bash',
      tool_input: { command: 'go test ./...' },
    })

  beforeEach(() => {
    feedbackDir = tmpDir()
    projectDir = tmpDir()
  })

  afterEach(() => {
    rmTree(feedbackDir)
    rmTree(projectDir)
  })

  test('違反を検出すると count を 1 上げ、frontmatter の count 行以外は変えない', async () => {
    const p = bashRule(1)
    const before = fs.readFileSync(p, 'utf8')
    const r = await guard('s1')
    expect(r.stderr).toContain('no_go_test (count: 1)')
    expect(r.stderr).toContain('count を 1 → 2 に上げました')
    const after = fs.readFileSync(p, 'utf8')
    expect(after).toBe(before.replace(/^count: 1$/m, 'count: 2'))
    // 本文の count: 1 は残る
    expect(after.endsWith('本文\ncount: 1\n')).toBe(true)
    // 一時ファイルを残さない
    expect(fs.readdirSync(feedbackDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  test('同じセッションでは 2 回目以降は上げない（enforce が複数一致しても 1 回）', async () => {
    const p = bashRule(1)
    await guard('s1')
    const r = await guard('s1')
    expect(countOf(p)).toBe(2)
    expect(r.stderr).not.toContain('上げました')
    expect(JSON.parse(fs.readFileSync(countStatePath(makeIo({ projectDir, env: { CLAUDE_FEEDBACK_DIR: feedbackDir } }), 's1'), 'utf8'))).toEqual({
      bumped: ['no_go_test'],
    })
  })

  test('別のセッションではまた上がり、count に応じて強制力も上がる', async () => {
    const p = bashRule(2)
    await guard('s1')
    expect(countOf(p)).toBe(3)
    const r = await guard('s2')
    expect(countOf(p)).toBe(4)
    // s2 の判定は上げる前の count 3 で行う（ask）。理由に引き上げの旨が入る。
    const hs = (JSON.parse(r.stdout) as { hookSpecificOutput: Dict }).hookSpecificOutput
    expect(hs.permissionDecision).toBe('ask')
    expect(hs.permissionDecisionReason).toContain('no_go_test (count: 3)')
    expect(hs.permissionDecisionReason).toContain('count を 3 → 4 に上げました')
  })

  test(`上限（deny になる count = ${AUTO_COUNT_MAX}）で止まる`, async () => {
    const p = bashRule(4)
    await guard('s1')
    expect(countOf(p)).toBe(5)
    const before = fs.readFileSync(p, 'utf8')
    const r = await guard('s2')
    expect(fs.readFileSync(p, 'utf8')).toBe(before)
    expect((JSON.parse(r.stdout) as { hookSpecificOutput: Dict }).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(r.stdout).not.toContain('上げました')
  })

  test('autoCount=false なら上げない', async () => {
    const p = bashRule(1)
    const r = await guard('s1', { autoCount: false })
    expect(countOf(p)).toBe(1)
    expect(r.stderr).toContain('no_go_test (count: 1)')
    expect(r.stderr).not.toContain('上げました')
  })

  test('session_id が無ければ上げない（セッション単位の抑制ができないため）', async () => {
    const p = bashRule(1)
    await guard(undefined)
    expect(countOf(p)).toBe(1)
  })

  test('同名ルールがプロジェクトにもあれば、実際に使われたプロジェクト側を上げる', async () => {
    const g = bashRule(1)
    const proj = bashRule(2, path.join(projectDir, '.claude', 'feedback'))
    await guard('s1')
    expect(countOf(g)).toBe(1)
    expect(countOf(proj)).toBe(3)
  })

  test('英語のメッセージ', async () => {
    bashRule(1)
    const r = await guard('s1', { lang: 'en' })
    expect(r.stderr).toContain('raised the count of no_go_test from 1 to 2')
  })

  test('PostToolUse（post_edit）でも上げる', async () => {
    const p = path.join(feedbackDir, 'no_console_log.md')
    fs.writeFileSync(
      p,
      ruleText('no_console_log', 3, [
        'enforce:',
        '  - event: post_edit',
        "    path: 'src/**/*.ts'",
        "    when: '^\\s*console\\.log\\('",
        "    message: 'console.log を残さない'",
      ]),
    )
    const file = path.join(projectDir, 'src', 'a.ts')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'console.log(1)\n')
    const r = await feedbackPostEdit(makeIo({ projectDir, env: { CLAUDE_FEEDBACK_DIR: feedbackDir } }), {
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: file },
    })
    expect(countOf(p)).toBe(4)
    expect((JSON.parse(r.stdout) as { reason: string }).reason).toContain('count を 3 → 4 に上げました')
  })

  test('Stop（stop_check）でも上げ、ブロックが続いても同じセッションでは 1 回だけ', async () => {
    const p = path.join(feedbackDir, 'readme_bilingual.md')
    fs.writeFileSync(
      p,
      ruleText('readme_bilingual', 1, [
        'enforce:',
        '  - event: stop_check',
        "    changed: '**/README.md'",
        "    require_sibling: 'README_ja.md'",
        "    message: '日英併記'",
      ]),
    )
    fs.writeFileSync(path.join(projectDir, 'README.md'), '')
    const stateDir = path.join(projectDir, '.claude', '.gate-status')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'changed_files.s1.txt'), 'README.md\n')
    const io = makeIo({ projectDir, env: { CLAUDE_FEEDBACK_DIR: feedbackDir } })
    const r = await feedbackStopCheck(io, { session_id: 's1' })
    expect(r.stderr).toContain('count を 1 → 2 に上げました')
    await feedbackStopCheck(io, { session_id: 's1' })
    expect(countOf(p)).toBe(2)
  })
})

describe('readCountLine / replaceCountLine', () => {
  test('frontmatter の数値の count 行だけを扱う', () => {
    const text = '---\nname: a\ncount: 2\n---\ncount: 7\n'
    expect(readCountLine(text)).toBe(2)
    expect(replaceCountLine(text, 3)).toBe('---\nname: a\ncount: 3\n---\ncount: 7\n')
  })

  test('count 行が無い・数値でない・frontmatter が無いときは扱わない', () => {
    expect(readCountLine('---\nname: a\n---\ncount: 7\n')).toBeUndefined()
    expect(replaceCountLine('---\nname: a\ncount: "2"\n---\n', 3)).toBeUndefined()
    expect(replaceCountLine('count: 2\n', 3)).toBeUndefined()
  })

  test('CRLF の改行を保つ', () => {
    expect(replaceCountLine('---\r\nname: a\r\ncount: 2\r\n---\r\nbody\r\n', 3)).toBe('---\r\nname: a\r\ncount: 3\r\n---\r\nbody\r\n')
  })
})
