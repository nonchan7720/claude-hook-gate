import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  aggregateViolations as aggregate,
  applyCountBumps,
  buildContext,
  buildProposals,
  correctCommand,
  formatReport,
  type Proposal,
  parseCorrectArgs,
  readViolations,
  type ViolationEntry,
} from '../src/correct.ts'
import type { Rule } from '../src/feedback-rules.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-09T00:00:00.000Z')
const ago = (days: number) => new Date(NOW - days * DAY).toISOString().replace('Z', '+00:00')

const entry = (rule: string, days: number, over: Partial<ViolationEntry> = {}): ViolationEntry => ({
  ts: ago(days),
  rule,
  count: 1,
  severity: 'warn',
  event: 'pre_bash',
  detail: '',
  ...over,
})

const rule = (name: string, count: number, over: Partial<Rule> = {}): Rule => ({
  name,
  description: '',
  count,
  enforce: [],
  path: `/fb/${name}.md`,
  projects: [],
  whenExists: [],
  ...over,
})
const withEnforce = { enforce: [{ event: 'pre_bash', when: 'x' }] }
const opts = { window: 30 * DAY, min: 2, now: NOW }

describe('parseCorrectArgs', () => {
  test('defaults', () => {
    expect(parseCorrectArgs('')).toEqual({ window: 30 * DAY, apply: false, min: 2 })
  })
  test('--window 7d / 12h', () => {
    expect(parseCorrectArgs('--window 7d').window).toBe(7 * DAY)
    expect(parseCorrectArgs('--window 12h').window).toBe(12 * 3_600_000)
  })
  test('--min and apply', () => {
    expect(parseCorrectArgs('--min 3 apply')).toEqual({ window: 30 * DAY, apply: true, min: 3 })
  })
  test('unknown tokens and invalid values are ignored', () => {
    expect(parseCorrectArgs('foo --window xyz --min 0 --bar apply')).toEqual({ window: 30 * DAY, apply: true, min: 2 })
  })
})

describe('aggregateViolations', () => {
  test('counts in-window and out-of-window separately', () => {
    const stats = aggregate([entry('a', 1), entry('a', 5), entry('a', 60), entry('b', 100)], NOW, 30 * DAY)
    expect(stats.get('a')).toMatchObject({ total: 3, inWindow: 2, lastTs: ago(1) })
    expect(stats.get('b')).toMatchObject({ total: 1, inWindow: 0 })
  })
  test('groups by severity and event and picks the most frequent detail', () => {
    const stats = aggregate(
      [
        entry('a', 1, { severity: 'ask', event: 'pre_edit', detail: 'x' }),
        entry('a', 2, { severity: 'ask', event: 'pre_edit', detail: 'y' }),
        entry('a', 3, { severity: 'warn', event: 'pre_bash', detail: 'y' }),
        entry('a', 90, { severity: 'deny', event: 'stop_check', detail: 'z' }),
      ],
      NOW,
      30 * DAY,
    )
    const s = stats.get('a')
    expect(s?.bySeverity).toEqual({ ask: 2, warn: 1 })
    expect(s?.byEvent).toEqual({ pre_edit: 2, pre_bash: 1 })
    expect(s?.topDetail).toBe('y')
  })
})

describe('readViolations', () => {
  test('skips broken lines and returns [] when the log is missing', async () => {
    const dir = tmpDir()
    try {
      const io = makeIo({ projectDir: dir, env: { CLAUDE_FEEDBACK_DIR: dir } })
      expect(await readViolations(io)).toEqual([])
      fs.writeFileSync(
        path.join(dir, '.violations.jsonl'),
        `${JSON.stringify(entry('a', 1))}\nnot json\n\n[1]\n{"no":"rule"}\n${JSON.stringify(entry('b', 2))}\n`,
      )
      expect((await readViolations(io)).map((e) => e.rule)).toEqual(['a', 'b'])
    } finally {
      rmTree(dir)
    }
  })
})

