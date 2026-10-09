import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { feedbackPostEdit } from '../src/feedback-post-edit.ts'
import type { Dict } from '../src/pyutil.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

describe('feedback-post-edit', () => {
  let feedbackDir: string
  let projectDir: string

  const writeRule = (name: string, count: number, enforce: string[]): void => {
    const content = ['---', `name: ${name}`, 'description: test', 'type: feedback', `count: ${count}`, 'enforce:', ...enforce, '---', '', '本文', ''].join('\n')
    fs.writeFileSync(path.join(feedbackDir, `${name}.md`), content, 'utf8')
  }

  const writeFile = (rel: string, content: string): string => {
    const abs = path.join(projectDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
    return abs
  }

  const run = (payload: Dict) => feedbackPostEdit(makeIo({ projectDir, env: { CLAUDE_FEEDBACK_DIR: feedbackDir } }), payload)
  const edit = (filePath: string, toolName = 'Edit') => run({ tool_name: toolName, tool_input: { file_path: filePath } })

  const consoleLogRule = (count: number, extra: string[] = []) =>
    writeRule('no_console_log', count, [
      '  - event: post_edit',
      "    path: 'src/**/*.ts'",
      "    when: '^\\s*console\\.log\\('",
      "    message: 'console.log を残さない'",
      ...extra,
    ])

  beforeEach(() => {
    feedbackDir = tmpDir()
    projectDir = tmpDir()
  })

  afterEach(() => {
    rmTree(feedbackDir)
    rmTree(projectDir)
  })

  test('blocks when the edited file as a whole matches when (count 4 -> block)', async () => {
    consoleLogRule(4)
    const file = writeFile('src/a.ts', 'const x = 1\nconsole.log(x)\n')
    const r = await edit(file)
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout) as { decision: string; reason: string }
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('[feedback-post-edit] no_console_log (count: 4): console.log を残さない')
    expect(out.reason).toContain('content matched')
    expect(r.stderr).toContain(out.reason)
  })

  test('accepts a project-relative file_path', async () => {
    consoleLogRule(5)
    writeFile('src/a.ts', 'console.log(1)\n')
    const r = await edit('src/a.ts', 'Write')
    expect(JSON.parse(r.stdout)).toMatchObject({ decision: 'block' })
  })

  test('unless avoids the violation', async () => {
    consoleLogRule(4, ["    unless: 'eslint-disable'"])
    const file = writeFile('src/a.ts', '// eslint-disable-next-line\nconsole.log(1)\n')
    const r = await edit(file)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  test('count 1 only warns on stderr', async () => {
    consoleLogRule(1)
    const file = writeFile('src/a.ts', 'console.log(1)\n')
    const r = await edit(file, 'MultiEdit')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('[feedback-post-edit] warn: no_console_log (count: 1): console.log を残さない\n')
  })

  test('exclude_path skips the file', async () => {
    consoleLogRule(5, ["    exclude_path: '**/*.test.ts'"])
    const file = writeFile('src/a.test.ts', 'console.log(1)\n')
    const r = await edit(file)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  test('a file outside path is ignored', async () => {
    consoleLogRule(5)
    const file = writeFile('lib/a.ts', 'console.log(1)\n')
    expect((await edit(file)).stdout).toBe('')
  })

  test('check failing (non-zero) is a violation', async () => {
    writeRule('has_header', 4, [
      '  - event: post_edit',
      "    path: '**/*.ts'",
      '    check: \'head -1 "$FILE" | grep -q HEADER\'',
      "    message: 'ヘッダを付ける'",
    ])
    const file = writeFile('a.ts', 'no header\n')
    const r = await edit(file)
    const out = JSON.parse(r.stdout) as { decision: string; reason: string }
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('has_header')
    expect(out.reason).toContain('check failed')
  })

  test('check passing (zero) is not a violation', async () => {
    writeRule('has_header', 5, [
      '  - event: post_edit',
      "    path: '**/*.ts'",
      '    check: \'head -1 "$FILE" | grep -q HEADER\'',
      "    message: 'ヘッダを付ける'",
    ])
    const file = writeFile('a.ts', 'HEADER\nbody\n')
    const r = await edit(file)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  test('when and check are ANDed: when not matching skips the check', async () => {
    writeRule('both', 5, ['  - event: post_edit', "    path: '**/*.ts'", "    when: 'TODO'", "    check: 'false'", "    message: 'x'"])
    const clean = writeFile('a.ts', 'ok\n')
    expect((await edit(clean)).stdout).toBe('')
    const dirty = writeFile('b.ts', 'TODO\n')
    expect(JSON.parse((await edit(dirty)).stdout)).toMatchObject({ decision: 'block' })
  })

  test('an entry with neither when nor check is ignored', async () => {
    writeRule('empty', 5, ['  - event: post_edit', "    path: '**/*.ts'", "    message: 'x'"])
    const file = writeFile('a.ts', 'anything\n')
    const r = await edit(file)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  test('explicit severity overrides count', async () => {
    consoleLogRule(1, ['    severity: block'])
    const file = writeFile('src/a.ts', 'console.log(1)\n')
    expect(JSON.parse((await edit(file)).stdout)).toMatchObject({ decision: 'block' })
  })

  test('violations are logged', async () => {
    consoleLogRule(4)
    const file = writeFile('src/a.ts', 'console.log(1)\n')
    await edit(file)
    const lines = fs.readFileSync(path.join(feedbackDir, '.violations.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ rule: 'no_console_log', count: 4, severity: 'block', event: 'post_edit' })
  })

  test('ok when file_path is missing', async () => {
    consoleLogRule(5)
    const r = await run({ tool_name: 'Edit', tool_input: {} })
    expect(r).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  test('ok when the file does not exist', async () => {
    consoleLogRule(5)
    const r = await edit(path.join(projectDir, 'src', 'missing.ts'))
    expect(r).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  test('ok for tools other than Write/Edit/MultiEdit', async () => {
    consoleLogRule(5)
    const file = writeFile('src/a.ts', 'console.log(1)\n')
    const r = await edit(file, 'Read')
    expect(r).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })
})
