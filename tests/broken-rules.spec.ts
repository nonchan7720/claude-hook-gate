// 壊れた feedback ルール（YAML として読めない・不正な正規表現・enforce がリストでない／要素が辞書でない）が、
// 他の正常なルールまで無効にしないこと、そしてその不備が .errors.jsonl・注入・/correct で見えること。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { correctCommand } from '../src/correct.ts'
import { feedbackGuard } from '../src/feedback-guard.ts'
import { feedbackInject } from '../src/feedback-inject.ts'
import { feedbackPostEdit } from '../src/feedback-post-edit.ts'
import {
  errorsLogPath,
  evalPostEdit,
  evalPreBash,
  evalPreEdit,
  evalStopCheck,
  listRules,
  normalizeEnforce,
  type Rule,
  scanRules,
} from '../src/feedback-rules.ts'
import { feedbackStopCheck } from '../src/feedback-stop-check.ts'
import type { Lang } from '../src/i18n.ts'
import type { Io } from '../src/io.ts'
import { type Dict, pyRegExp } from '../src/pyutil.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

const ruleText = (name: string, count: number, body: string) => `---\nname: ${name}\ndescription: d\ntype: feedback\ncount: ${count}\n${body}---\n\n本文\n`

const CD = ruleText('delegate_no_cd_in_bash', 6, "enforce:\n  - event: pre_bash\n    when: '(^|[;&|]\\s*)cd\\s'\n    message: no cd\n    severity: deny\n")

// 壊れ方ごとの、同じディレクトリに置く別ファイル（ファイル名は cd.md より前に読まれる aa_ / 後に読まれる zz_ を混ぜる）。
const BROKEN: Record<string, [string, string]> = {
  'YAML syntax error': ['zz_yaml.md', ruleText('zz_yaml', 3, "enforce:\n  - event: pre_bash\n    when: 'it's'\n    message: x\n")],
  'inline flag mid-pattern x(?i)y': [
    'aa_flag.md',
    ruleText('aa_flag', 6, "enforce:\n  - event: pre_bash\n    when: 'go\\s+test(?i)\\s'\n    message: x\n    severity: deny\n"),
  ],
  'possessive quantifier a*+': [
    'aa_poss.md',
    ruleText('aa_poss', 6, "enforce:\n  - event: pre_bash\n    when: 'cd'\n    unless: 'x*+'\n    message: x\n    severity: deny\n"),
  ],
  'comment group (?#...)': ['aa_comment.md', ruleText('aa_comment', 6, "enforce:\n  - event: pre_bash\n    when: 'cd(?#comment)'\n    message: x\n")],
  'recursive group (?P>n)': ['aa_rec.md', ruleText('aa_rec', 6, "enforce:\n  - event: pre_bash\n    when: '(?P<n>a)(?P>n)'\n    message: x\n")],
  'verbose flag (?x)': ['aa_verbose.md', ruleText('aa_verbose', 6, "enforce:\n  - event: pre_bash\n    when: '(?x) c d'\n    message: x\n")],
  'enforce: [null]': ['aa_null.md', ruleText('aa_null', 6, 'enforce:\n  -\n')],
  'enforce is a mapping': ['aa_dict.md', ruleText('aa_dict', 6, 'enforce:\n  event: pre_bash\n  when: rm\n')],
  'enforce is a string': ['aa_str.md', ruleText('aa_str', 6, 'enforce: pre_bash\n')],
}