describe('buildProposals', () => {
  const stats = (entries: ViolationEntry[]) => aggregate(entries, NOW, 30 * DAY)
  const kinds = (ps: Proposal[]) => ps.map((p) => `${p.kind}:${p.rule}`)

  test('count 2 with 2 violations bumps to 3', () => {
    const ps = buildProposals([rule('a', 2)], [], stats([entry('a', 1), entry('a', 2)]), opts)
    expect(ps).toMatchObject([{ kind: 'bump', rule: 'a', from: 2, to: 3 }])
  })
  test('a single violation (below min) proposes nothing', () => {
    expect(buildProposals([rule('a', 2)], [], stats([entry('a', 1)]), opts)).toEqual([])
  })
  test('violations outside the window do not count', () => {
    expect(buildProposals([rule('a', 2)], [], stats([entry('a', 40), entry('a', 50)]), opts)).toEqual([])
  })
  test('count 3 with 2 ask violations bumps to 5', () => {
    const ps = buildProposals([rule('a', 3, withEnforce)], [], stats([entry('a', 1, { severity: 'ask' }), entry('a', 2, { severity: 'block' })]), opts)
    expect(ps).toMatchObject([{ kind: 'bump', from: 3, to: 5 }])
  })
  test('count 3 with only warn violations is not bumped', () => {
    expect(buildProposals([rule('a', 3, withEnforce)], [], stats([entry('a', 1), entry('a', 2)]), opts)).toEqual([])
  })
  test('count 5 proposes nothing', () => {
    const e = [entry('a', 1, { severity: 'deny' }), entry('a', 2, { severity: 'deny' })]
    expect(buildProposals([rule('a', 5, withEnforce)], [], stats(e), opts)).toEqual([])
  })
  test('count 3 without enforce proposes enforce with a template', () => {
    const ps = buildProposals([rule('a', 3)], [], stats([]), opts)
    expect(ps).toMatchObject([{ kind: 'enforce', rule: 'a' }])
    const p = ps[0]
    const template = p?.kind === 'enforce' ? p.template : ''
    for (const ev of ['pre_bash', 'pre_edit', 'post_edit', 'stop_check']) expect(template).toContain(`event: ${ev}`)
  })
  test('count 2 without enforce proposes nothing', () => {
    expect(buildProposals([rule('a', 2)], [], stats([]), opts)).toEqual([])
  })
  test('inactive rules propose expired with the reason', () => {
    const expired = rule('old', 3, { expires: NOW - DAY })
    const scoped = rule('scoped', 3, { projects: ['~/x/**'] })
    const ps = buildProposals([], [expired, scoped], stats([]), opts)
    expect(kinds(ps)).toEqual(['expired:old', 'expired:scoped'])
    expect(ps[0]?.reason).toContain('expires')
    expect(ps[1]?.reason).toContain('projects')
  })
  test('count 3 with enforce and zero violations ever is stale', () => {
    expect(kinds(buildProposals([rule('a', 3, withEnforce)], [], stats([]), opts))).toEqual(['stale:a'])
  })
  test('a rule with only old violations is not stale', () => {
    expect(buildProposals([rule('a', 3, withEnforce)], [], stats([entry('a', 90)]), opts)).toEqual([])
  })
  test('ordering: bump (to desc, violations desc) → enforce → stale → expired', () => {
    const rules = [rule('stale', 4, withEnforce), rule('noenf', 3), rule('b3', 1), rule('b3more', 2), rule('b5', 4, withEnforce)]
    const e = [
      entry('b3', 1),
      entry('b3', 2),
      entry('b3more', 1),
      entry('b3more', 2),
      entry('b3more', 3),
      entry('b5', 1, { severity: 'ask' }),
      entry('b5', 2, { severity: 'ask' }),
    ]
    const ps = buildProposals(rules, [rule('gone', 3, { expires: NOW - DAY })], stats(e), opts)
    expect(kinds(ps)).toEqual(['bump:b5', 'bump:b3more', 'bump:b3', 'enforce:noenf', 'stale:stale', 'expired:gone'])
  })
})

describe('formatReport / buildContext', () => {
  test('no proposals', () => {
    const text = formatReport([], new Map(), { window: 30 * DAY }, 4)
    expect(text.startsWith('[correct] 直近 30d: ルール 4 件 / 違反 0 件')).toBe(true)
    expect(text).toContain('提案はありません。')
    expect(buildContext([], [])).toEqual([])
  })
  test('lists proposals and the apply hint; with apply lists the changed files', () => {
    const ps = buildProposals([rule('a', 2)], [], aggregate([entry('a', 1), entry('a', 2)], NOW, 30 * DAY), opts)
    const text = formatReport(ps, aggregate([entry('a', 1), entry('a', 2)], NOW, 30 * DAY), { window: 30 * DAY }, 1)
    expect(text).toContain('違反 2 件')
    expect(text).toContain('[bump] a: count 2 → 3')
    expect(text).toContain('/correct apply')
    const applied = [{ path: '/fb/a.md', from: 2, to: 3 }]
    const after = formatReport(ps, new Map(), { window: 7 * DAY, apply: true }, 1, applied)
    expect(after).toContain('直近 7d')
    expect(after).toContain('/fb/a.md (count 2 → 3)')
    const ctx = buildContext(ps, applied)
    expect(ctx).toHaveLength(1)
    expect(ctx[0]).toContain('確認')
    expect(ctx[0]).toContain('/fb/a.md')
  })
})

