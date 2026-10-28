import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { feedbackFileInject } from '../src/feedback-file-inject.ts'
import { feedbackInject } from '../src/feedback-inject.ts'
import { inheritFiles, injectStatePath, listRules, rulesForFile } from '../src/feedback-rules.ts'
import type { Lang } from '../src/i18n.ts'
import type { Dict } from '../src/pyutil.ts'
import { resetGate } from '../src/reset-gate.ts'
import { makeIo, withTmp } from './helpers/node-io.ts'

type Out = { hookSpecificOutput?: { hookEventName: string; additionalContext: string } }

const ioFor = (projectDir: string, feedbackDir: string, lang?: Lang) => makeIo({ projectDir, env: { CLAUDE_FEEDBACK_DIR: feedbackDir }, lang })

function writeRule(dir: string, name: string, count: number, extra = '', body = `${name} の本文の第一段落。`): void {
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: desc ${name}\ntype: feedback\ncount: ${count}\n${extra}---\n\n${body}\n\n**Why:** 理由。\n`,
  )
}

const parse = (stdout: string): Out => (stdout.trim() === '' ? {} : (JSON.parse(stdout) as Out))
const context = (stdout: string): string => parse(stdout).hookSpecificOutput?.additionalContext ?? ''

const read = (file: string, session = 'sess-1', agent?: string): Dict => ({
  session_id: session,
  ...(agent ? { agent_id: agent } : {}),
  tool_name: 'Read',
  tool_input: { file_path: file },
  tool_response: {},
})
const edit = (file: string, session = 'sess-1'): Dict => ({
  session_id: session,
  tool_name: 'Edit',
  tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
  tool_response: {},
})

/** feedback ディレクトリとプロジェクトを作り、body に渡す。 */
const withDirs = (body: (proj: string, fb: string) => Promise<void>) =>
  withTmp(async (tmp) => {
    const proj = path.join(tmp, 'proj')
    const fb = path.join(tmp, 'fb')
    fs.mkdirSync(proj, { recursive: true })
    fs.mkdirSync(fb, { recursive: true })
    await body(proj, fb)
  })

describe('files key: parsing and matching', () => {
  test('files / exclude_files are read as string or list; rulesForFile matches project-relative paths', () =>
    withDirs(async (proj, fb) => {
      writeRule(fb, 'go_errors', 3, "files: '**/*.go'\nexclude_files: ['**/*_test.go']\n")
      writeRule(fb, 'py_types', 3, "files: ['**/*.py', '**/*.pyi']\n")
      writeRule(fb, 'everywhere', 3)
      const io = ioFor(proj, fb)
      const rules = await listRules(io)
      const byName = Object.fromEntries(rules.map((r) => [r.name, r]))
      expect(byName.go_errors?.files).toEqual(['**/*.go'])
      expect(byName.go_errors?.excludeFiles).toEqual(['**/*_test.go'])
      expect(byName.py_types?.files).toEqual(['**/*.py', '**/*.pyi'])
      expect(byName.everywhere?.files).toEqual([])
      const names = (file: string) => rulesForFile(io, rules, file).map((r) => r.name)
      expect(names(path.join(proj, 'internal', 'a.go'))).toEqual(['go_errors'])
      expect(names('internal/a.go')).toEqual(['go_errors'])
      expect(names(path.join(proj, 'internal', 'a_test.go'))).toEqual([])
      expect(names(path.join(proj, 'pkg', 'x.pyi'))).toEqual(['py_types'])
      expect(names(path.join(proj, 'README.md'))).toEqual([])
      // worktree の中はそのルート相対で判定する
      expect(names(path.join(proj, '.claude', 'worktrees', 'wt1', 'cmd', 'main.go'))).toEqual(['go_errors'])
    }))

  test('pre_edit / post_edit entries without path inherit files and exclude_files', () =>
    withDirs(async (proj, fb) => {
      writeRule(
        fb,
        'go_errors',
        3,
        [
          "files: '**/*.go'",
          "exclude_files: '**/*_test.go'",
          'enforce:',
          '  - event: pre_edit',
          "    when: 'return err$'",
          "    message: 'wrap'",
          '  - event: post_edit',
          "    path: 'cmd/**/*.go'",
          "    exclude_path: 'cmd/gen/**'",
          "    when: 'panic\\('",
          "    message: 'no panic'",
          '  - event: pre_bash',
          "    when: 'go test'",
          "    message: 'no manual tests'",
          '',
        ].join('\n'),
      )
      const [rule] = await listRules(ioFor(proj, fb))
      expect(rule?.enforce[0]?.path).toEqual(['**/*.go'])
      expect(rule?.enforce[0]?.exclude_path).toEqual(['**/*_test.go'])
      // 自分で path を書いた要素はそのまま
      expect(rule?.enforce[1]?.path).toBe('cmd/**/*.go')
      expect(rule?.enforce[1]?.exclude_path).toBe('cmd/gen/**')
      // pre_bash には関係ない
      expect(rule?.enforce[2]?.path).toBeUndefined()
    }))

  test('inheritFiles leaves entries alone when the rule has no files', () => {
    const entries = [{ event: 'pre_edit', when: 'x' }]
    expect(inheritFiles(entries, [], [])).toBe(entries)
    expect(inheritFiles(entries, ['**/*.go'], [])).toEqual([{ event: 'pre_edit', when: 'x', path: ['**/*.go'] }])
  })
})

describe('feedback-inject skips file-scoped rules', () => {
  test('a rule with files is not injected on UserPromptSubmit; the others still are', () =>
    withDirs(async (proj, fb) => {
      writeRule(fb, 'go_errors', 5, "files: '**/*.go'\n")
      writeRule(fb, 'everywhere', 3)
      const r = await feedbackInject(ioFor(proj, fb), 'sess-1')
      expect(r.stdout).toContain('everywhere')
      expect(r.stdout).not.toContain('go_errors')
    }))
})

describe('feedback-file-inject', () => {
  test('Read of a matching file injects the rule once per turn; a new prompt lets it come again', () =>
    withDirs(async (proj, fb) => {
      writeRule(fb, 'go_errors', 3, "files: '**/*.go'\n")
      writeRule(fb, 'go_style', 4, "files: '**/*.go'\n")
      writeRule(fb, 'everywhere', 3)
      writeRule(fb, 'provisional', 1, "files: '**/*.go'\n")
      const io = ioFor(proj, fb, 'ja')
      const file = path.join(proj, 'internal', 'a.go')

      const first = await feedbackFileInject(io, read(file))
      expect(first.exitCode).toBe(0)
      const out = parse(first.stdout)
      expect(out.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
      const text = out.hookSpecificOutput?.additionalContext ?? ''
      expect(text.startsWith('# internal/a.go に適用されるフィードバックルール\n今読んだファイル')).toBe(true)
      // count 降順
      expect(text.indexOf('■ go_style (これまで 4 回指摘されています)')).toBeLessThan(text.indexOf('■ go_errors (これまで 3 回指摘されています)'))
      expect(text).toContain('go_errors の本文の第一段落。')
      expect(text).not.toContain('everywhere')
      expect(text).not.toContain('provisional')
      expect(text).not.toContain('**Why**')
      expect(fs.existsSync(injectStatePath(io, 'sess-1'))).toBe(true)

      // 同じターンの 2 回目（別の Go ファイルでも）は出ない
      const again = await feedbackFileInject(io, read(path.join(proj, 'internal', 'b.go')))
      expect(again.stdout).toBe('')
      const edited = await feedbackFileInject(io, edit(file))
      expect(edited.stdout).toBe('')

      // 新しいプロンプトで状態が消え、また出る
      await feedbackInject(io, 'sess-1')
      expect(fs.existsSync(injectStatePath(io, 'sess-1'))).toBe(false)
      const next = await feedbackFileInject(io, edit(file))
      expect(context(next.stdout).startsWith('# internal/a.go に適用されるフィードバックルール\n今編集したファイル')).toBe(true)
    }))

  test('the header follows the language and names the file; a file outside the project keeps its absolute path', () =>
    withDirs(async (proj, fb) => {
      writeRule(fb, 'go_errors', 3, "files: '**/*.go'\n")
      const en = await feedbackFileInject(ioFor(proj, fb, 'en'), read(path.join(proj, 'a.go')))
      expect(context(en.stdout).startsWith('# Feedback rules for a.go\nThese confirmed rules apply to the file you just read.')).toBe(true)
      expect(context(en.stdout)).toContain('■ go_errors (pointed out 3 times so far)')
      // 相対パスの file_path もプロジェクト相対で判定する
      const rel = await feedbackFileInject(ioFor(proj, fb, 'en'), read('b.go', 'sess-2'))
      expect(context(rel.stdout)).toContain('# Feedback rules for b.go')
    }))

  test('non-matching files, other tools and rules below count 3 produce nothing', () =>
    withDirs(async (proj, fb) => {
      writeRule(fb, 'go_errors', 3, "files: '**/*.go'\nexclude_files: '**/*_test.go'\n")
      writeRule(fb, 'py_low', 2, "files: '**/*.py'\n")
      const io = ioFor(proj, fb)
      expect((await feedbackFileInject(io, read(path.join(proj, 'a.py')))).stdout).toBe('')
      expect((await feedbackFileInject(io, read(path.join(proj, 'a_test.go')))).stdout).toBe('')
      expect((await feedbackFileInject(io, { session_id: 's', tool_name: 'Glob', tool_input: { pattern: '**/*.go' } })).stdout).toBe('')
      expect((await feedbackFileInject(io, { session_id: 's', tool_name: 'Read', tool_input: {} })).stdout).toBe('')
      expect(fs.existsSync(injectStatePath(io, 's'))).toBe(false)
    }))

  test('Bash: the targets of plain heredoc writes are treated like Write; other commands are not', () =>
    withDirs(async (proj, fb) => {
      writeRule(fb, 'sql_down', 3, "files: 'migrations/*.sql'\n")
      const io = ioFor(proj, fb, 'en')
      const bash = (command: string, session: string): Dict => ({
        session_id: session,
        cwd: proj,
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: {},
      })
      const r = await feedbackFileInject(io, bash("cat > migrations/001_up.sql <<'EOF'\nCREATE TABLE t (id int);\nEOF", 's1'))
      expect(context(r.stdout)).toContain('# Feedback rules for migrations/001_up.sql')
      expect(context(r.stdout)).toContain('the file you just edited')
      expect((await feedbackFileInject(io, bash('python gen.py > migrations/002_up.sql', 's2'))).stdout).toBe('')
      expect((await feedbackFileInject(io, bash('ls migrations', 's3'))).stdout).toBe('')
    }))

  test('subagents keep their own state; the parent state is not shared with them', () =>
    withDirs(async (proj, fb) => {
      writeRule(fb, 'go_errors', 3, "files: '**/*.go'\n")
      const io = ioFor(proj, fb)
      const file = path.join(proj, 'a.go')
      expect(context((await feedbackFileInject(io, read(file))).stdout)).toContain('go_errors')
      expect(context((await feedbackFileInject(io, read(file, 'sess-1', 'agent-9'))).stdout)).toContain('go_errors')
      expect(fs.existsSync(injectStatePath(io, 'sess-1--agent-9'))).toBe(true)
      // 親の UserPromptSubmit でサブエージェント分も消える
      await feedbackInject(io, 'sess-1')
      expect(fs.existsSync(injectStatePath(io, 'sess-1--agent-9'))).toBe(false)
    }))

  test('without a session id nothing is remembered, so the rule is shown every time', () =>
    withDirs(async (proj, fb) => {
      writeRule(fb, 'go_errors', 3, "files: '**/*.go'\n")
      const io = ioFor(proj, fb)
      const payload: Dict = { tool_name: 'Read', tool_input: { file_path: path.join(proj, 'a.go') } }
      expect(context((await feedbackFileInject(io, payload)).stdout)).toContain('go_errors')
      expect(context((await feedbackFileInject(io, payload)).stdout)).toContain('go_errors')
    }))

  test('inactive rules (projects / expires) are never injected', () =>
    withDirs(async (proj, fb) => {
      writeRule(fb, 'elsewhere', 3, "files: '**/*.go'\nprojects: ['/no/such/dir/**']\n")
      writeRule(fb, 'expired', 3, "files: '**/*.go'\nexpires: 2020-01-01\n")
      expect((await feedbackFileInject(ioFor(proj, fb), read(path.join(proj, 'a.go')))).stdout).toBe('')
    }))

  test('SessionStart clears the state on startup / clear / compact and keeps it on resume', () =>
    withDirs(async (proj, fb) => {
      writeRule(fb, 'go_errors', 3, "files: '**/*.go'\n")
      const io = ioFor(proj, fb)
      const file = path.join(proj, 'a.go')
      for (const source of ['startup', 'clear', 'compact']) {
        await feedbackFileInject(io, read(file))
        expect(fs.existsSync(injectStatePath(io, 'sess-1'))).toBe(true)
        await resetGate(io, { session_id: 'sess-1', source })
        expect(fs.existsSync(injectStatePath(io, 'sess-1'))).toBe(false)
      }
      await feedbackFileInject(io, read(file))
      await resetGate(io, { session_id: 'sess-1', source: 'resume' })
      expect(fs.existsSync(injectStatePath(io, 'sess-1'))).toBe(true)
      // 他のセッションの状態には触らない
      await feedbackFileInject(io, read(file, 'sess-2'))
      await resetGate(io, { session_id: 'sess-1', source: 'clear' })
      expect(fs.existsSync(injectStatePath(io, 'sess-2'))).toBe(true)
      // 24h 超のものは掃除される
      fs.utimesSync(injectStatePath(io, 'sess-2'), 1, 1)
      await resetGate(io, { session_id: 'sess-3', source: 'resume' })
      expect(fs.existsSync(injectStatePath(io, 'sess-2'))).toBe(false)
    }))
})
