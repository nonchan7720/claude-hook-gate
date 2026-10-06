import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { feedbackStopCheck } from '../src/feedback-stop-check.ts'
import type { Dict } from '../src/pyutil.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

describe('feedback-stop-check', () => {
  let feedbackDir: string
  let projectDir: string

  const runStopCheck = (payload: Dict = {}, sessionId = 'sess1') =>
    feedbackStopCheck(makeIo({ projectDir, env: { CLAUDE_FEEDBACK_DIR: feedbackDir } }), { session_id: sessionId, ...payload })

  const stateDir = () => path.join(projectDir, '.claude', '.gate-status')
  const touch = (name: string) => fs.writeFileSync(path.join(projectDir, name), '')
  const writeMemo = (...rels: string[]) => {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.writeFileSync(path.join(stateDir(), 'changed_files.sess1.txt'), rels.map((p) => `${p}\n`).join(''))
  }
  const writeAgentMemo = (sessionId: string, agentId: string, ...rels: string[]) => {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.writeFileSync(path.join(stateDir(), `changed_files.${sessionId}--${agentId}.txt`), rels.map((p) => `${p}\n`).join(''))
  }

  beforeEach(() => {
    feedbackDir = tmpDir()
    projectDir = tmpDir()
    const content = [
      '---',
      'name: readme_bilingual',
      'description: test',
      'type: feedback',
      'count: 4',
      'enforce:',
      '  - event: stop_check',
      "    changed: '**/README.md'",
      "    require_sibling: 'README_ja.md'",
      "    message: '日英併記のこと'",
      '    severity: block',
      '---',
      '',
      '本文',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(feedbackDir, 'readme_bilingual.md'), content, 'utf8')
  })

  afterEach(() => {
    rmTree(feedbackDir)
    rmTree(projectDir)
  })

  test('blocks when README_ja is missing', async () => {
    touch('README.md')
    writeMemo('README.md')
    const r = await runStopCheck()
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('readme_bilingual')
  })

  test('passes when README_ja is present', async () => {
    touch('README.md')
    touch('README_ja.md')
    writeMemo('README.md')
    expect((await runStopCheck()).exitCode).toBe(0)
  })

  test('no changed files passes', async () => {
    expect((await runStopCheck()).exitCode).toBe(0)
  })

  test('gives up after max attempts', async () => {
    touch('README.md')
    writeMemo('README.md')
    let r = await runStopCheck()
    for (let i = 0; i < 2; i++) r = await runStopCheck()
    // 3回連続ブロック後は諦めて exit 0 になる
    expect(r.exitCode).toBe(0)
  })

  test('agent_id from payload is used for changed files and attempts', async () => {
    touch('README.md')
    writeAgentMemo('sess1', 'agent1', 'README.md')
    const r = await runStopCheck({ agent_id: 'agent1' })
    expect(r.exitCode).toBe(2)
    expect(fs.existsSync(path.join(stateDir(), 'feedback_gate_attempts.sess1--agent1.txt'))).toBe(true)
    expect(fs.existsSync(path.join(stateDir(), 'feedback_gate_attempts.sess1.txt'))).toBe(false)
  })

  test('main stop picks up agent suffixed memo via merge', async () => {
    touch('README.md')
    writeAgentMemo('sess1', 'agent1', 'README.md')
    const r = await runStopCheck()
    expect(r.exitCode).toBe(2)
    expect(fs.existsSync(path.join(stateDir(), 'feedback_gate_attempts.sess1.txt'))).toBe(true)
  })

  test('blocking emits block json with reason and attempt count', async () => {
    touch('README.md')
    writeMemo('README.md')
    const r = await runStopCheck()
    expect(r.exitCode).toBe(2)
    const payload = JSON.parse(r.stdout) as Dict
    expect(payload.decision).toBe('block')
    expect(payload.reason).toContain('readme_bilingual')
    expect(payload.reason).toContain('試行')
  })

  test('stdout is exactly one json object', async () => {
    touch('README.md')
    writeMemo('README.md')
    const r = await runStopCheck()
    expect(r.exitCode).toBe(2)
    expect(r.stdout.trim().split('\n').length).toBe(1)
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  })

  test('success stdout has no block json', async () => {
    touch('README.md')
    touch('README_ja.md')
    writeMemo('README.md')
    const r = await runStopCheck()
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  test('max attempts giveup has no block json', async () => {
    touch('README.md')
    writeMemo('README.md')
    let r = await runStopCheck()
    for (let i = 0; i < 2; i++) r = await runStopCheck()
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  test('warn only violation has no block json', async () => {
    const content = [
      '---',
      'name: warn_rule',
      'description: test',
      'type: feedback',
      'count: 1',
      'enforce:',
      '  - event: stop_check',
      "    changed: '**/*.txt'",
      "    check: 'false'",
      "    message: 'warn only'",
      '    severity: warn',
      '---',
      '',
      '本文',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(feedbackDir, 'warn_rule.md'), content, 'utf8')
    touch('x.txt')
    writeMemo('x.txt')
    const r = await runStopCheck()
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('')
    expect(r.stderr).toContain('warn_rule')
  })

  test('never fails hard on a missing feedback directory or an empty payload', async () => {
    const io = makeIo({ projectDir, env: { CLAUDE_FEEDBACK_DIR: path.join(os.tmpdir(), 'no-such-feedback-dir') } })
    const r = await feedbackStopCheck(io, {})
    expect(r.exitCode).toBe(0)
  })
})