const writeFeedback = (dir: string, name: string, count: number, extra = '', body = `本文。\ncount: 9 という文字列。\n`) => {
  const p = path.join(dir, `${name}.md`)
  fs.writeFileSync(p, `---\nname: ${name}\ndescription: desc\ntype: feedback\ncount: ${count}\n${extra}---\n\n${body}`)
  return p
}

describe('applyCountBumps', () => {
  test('rewrites only the frontmatter count line', async () => {
    const dir = tmpDir()
    try {
      const io = makeIo({ projectDir: dir })
      const p = writeFeedback(dir, 'a', 2)
      const before = fs.readFileSync(p, 'utf8')
      const applied = await applyCountBumps(io, [{ kind: 'bump', rule: 'a', path: p, from: 2, to: 3, reason: '' }])
      expect(applied).toEqual([{ path: p, from: 2, to: 3 }])
      expect(fs.readFileSync(p, 'utf8')).toBe(before.replace('count: 2\n', 'count: 3\n'))
      expect(fs.readFileSync(p, 'utf8')).toContain('count: 9 という文字列。')
    } finally {
      rmTree(dir)
    }
  })
  test('skips non-bump proposals and files whose count differs from the proposal', async () => {
    const dir = tmpDir()
    try {
      const io = makeIo({ projectDir: dir })
      const p = writeFeedback(dir, 'a', 4)
      const applied = await applyCountBumps(io, [
        { kind: 'bump', rule: 'a', path: p, from: 2, to: 3, reason: '' },
        { kind: 'stale', rule: 'a', path: p, reason: '' },
      ])
      expect(applied).toEqual([])
      expect(fs.readFileSync(p, 'utf8')).toContain('count: 4\n')
    } finally {
      rmTree(dir)
    }
  })
})

describe('correctCommand', () => {
  const setup = async (body: (ctx: { io: ReturnType<typeof makeIo>; global: string; proj: string }) => Promise<void>) => {
    const proj = tmpDir()
    const global = tmpDir()
    try {
      fs.mkdirSync(path.join(proj, '.claude', 'feedback'), { recursive: true })
      const io = makeIo({ projectDir: proj, env: { CLAUDE_FEEDBACK_DIR: global, HOME: tmpDir() }, now: () => NOW })
      await body({ io, global, proj })
    } finally {
      rmTree(proj)
      rmTree(global)
    }
  }
  const log = (dir: string, entries: ViolationEntry[]) =>
    fs.writeFileSync(path.join(dir, '.violations.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'))

  test('reports proposals from rules and the violation log without writing', async () => {
    await setup(async ({ io, global, proj }) => {
      const a = writeFeedback(global, 'a', 2)
      writeFeedback(path.join(proj, '.claude', 'feedback'), 'noenf', 3)
      writeFeedback(global, 'old', 3, 'expires: 2020-01-01\n')
      log(global, [entry('a', 1, { detail: 'git push --force' }), entry('a', 2)])
      const before = fs.readFileSync(a, 'utf8')
      const r = await correctCommand(io, '')
      expect(r.text.startsWith('[correct] 直近 30d: ルール 2 件 / 違反 2 件')).toBe(true)
      expect(r.text).toContain('[bump] a: count 2 → 3')
      expect(r.text).toContain('[enforce] noenf')
      expect(r.text).toContain('[expired] old')
      expect(r.context).toHaveLength(1)
      expect(fs.readFileSync(a, 'utf8')).toBe(before)
    })
  })

  test('apply rewrites the count', async () => {
    await setup(async ({ io, global }) => {
      const a = writeFeedback(global, 'a', 2)
      log(global, [entry('a', 1), entry('a', 2)])
      const r = await correctCommand(io, 'apply')
      expect(fs.readFileSync(a, 'utf8')).toContain('count: 3\n')
      expect(r.text).toContain(a)
      expect(r.context[0]).toContain(a)
    })
  })

  test('does not fail without a log or rules', async () => {
    await setup(async ({ io }) => {
      const r = await correctCommand(io, '--window 7d --min 3')
      expect(r.text).toBe(
        '[correct] 直近 7d: ルール 0 件 / 違反 0 件\n提案はありません。\n`/correct apply` で bump の count 引き上げをファイルに書き込みます（enforce は提案のみ）。',
      )
      expect(r.context).toEqual([])
    })
  })

  test('swallows exceptions into an internal error text', async () => {
    const io = { ...makeIo({ projectDir: '/nonexistent' }), now: async () => Promise.reject(new Error('boom')) }
    const r = await correctCommand(io, '')
    expect(r.text).toBe('[correct] internal error: boom')
  })
})
