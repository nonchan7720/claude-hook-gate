import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { feedbackGuard } from '../src/feedback-guard.ts'
import type { Dict } from '../src/pyutil.ts'
import { makeIo, rmTree, tmpDir, withTmp } from './helpers/node-io.ts'

const runGuard = (payload: Dict, feedbackDir: string, projectDir?: string) =>
  feedbackGuard(makeIo({ projectDir: projectDir ?? process.cwd(), env: { CLAUDE_FEEDBACK_DIR: feedbackDir } }), payload)

describe('feedback-guard', () => {
  let tmp: string

  const writeRule = (filename: string, count: number, enforce: string): void => {
    const content = `---\nname: ${filename.slice(0, -3)}\ndescription: test\ntype: feedback\ncount: ${count}\n${enforce}---\n\n本文\n`
    fs.writeFileSync(path.join(tmp, filename), content, 'utf8')
  }

  beforeEach(() => {
    tmp = tmpDir()
    writeRule(
      'dont_run_tests_manually.md',
      6,
      [
        'enforce:',
        '  - event: pre_bash',
        "    when: '(^|&&|\\|\\||;)\\s*go test\\b'",
        "    message: 'hookに任せてBashで手動実行しない'",
        '    severity: deny',
        '',
      ].join('\n'),
    )
    writeRule(
      'tdd.md',
      6,
      [
        'enforce:',
        '  - event: pre_edit',
        "    path: '**/*.go'",
        "    absent_sibling: '{stem}_test.go'",
        "    message: '先にテストファイルを書くこと'",
        '    severity: ask',
        '',
      ].join('\n'),
    )
  })

  afterEach(() => rmTree(tmp))

  const decision = (stdout: string) => (JSON.parse(stdout) as { hookSpecificOutput: Dict }).hookSpecificOutput

  test('deny for manual go test', async () => {
    const r = await runGuard({ tool_name: 'Bash', tool_input: { command: 'go test ./...' } }, tmp)
    expect(r.exitCode).toBe(0)
    const hs = decision(r.stdout)
    expect(hs.hookEventName).toBe('PreToolUse')
    expect(hs.permissionDecision).toBe('deny')
    expect(hs.permissionDecisionReason).toContain('dont_run_tests_manually')
    expect(hs.permissionDecisionReason).toContain('count: 6')
  })

  test('passes for unrelated bash command', async () => {
    const r = await runGuard({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }, tmp)
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  test('ask for missing test sibling on write', () =>
    withTmp(async (proj) => {
      const r = await runGuard({ tool_name: 'Write', tool_input: { file_path: path.join(proj, 'foo.go'), content: 'package main' } }, tmp, proj)
      expect(r.exitCode).toBe(0)
      expect(decision(r.stdout).permissionDecision).toBe('ask')
    }))

  test('passes when test sibling exists', () =>
    withTmp(async (proj) => {
      fs.writeFileSync(path.join(proj, 'foo_test.go'), '')
      const r = await runGuard({ tool_name: 'Write', tool_input: { file_path: path.join(proj, 'foo.go'), content: 'package main' } }, tmp, proj)
      expect(r.exitCode).toBe(0)
      expect(r.stdout.trim()).toBe('')
    }))

  test('second ask in same session and file downgrades to warn', () =>
    withTmp(async (proj) => {
      const payload = {
        session_id: 'sess-ask-dedup',
        tool_name: 'Write',
        tool_input: { file_path: path.join(proj, 'foo.go'), content: 'package main' },
      }
      const r1 = await runGuard(payload, tmp, proj)
      expect(decision(r1.stdout).permissionDecision).toBe('ask')

      const r2 = await runGuard(payload, tmp, proj)
      expect(r2.stdout.trim()).toBe('')
      expect(r2.stderr).toContain('tdd')
      expect(r2.stderr).toContain('warn')

      const entries = fs
        .readFileSync(path.join(tmp, '.violations.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Dict)
      const tdd = entries.filter((e) => e.rule === 'tdd')
      expect(tdd[tdd.length - 1]?.severity).toBe('warn')
    }))

  test('ask for different file in same session is not suppressed', () =>
    withTmp(async (proj) => {
      const common = { session_id: 'sess-ask-dedup-2', tool_name: 'Write' }
      const r1 = await runGuard({ ...common, tool_input: { file_path: path.join(proj, 'foo.go'), content: 'package main' } }, tmp, proj)
      const r2 = await runGuard({ ...common, tool_input: { file_path: path.join(proj, 'bar.go'), content: 'package main' } }, tmp, proj)
      for (const r of [r1, r2]) expect(decision(r.stdout).permissionDecision).toBe('ask')
    }))

  test('ask without session id is not suppressed', () =>
    withTmp(async (proj) => {
      const payload = { tool_name: 'Write', tool_input: { file_path: path.join(proj, 'foo.go'), content: 'package main' } }
      const r1 = await runGuard(payload, tmp, proj)
      const r2 = await runGuard(payload, tmp, proj)
      for (const r of [r1, r2]) expect(decision(r.stdout).permissionDecision).toBe('ask')
    }))

  test('deny violation is not downgraded and repeats', async () => {
    const payload = { session_id: 'sess-deny-repeat', tool_name: 'Bash', tool_input: { command: 'go test ./...' } }
    const r1 = await runGuard(payload, tmp)
    const r2 = await runGuard(payload, tmp)
    for (const r of [r1, r2]) expect(decision(r.stdout).permissionDecision).toBe('deny')
  })

  test('never fails hard on an empty payload or a broken rule', async () => {
    const empty = await runGuard({}, tmp)
    expect(empty.exitCode).toBe(0)
    expect(empty.stdout).toBe('')

    // 壊れたルール（不正な正規表現）はその要素だけが無効になり、他のルールは効き続ける
    writeRule('broken.md', 6, ['enforce:', '  - event: pre_bash', "    when: '(unclosed'", "    message: 'x'", ''].join('\n'))
    const r = await runGuard({ tool_name: 'Bash', tool_input: { command: 'ls' } }, tmp)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
    const denied = await runGuard({ tool_name: 'Bash', tool_input: { command: 'go test ./...' } }, tmp)
    expect(decision(denied.stdout).permissionDecision).toBe('deny')
    expect(fs.readFileSync(path.join(tmp, '.errors.jsonl'), 'utf8')).toContain('broken.md')
  })

  test('an internal error is ignored but recorded in .errors.jsonl', async () => {
    const io = { ...makeIo({ projectDir: process.cwd(), env: { CLAUDE_FEEDBACK_DIR: tmp } }), list: () => Promise.reject(new Error('boom')) }
    const r = await feedbackGuard(io, { tool_name: 'Bash', tool_input: { command: 'go test ./...' } })
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('[feedback-guard] internal error (ignored): boom\n')
    const entry = JSON.parse(fs.readFileSync(path.join(tmp, '.errors.jsonl'), 'utf8').trim()) as Dict
    expect(entry.source).toBe('feedback-guard')
    expect(entry.error).toBe('boom')
  })
})

describe('feedback-guard: pre_edit scope', () => {
  let fbDir: string
  let proj: string
  beforeEach(() => {
    fbDir = tmpDir()
    proj = tmpDir()
  })
  afterEach(() => {
    rmTree(fbDir)
    rmTree(proj)
  })

  const writeRule = (enforce: string[]): void => {
    const content = ['---', 'name: scoped_pre', 'description: test', 'type: feedback', 'count: 6', 'enforce:', ...enforce, '---', '', '本文', ''].join('\n')
    fs.writeFileSync(path.join(fbDir, 'scoped_pre.md'), content, 'utf8')
  }
  const write = (file: string, content: string) => runGuard({ tool_name: 'Write', tool_input: { file_path: path.join(proj, file), content } }, fbDir, proj)
  const reason = (stdout: string): string => (JSON.parse(stdout) as { hookSpecificOutput: Dict }).hookSpecificOutput.permissionDecisionReason as string
  /** 最後に記録された違反の detail（deny の理由には detail が入らないのでログから読む）。 */
  const lastDetail = (): string => {
    const lines = fs.readFileSync(path.join(fbDir, '.violations.jsonl'), 'utf8').trim().split('\n')
    return String((JSON.parse(lines[lines.length - 1] as string) as Dict).detail)
  }

  test('scope: comments denies a badly formatted comment but not the same text in a string', async () => {
    writeRule([
      '  - event: pre_edit',
      "    path: 'src/**/*.ts'",
      "    when: '^//(?! TODO\\(\\w+\\): )'",
      "    unless: '^///'",
      '    scope: comments',
      "    message: 'TODO 形式'",
    ])
    expect((await write('src/a.ts', 'const s = "// nope"\n// TODO(me): ok\n/// doc\n')).stdout).toBe('')
    const r = await write('src/b.ts', 'const a = 1\n// nope\n')
    expect(reason(r.stdout)).toContain('TODO 形式')
    expect(lastDetail()).toBe('comment matched: ^//(?! TODO\\(\\w+\\): ) (line 2)')
  })

  test('scope: code and lang override', async () => {
    writeRule(['  - event: pre_edit', "    path: 'src/**/*'", '    lang: ts', "    when: '^\\s*console\\.log\\('", '    scope: code', "    message: 'm'"])
    expect((await write('src/a.unknown', '// console.log(1)\n')).stdout).toBe('')
    expect(reason((await write('src/b.unknown', 'console.log(1)\n')).stdout)).toContain('count: 6')
    expect(lastDetail()).toBe('code matched: ^\\s*console\\.log\\(')
  })

  test('unknown extension without lang: comments finds nothing', async () => {
    writeRule(['  - event: pre_edit', "    path: 'src/**/*'", "    when: 'bad'", '    scope: comments', "    message: 'm'"])
    expect((await write('src/a.unknown', '// bad\n')).stdout).toBe('')
  })
})