describe('broken rules do not disable the other rules', () => {
  let dir: string
  let proj: string
  beforeEach(() => {
    dir = tmpDir()
    proj = tmpDir()
    fs.writeFileSync(path.join(dir, 'cd.md'), CD)
  })
  afterEach(() => {
    rmTree(dir)
    rmTree(proj)
  })
  const io = (lang?: Lang) => makeIo({ projectDir: proj, env: { CLAUDE_FEEDBACK_DIR: dir }, lang })
  const guard = (command: string) => feedbackGuard(io(), { tool_name: 'Bash', tool_input: { command } })
  const errors = (): Dict[] => {
    const p = path.join(dir, '.errors.jsonl')
    if (!fs.existsSync(p)) return []
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Dict)
  }

  for (const [label, [file, content]] of Object.entries(BROKEN)) {
    test(`${label}: the deny rule still denies, the violation is logged and the broken file is recorded`, async () => {
      fs.writeFileSync(path.join(dir, file), content)
      const r = await guard('cd /proj/sub && golangci-lint run')
      expect(r.exitCode).toBe(0)
      expect(r.stderr).not.toContain('internal error')
      const out = JSON.parse(r.stdout) as { hookSpecificOutput: Dict }
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain('delegate_no_cd_in_bash')
      expect(fs.readFileSync(path.join(dir, '.violations.jsonl'), 'utf8')).toContain('delegate_no_cd_in_bash')
      const logged = errors()
      expect(logged).toHaveLength(1)
      expect(logged[0]?.source).toBe('rules')
      expect(logged[0]?.file).toBe(path.join(dir, file))
      expect(String(logged[0]?.error)).not.toBe('')
      // 無関係なコマンドは通す
      expect((await guard('ls')).stdout).toBe('')
    })
  }

  test('the same broken rule is recorded only once in .errors.jsonl', async () => {
    fs.writeFileSync(path.join(dir, 'zz_yaml.md'), BROKEN['YAML syntax error']?.[1] ?? '')
    await guard('ls')
    await guard('ls')
    await listRules(io())
    expect(errors()).toHaveLength(1)
    expect(errorsLogPath(io())).toBe(path.join(dir, '.errors.jsonl'))
  })

  test('scanRules returns the file and the reason, and keeps the valid entries of a partly broken rule', async () => {
    fs.writeFileSync(path.join(dir, 'zz_yaml.md'), BROKEN['YAML syntax error']?.[1] ?? '')
    fs.writeFileSync(
      path.join(dir, 'mixed.md'),
      ruleText('mixed', 6, "enforce:\n  -\n  - event: pre_bash\n    when: 'a*+'\n  - event: pre_bash\n    when: 'rm -rf'\n    severity: deny\n"),
    )
    const { rules, broken } = await scanRules(io())
    expect(rules.map((r) => r.name).sort()).toEqual(['delegate_no_cd_in_bash', 'mixed'])
    expect(rules.find((r) => r.name === 'mixed')?.enforce).toEqual([{ event: 'pre_bash', when: 'rm -rf', severity: 'deny' }])
    expect(broken.map((b) => path.basename(b.path))).toEqual(['zz_yaml.md', 'mixed.md', 'mixed.md'])
    expect(broken[0]?.reason).toStartWith('ファイルを読めません: ')
    expect(broken[1]?.reason).toBe('enforce[0] が辞書ではありません（null）')
    expect(broken[2]?.reason).toStartWith('enforce[1].when の正規表現が使えません: ')
    const v = await evalPreBash(io(), rules, 'rm -rf x')
    expect(v.map((x) => x.rule)).toEqual(['mixed'])
  })

  test('UserPromptSubmit injects the broken rules (ja / en), even without confirmed rules', async () => {
    fs.rmSync(path.join(dir, 'cd.md'))
    fs.writeFileSync(path.join(dir, 'zz_yaml.md'), BROKEN['YAML syntax error']?.[1] ?? '')
    const ja = await feedbackInject(io('ja'))
    expect(ja.stdout).toContain('次のルールファイルが読めず無効になっています')
    expect(ja.stdout).toContain(`- ${path.join(dir, 'zz_yaml.md')}: ファイルを読めません: `)
    expect(ja.stdout).not.toContain('確定フィードバックルール')
    const en = await feedbackInject(io('en'))
    expect(en.stdout).toContain('The following rule files could not be read and are disabled')
    expect(en.stdout).toContain(`- ${path.join(dir, 'zz_yaml.md')}: cannot read the file: `)
  })

  test('UserPromptSubmit puts the broken rules before the confirmed rules, and says nothing when nothing is broken', async () => {
    const clean = await feedbackInject(io())
    expect(clean.stdout).not.toContain('読めず無効')
    fs.writeFileSync(path.join(dir, 'aa_null.md'), BROKEN['enforce: [null]']?.[1] ?? '')
    const r = await feedbackInject(io())
    const brokenAt = r.stdout.indexOf('読めず無効')
    expect(brokenAt).toBeGreaterThanOrEqual(0)
    expect(brokenAt).toBeLessThan(r.stdout.indexOf('■ delegate_no_cd_in_bash'))
    expect(r.stdout).toContain(`- ${path.join(dir, 'aa_null.md')}: enforce[0] が辞書ではありません（null）`)
  })

  test('/correct reports the broken rules as proposals', async () => {
    fs.writeFileSync(path.join(dir, 'aa_dict.md'), BROKEN['enforce is a mapping']?.[1] ?? '')
    const r = await correctCommand(makeIo({ projectDir: proj, env: { CLAUDE_FEEDBACK_DIR: dir, HOME: proj } }), '')
    expect(r.text).toContain('- [broken] aa_dict')
    expect(r.text).toContain('読めず無効になっている: enforce がリストではありません（mapping）')
    expect(r.text).toContain(path.join(dir, 'aa_dict.md'))
    expect(r.context).toHaveLength(1)
  })

  test('post_edit and stop_check rules keep working next to a broken file', async () => {
    fs.writeFileSync(path.join(dir, 'zz_yaml.md'), BROKEN['YAML syntax error']?.[1] ?? '')
    fs.writeFileSync(path.join(dir, 'aa_null.md'), BROKEN['enforce: [null]']?.[1] ?? '')
    fs.writeFileSync(
      path.join(dir, 'no_log.md'),
      ruleText('no_log', 6, "enforce:\n  - event: post_edit\n    path: '**/*.ts'\n    when: 'console\\.log'\n    message: no log\n"),
    )
    fs.writeFileSync(
      path.join(dir, 'readme.md'),
      ruleText('readme', 6, "enforce:\n  - event: stop_check\n    changed: '**/README.md'\n    require_sibling: 'README_ja.md'\n    message: both\n"),
    )
    const ts = path.join(proj, 'a.ts')
    fs.writeFileSync(ts, 'console.log(1)\n')
    const pe = await feedbackPostEdit(io(), { tool_name: 'Edit', tool_input: { file_path: ts } })
    expect(pe.stdout).toContain('"decision":"block"')
    fs.writeFileSync(path.join(proj, 'README.md'), '')
    fs.mkdirSync(path.join(proj, '.claude', '.gate-status'), { recursive: true })
    fs.writeFileSync(path.join(proj, '.claude', '.gate-status', 'changed_files.s1.txt'), 'README.md\n')
    const sc = await feedbackStopCheck(io(), { session_id: 's1' })
    expect(sc.exitCode).toBe(2)
    expect(sc.stderr).toContain('readme')
  })
})

