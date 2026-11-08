// 壊れた feedback ルール（YAML として読めない・不正な正規表現・enforce がリストでない／要素が辞書でない）が、
// 他の正常なルールまで読めなくしないこと、そしてその不備が .errors.jsonl と /correct で見えること。
// hook の判定（壊れたルールの横でも他のルールが deny する、注入に出るなど）は Go 版のテスト（internal/hookgate/broken_rules_test.go）。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { correctCommand } from '../src/correct.ts'
import { errorsLogPath, listRules, normalizeEnforce, scanRules } from '../src/feedback-rules.ts'
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

describe('broken rules do not hide the other rules', () => {
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
  const io = () => makeIo({ projectDir: proj, env: { CLAUDE_FEEDBACK_DIR: dir } })
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
    test(`${label}: the other rule is still read and the broken file is recorded`, async () => {
      fs.writeFileSync(path.join(dir, file), content)
      const rules = await listRules(io())
      expect(rules.map((r) => r.name)).toContain('delegate_no_cd_in_bash')
      const logged = errors()
      expect(logged).toHaveLength(1)
      expect(logged[0]?.source).toBe('rules')
      expect(logged[0]?.file).toBe(path.join(dir, file))
      expect(String(logged[0]?.error)).not.toBe('')
    })
  }

  test('the same broken rule is recorded only once in .errors.jsonl', async () => {
    fs.writeFileSync(path.join(dir, 'zz_yaml.md'), BROKEN['YAML syntax error']?.[1] ?? '')
    await listRules(io())
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
  })

  test('/correct reports the broken rules as proposals', async () => {
    fs.writeFileSync(path.join(dir, 'aa_dict.md'), BROKEN['enforce is a mapping']?.[1] ?? '')
    const r = await correctCommand(makeIo({ projectDir: proj, env: { CLAUDE_FEEDBACK_DIR: dir, HOME: proj } }), '')
    expect(r.text).toContain('- [broken] aa_dict')
    expect(r.text).toContain('読めず無効になっている: enforce がリストではありません（mapping）')
    expect(r.text).toContain(path.join(dir, 'aa_dict.md'))
    expect(r.context).toHaveLength(1)
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
