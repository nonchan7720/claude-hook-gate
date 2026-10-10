import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { feedbackInject } from '../src/feedback-inject.ts'
import type { Lang } from '../src/i18n.ts'
import { makeIo, withTmp } from './helpers/node-io.ts'

const runInject = (feedbackDir: string, lang?: Lang) => feedbackInject(makeIo({ projectDir: feedbackDir, env: { CLAUDE_FEEDBACK_DIR: feedbackDir }, lang }))

function writeRule(dir: string, name: string, count: number, description = 'desc', extra = ''): void {
  const content = `---\nname: ${name}\ndescription: ${description}\ntype: feedback\ncount: ${count}\n${extra}---\n\n${name} の本文の第一段落。ここが注入される。\n\n**Why:** 理由の説明。\n`
  fs.writeFileSync(path.join(dir, `${name}.md`), content, 'utf8')
}

describe('feedback-inject', () => {
  test('only count >= 3 is included', () =>
    withTmp(async (tmp) => {
      writeRule(tmp, 'high', 5)
      writeRule(tmp, 'low', 1)
      const r = await runInject(tmp)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('high')
      expect(r.stdout).not.toContain('low')
    }))

  test('the header and the rule titles follow the language', () =>
    withTmp(async (tmp) => {
      writeRule(tmp, 'high', 5)
      const ja = await runInject(tmp, 'ja')
      expect(ja.stdout.startsWith('# 確定フィードバックルール（count >= 3）\n')).toBe(true)
      expect(ja.stdout).toContain('■ high (これまで 5 回指摘されています)')
      const en = await runInject(tmp, 'en')
      expect(
        en.stdout.startsWith(
          '# Confirmed feedback rules (count >= 3)\nThese rules were pointed out repeatedly and are confirmed. A hook blocks violations.\n\n',
        ),
      ).toBe(true)
      expect(en.stdout).toContain('■ high (pointed out 5 times so far)')
      expect(en.stdout).toContain('high の本文の第一段落')
    }))

  test('sorted by count desc then name asc', () =>
    withTmp(async (tmp) => {
      writeRule(tmp, 'bbb', 3)
      writeRule(tmp, 'aaa', 3)
      writeRule(tmp, 'zzz', 6)
      const r = await runInject(tmp)
      const posZzz = r.stdout.indexOf('zzz')
      const posAaa = r.stdout.indexOf('aaa')
      const posBbb = r.stdout.indexOf('bbb')
      expect(posZzz).toBeGreaterThanOrEqual(0)
      expect(posZzz).toBeLessThan(posAaa)
      expect(posAaa).toBeLessThan(posBbb)
    }))

  test('all rules output in full even over 3000 chars', () =>
    withTmp(async (tmp) => {
      for (let i = 0; i < 80; i++) writeRule(tmp, `rule_${String(i).padStart(3, '0')}`, 3, 'あ'.repeat(80))
      const r = await runInject(tmp)
      expect(r.stdout.length).toBeGreaterThan(3000)
      for (let i = 0; i < 80; i++) {
        const name = `rule_${String(i).padStart(3, '0')}`
        expect(r.stdout).toContain(name)
        expect(r.stdout).toContain('あ'.repeat(80))
        expect(r.stdout).toContain(`${name} の本文の第一段落。ここが注入される。`)
      }
    }))

  test('no rules produces no output', () =>
    withTmp(async (tmp) => {
      writeRule(tmp, 'low', 1)
      const r = await runInject(tmp)
      expect(r.exitCode).toBe(0)
      expect(r.stdout.trim()).toBe('')
    }))

  test('injects count >= 3 rules from the project .claude/feedback directory', () =>
    withTmp(async (tmp) => {
      const globalDir = path.join(tmp, 'global')
      const projectDir = path.join(tmp, 'project')
      const projectFeedback = path.join(projectDir, '.claude', 'feedback')
      fs.mkdirSync(globalDir, { recursive: true })
      fs.mkdirSync(projectFeedback, { recursive: true })
      writeRule(projectFeedback, 'proj_high', 4)
      writeRule(projectFeedback, 'proj_low', 1)
      const r = await feedbackInject(makeIo({ projectDir, env: { CLAUDE_FEEDBACK_DIR: globalDir } }))
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('proj_high')
      expect(r.stdout).not.toContain('proj_low')
    }))

  test('expired rules are not injected', () =>
    withTmp(async (tmp) => {
      writeRule(tmp, 'fresh', 4, 'desc', 'expires: 2999-12-31\n')
      writeRule(tmp, 'stale', 4, 'desc', 'expires: 2020-01-01\n')
      const r = await runInject(tmp)
      expect(r.stdout).toContain('fresh')
      expect(r.stdout).not.toContain('stale')
    }))

  test('never fails hard when the feedback directory does not exist', async () => {
    const r = await runInject('/no/such/feedback/dir')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('')
  })
})
