import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { feedbackGuard } from '../src/feedback-guard.ts'
import { similarityScore, similarityTokens } from '../src/feedback-new-rule.ts'
import type { Dict } from '../src/pyutil.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

const rule = (name: string, description: string, count = 1): string =>
  `---\nname: ${name}\ndescription: ${description}\ntype: feedback\ncount: ${count}\n---\n\n本文\n`

describe('feedback-new-rule', () => {
  let fb: string
  let proj: string

  const run = (payload: Dict) => feedbackGuard(makeIo({ projectDir: proj, cwd: proj, env: { CLAUDE_FEEDBACK_DIR: fb } }), payload)
  const write = (file: string, content: string, session = 'sess-new-rule'): Dict => ({
    session_id: session,
    tool_name: 'Write',
    tool_input: { file_path: file, content },
  })
  const decision = (stdout: string) => (JSON.parse(stdout) as { hookSpecificOutput: Dict }).hookSpecificOutput

  beforeEach(() => {
    fb = tmpDir()
    proj = tmpDir()
    fs.writeFileSync(path.join(fb, 'test_mocking.md'), rule('test_mocking', 'Do not mock the database in integration tests', 3))
    fs.writeFileSync(path.join(fb, 'commit_style.md'), rule('commit_style', 'Write commit messages in English'))
  })

  afterEach(() => {
    rmTree(fb)
    rmTree(proj)
  })

  test('denies the first creation of a new rule file and lists existing rules, similar first', async () => {
    const r = await run(write(path.join(fb, 'mock_tests.md'), rule('mock_tests', 'Avoid mocks in tests')))
    const hs = decision(r.stdout)
    expect(hs.permissionDecision).toBe('deny')
    const reason = String(hs.permissionDecisionReason)
    expect(reason).toContain('mock_tests.md')
    expect(reason).toContain('★ test_mocking (count: 3')
    expect(reason).toContain('- commit_style (count: 1')
    expect(reason.indexOf('test_mocking')).toBeLessThan(reason.indexOf('commit_style'))
    expect(reason).toContain('count を 1 上げ')
    expect(reason).toContain('似ているもの 1 件')
    expect(reason).not.toContain('newRule.')
  })

  test('the same write passes the second time in the session', async () => {
    const payload = write(path.join(fb, 'new_topic.md'), rule('new_topic', 'Something else'))
    expect(decision((await run(payload)).stdout).permissionDecision).toBe('deny')
    expect((await run(payload)).stdout.trim()).toBe('')
  })

  test('a new rule file in the project feedback dir is checked too', async () => {
    const dir = path.join(proj, '.claude', 'feedback')
    fs.mkdirSync(dir, { recursive: true })
    const r = await run(write(path.join(dir, 'commit_language.md'), rule('commit_language', 'commit messages')))
    const reason = String(decision(r.stdout).permissionDecisionReason)
    expect(reason).toContain('★ commit_style')
  })

  test('updating an existing rule file is not stopped', async () => {
    const r = await run(write(path.join(fb, 'test_mocking.md'), rule('test_mocking', 'Do not mock', 4)))
    expect(r.stdout.trim()).toBe('')
  })

  test('not stopped without existing rules, without a session id, or outside the feedback dirs', async () => {
    const empty = tmpDir()
    try {
      const io = makeIo({ projectDir: proj, cwd: proj, env: { CLAUDE_FEEDBACK_DIR: empty } })
      expect((await feedbackGuard(io, write(path.join(empty, 'first.md'), rule('first', 'x')))).stdout.trim()).toBe('')
    } finally {
      rmTree(empty)
    }
    const noSession = { tool_name: 'Write', tool_input: { file_path: path.join(fb, 'other.md'), content: rule('other', 'x') } }
    expect((await run(noSession)).stdout.trim()).toBe('')
    expect((await run(write(path.join(proj, 'README.md'), '# readme'))).stdout.trim()).toBe('')
    expect((await run(write(path.join(fb, 'sub', 'nested.md'), rule('nested', 'x')))).stdout.trim()).toBe('')
  })

  test('a heredoc that creates a rule file is checked like Write', async () => {
    const file = path.join(fb, 'mocking_policy.md')
    const command = `cat > ${file} <<'EOF'\n${rule('mocking_policy', 'mocking in tests')}EOF\n`
    const r = await run({ session_id: 'sess-new-rule-heredoc', tool_name: 'Bash', tool_input: { command }, cwd: proj })
    const hs = decision(r.stdout)
    expect(hs.permissionDecision).toBe('deny')
    expect(String(hs.permissionDecisionReason)).toContain('★ test_mocking')
  })

  test('english messages', async () => {
    const io = makeIo({ projectDir: proj, cwd: proj, env: { CLAUDE_FEEDBACK_DIR: fb }, lang: 'en' })
    const r = await feedbackGuard(io, write(path.join(fb, 'zzz.md'), rule('zzz', 'unrelated'), 'sess-new-rule-en'))
    const reason = String(decision(r.stdout).permissionDecisionReason)
    expect(reason).toContain('check the existing rules')
    expect(reason).toContain('raise its count by 1')
  })
})

describe('similarity', () => {
  test('ascii words share a 4-letter stem', () => {
    expect(similarityScore(similarityTokens('test_mocking'), similarityTokens('mock tests'))).toBeGreaterThanOrEqual(2)
    expect(similarityScore(similarityTokens('commit_style'), similarityTokens('tsconfig rootdir'))).toBe(0)
  })

  test('japanese text is compared by bigrams', () => {
    expect(similarityScore(similarityTokens('テストでモックを使わない'), similarityTokens('モックを避ける'))).toBeGreaterThanOrEqual(2)
  })
})