describe('enforce entries that throw while evaluating are skipped one by one', () => {
  // listRules を通さずに作った Rule（検証されていない enforce）でも、評価関数が例外で止まらないこと。
  const raw = (name: string, enforce: unknown): Rule =>
    ({ name, count: 6, description: '', enforce, path: `/fb/${name}.md`, projects: [], whenExists: [] }) as Rule
  let dir: string
  beforeEach(() => {
    dir = tmpDir()
  })
  afterEach(() => rmTree(dir))
  const io = (): Io => makeIo({ projectDir: dir, env: { CLAUDE_FEEDBACK_DIR: dir } })

  test('evalPreBash / evalPreEdit / evalPostEdit / evalStopCheck', async () => {
    const bad = raw('bad', [
      null,
      'pre_bash',
      { event: 'pre_bash', when: 'x(?i)y' },
      { event: 'pre_edit', path: '**', when: 'a*+' },
      { event: 'post_edit', path: '**', when: '(?#c)' },
      { event: 'stop_check', changed: [null], check: 'exit 1' },
    ])
    const notList = raw('not_list', { event: 'pre_bash', when: 'rm' })
    const good = raw('good', [
      { event: 'pre_bash', when: 'rm' },
      { event: 'pre_edit', path: '**', when: 'rm' },
      { event: 'post_edit', path: '**', when: 'rm' },
      { event: 'stop_check', changed: '**', check: 'exit 1' },
    ])
    const rules = [bad, notList, good]
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'rm\n')
    expect((await evalPreBash(io(), rules, 'rm x')).map((v) => v.rule)).toEqual(['good'])
    expect((await evalPreEdit(io(), rules, file, 'rm')).map((v) => v.rule)).toEqual(['good'])
    expect((await evalPostEdit(io(), rules, file)).map((v) => v.rule)).toEqual(['good'])
    expect((await evalStopCheck(io(), rules, dir, ['a.txt'])).map((v) => v.rule)).toEqual(['good'])
    const log = fs.readFileSync(path.join(dir, '.errors.jsonl'), 'utf8')
    expect(log).toContain('"source":"enforce"')
    expect(log).toContain('"file":"/fb/bad.md"')
    expect(log).toContain('enforce[2] の評価に失敗しました')
    expect(log).toContain('enforce[3] の評価に失敗しました')
    expect(log).toContain('enforce[4] の評価に失敗しました')
    expect(log).toContain('enforce[5] の評価に失敗しました')
  })
})

describe('normalizeEnforce', () => {
  const io = makeIo({ projectDir: '/tmp', lang: 'en' })
  test('empty values are no entries and no problems', () => {
    for (const v of [undefined, null, '', [], {}]) expect(normalizeEnforce(io, v)).toEqual({ enforce: [], problems: [] })
  })
  test('a non-list is dropped with a reason', () => {
    expect(normalizeEnforce(io, { event: 'pre_bash' })).toEqual({
      enforce: [],
      problems: ['enforce is not a list (mapping). Write each entry as `- event: ...`'],
    })
    expect(normalizeEnforce(io, 'x').problems).toEqual(['enforce is not a list (string). Write each entry as `- event: ...`'])
  })
  test('non-mapping entries and bad regexes are dropped, the rest is kept', () => {
    const r = normalizeEnforce(io, [
      null,
      ['x'],
      { event: 'pre_bash', when: 'ok' },
      { event: 'pre_edit', path: '*', unless: '(?x) a' },
      // stop_check は when / unless を使わないので検査しない
      { event: 'stop_check', changed: '*', when: 'a*+' },
    ])
    expect(r.enforce).toEqual([
      { event: 'pre_bash', when: 'ok' },
      { event: 'stop_check', changed: '*', when: 'a*+' },
    ])
    expect(r.problems).toEqual([
      'enforce[0] is not a mapping (null)',
      'enforce[1] is not a mapping (list)',
      'enforce[3].unless is not a usable regular expression: unsupported Python inline flag (?x): (?x) a',
    ])
  })
})

describe('pyRegExp: Python-only anchors and flags', () => {
  test('\\A / \\Z / \\z match only at the start / end of the whole string, also with the m flag', () => {
    expect(pyRegExp('\\Afoo', 'm').test('foo\nbar')).toBe(true)
    expect(pyRegExp('\\Afoo', 'm').test('bar\nfoo')).toBe(false)
    expect(pyRegExp('foo\\Z', 'm').test('bar\nfoo')).toBe(true)
    expect(pyRegExp('foo\\Z', 'm').test('foo\nbar')).toBe(false)
    expect(pyRegExp('foo\\z').test('foo')).toBe(true)
    expect(pyRegExp('\\AA\\Z').test('A')).toBe(true)
    // JS のままだと \A は "A"、\Z は "Z" に一致してしまう
    expect(pyRegExp('x\\Ay').test('xAy')).toBe(false)
  })
  test('escaped backslashes and character classes are left alone', () => {
    expect(pyRegExp('a\\\\Ab').test('a\\Ab')).toBe(true)
    expect(pyRegExp('[]a]').test(']')).toBe(true)
    expect(pyRegExp('[^]a]').test(']')).toBe(false)
    expect(pyRegExp('[^]a]').test('b')).toBe(true)
  })
  test('(?x) and invalid patterns throw', () => {
    expect(() => pyRegExp('(?x) a b')).toThrow('(?x)')
    expect(() => pyRegExp('(?ix)a')).toThrow('(?x)')
    for (const p of ['x(?i)y', 'a*+', '(?#c)', '(?P>n)']) expect(() => pyRegExp(p)).toThrow()
  })
})

describe('normalizeEnforce: scope / lang', () => {
  const norm = (lang: Lang, entries: Dict[]) => normalizeEnforce(makeIo({ projectDir: process.cwd(), lang }), entries)
  const ok: Dict = { event: 'post_edit', path: 'a', when: 'x', scope: 'comments', lang: 'ts' }

  test('valid scope / lang are kept', () => {
    const r = norm('en', [ok, { event: 'pre_edit', path: 'a', when: 'x', scope: 'code' }, { event: 'post_edit', path: 'a', when: 'x', scope: 'all' }])
    expect(r.enforce).toHaveLength(3)
    expect(r.problems).toEqual([])
  })

  test('invalid scope, unknown lang and scope on pre_bash / stop_check are dropped with a reason', () => {
    const r = norm('en', [
      { ...ok, scope: 'comment' },
      { ...ok, lang: 'cobol' },
      { event: 'pre_bash', when: 'x', scope: 'code' },
      { event: 'stop_check', changed: '*', scope: 'comments' },
      { event: 'pre_bash', when: 'x', lang: 'ts' },
      { ...ok, scope: 5 },
      ok,
    ])
    expect(r.enforce).toEqual([ok])
    expect(r.problems).toEqual([
      'enforce[0].scope must be one of all / comments / strings / code (comment)',
      'enforce[1].lang is not a known language id (cobol)',
      'enforce[2]: scope cannot be used with pre_bash (pre_edit / post_edit only)',
      'enforce[3]: scope cannot be used with stop_check (pre_edit / post_edit only)',
      'enforce[4]: lang cannot be used with pre_bash (pre_edit / post_edit only)',
      'enforce[5].scope must be one of all / comments / strings / code (5)',
    ])
  })

  test('Japanese messages exist', () => {
    const r = norm('ja', [{ ...ok, scope: 'x' }])
    expect(r.problems[0]).toContain('enforce[0].scope')
  })

  test('a rule with a bad scope entry keeps its other entries and records the problem', async () => {
    const dir = tmpDir()
    try {
      fs.writeFileSync(
        path.join(dir, 'r.md'),
        ruleText('r', 6, "enforce:\n  - event: post_edit\n    path: 'a'\n    when: 'x'\n    scope: bogus\n  - event: pre_bash\n    when: 'rm'\n"),
      )
      const { rules, broken } = await scanRules(makeIo({ projectDir: tmpDir(), env: { CLAUDE_FEEDBACK_DIR: dir } }))
      expect(rules[0]?.enforce).toHaveLength(1)
      expect(broken.map((b) => b.reason).join('\n')).toContain('scope')
    } finally {
      rmTree(dir)
    }
  })
})
