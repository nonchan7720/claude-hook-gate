import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isRuleActive, listRules, loadRule, projectFeedbackDir, type Rule } from '../src/feedback-rules.ts'
import { expandBraces, globToRegex } from '../src/glob.ts'
import { parseYaml } from '../src/load-yaml.ts'
import type { Dict } from '../src/pyutil.ts'
import { relativize, splitRoot } from '../src/roots.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

const REAL_FEEDBACK_DIR = path.join(os.homedir(), '.claude', 'feedback')
const hasRealDir = fs.existsSync(REAL_FEEDBACK_DIR)

const rule = (name: string, count: number, ...enforce: Dict[]): Rule => ({
  name,
  count,
  description: '',
  enforce,
  path: '',
  projects: [],
  whenExists: [],
  files: [],
  excludeFiles: [],
})
const ioFor = (projectDir: string, feedbackDir = projectDir) => makeIo({ projectDir, env: { CLAUDE_FEEDBACK_DIR: feedbackDir } })

// ~/.claude/feedback/ は利用者ごとの実ファイルなので、CI など存在しない環境ではスキップする。
describe.skipIf(!hasRealDir)('listRules (real ~/.claude/feedback)', () => {
  test('reads exactly the md files that have frontmatter', async () => {
    const expected = new Set<string>()
    for (const filename of fs.readdirSync(REAL_FEEDBACK_DIR)) {
      if (!filename.endsWith('.md')) continue
      const content = fs.readFileSync(path.join(REAL_FEEDBACK_DIR, filename), 'utf8')
      const m = /^---\n([\s\S]*?\n)---\n/.exec(content)
      if (!m) continue
      const nm = /^name:\s*(\S+)\s*$/m.exec(m[1] ?? '')
      if (nm?.[1]) expected.add(nm[1])
    }
    const rules = await listRules(ioFor(os.tmpdir()), REAL_FEEDBACK_DIR)
    expect(new Set(rules.map((r) => r.name))).toEqual(expected)
  })

  test('each rule has name and count', async () => {
    for (const r of await listRules(ioFor(os.tmpdir()), REAL_FEEDBACK_DIR)) {
      expect(r.name).toBeTruthy()
      expect(Number.isInteger(r.count)).toBe(true)
    }
  })
})

// 利用者の実ルールに依存していた回帰テスト（golang_conventions / verify_via_hooks）を、同じ形のルールを
// frontmatter から読む自己完結のテストにしたもの。
describe('frontmatter parser (built-in YAML subset)', () => {
  const SAMPLE = [
    'name: sample_rule',
    'description: サンプルの説明',
    'type: feedback',
    'count: 4',
    'enforce:',
    '  - event: pre_bash',
    "    when: 'go (test|vet)\\b'",
    "    unless: '--dry-run'",
    "    message: 'テストはhookに任せること'",
    '    severity: deny',
    '  - event: pre_edit',
    "    path: '**/*.go'",
    "    absent_sibling: '{stem}_test.go'",
    "    message: 'テストファイルが先'",
    '    severity: ask',
    '  - event: stop_check',
    "    changed: '**/README.md'",
    "    require_sibling: 'README_ja.md'",
    "    message: '日英併記のこと'",
    '    severity: block',
    '',
  ].join('\n')

  test('parses scalars and enforce list', () => {
    const data = parseYaml(SAMPLE) as Dict
    expect(data.name).toBe('sample_rule')
    expect(data.description).toBe('サンプルの説明')
    expect(data.count).toBe(4)
    expect(Array.isArray(data.enforce)).toBe(true)
    expect((data.enforce as unknown[]).length).toBe(3)
  })

  test('preserves regex backslashes in single quotes', () => {
    const entry = (parseYaml(SAMPLE) as { enforce: Dict[] }).enforce[0] as Dict
    expect(entry.event).toBe('pre_bash')
    expect(entry.when).toBe('go (test|vet)\\b')
    expect(entry.unless).toBe('--dry-run')
    expect(entry.severity).toBe('deny')
  })

  test('handles nested pre_edit and stop_check entries', () => {
    const enforce = (parseYaml(SAMPLE) as { enforce: Dict[] }).enforce
    expect(enforce[1]).toMatchObject({ path: '**/*.go', absent_sibling: '{stem}_test.go' })
    expect(enforce[2]).toMatchObject({ changed: '**/README.md', require_sibling: 'README_ja.md' })
  })

  test('exclude_path block sequence', () => {
    const text = [
      'name: tdd',
      'count: 7',
      'enforce:',
      '  - event: pre_edit',
      "    path: '**/*.go'",
      '    exclude_path:',
      "      - '**/interfaces/**'",
      "      - '**/*_iface.go'",
      "    absent_sibling: '{stem}_test.go'",
      '',
    ].join('\n')
    const e = (parseYaml(text) as { enforce: Dict[] }).enforce[0] as Dict
    expect(e.exclude_path).toEqual(['**/interfaces/**', '**/*_iface.go'])
    expect(e.absent_sibling).toBe('{stem}_test.go')
  })
})

describe('loadRule / listRules', () => {
  let tmp: string
  beforeEach(() => {
    tmp = tmpDir()
  })
  afterEach(() => rmTree(tmp))
  const write = (name: string, content: string) => {
    const p = path.join(tmp, name)
    fs.writeFileSync(p, content)
    return p
  }

  test('skips file without frontmatter', async () => {
    const p = write('rules.md', '# グローバルルール\n\n本文だけで frontmatter が無い\n')
    expect(await loadRule(ioFor(tmp), p)).toBeNull()
  })

  test('parses minimal rule without enforce', async () => {
    const p = write('foo.md', '---\nname: foo\ndescription: foo desc\ntype: feedback\ncount: 2\n---\n\n本文\n')
    const r = await loadRule(ioFor(tmp), p)
    expect(r?.name).toBe('foo')
    expect(r?.count).toBe(2)
    expect(r?.enforce).toEqual([])
  })

  test('listRules on directory', async () => {
    write('a.md', '---\nname: a\ndescription: d\ntype: feedback\ncount: 1\n---\nbody\n')
    write('b.md', '---\nname: b\ndescription: d\ntype: feedback\ncount: 5\n---\nbody\n')
    write('rules.md', '# no frontmatter\n')
    const names = (await listRules(ioFor(tmp))).map((r) => r.name).sort()
    expect(names).toEqual(['a', 'b'])
  })

  describe('project .claude/feedback', () => {
    const ruleText = (name: string, count: number) => `---\nname: ${name}\ndescription: d\ntype: feedback\ncount: ${count}\n---\nbody\n`
    const setup = () => {
      const globalDir = path.join(tmp, 'global')
      const projectDir = path.join(tmp, 'project')
      const projectFeedback = projectFeedbackDir(makeIo({ projectDir }))
      fs.mkdirSync(globalDir, { recursive: true })
      fs.mkdirSync(projectFeedback, { recursive: true })
      return { globalDir, projectDir, projectFeedback, io: ioFor(projectDir, globalDir) }
    }

    test('reads project .claude/feedback/*.md in addition to global', async () => {
      const { globalDir, projectFeedback, io } = setup()
      fs.writeFileSync(path.join(globalDir, 'g.md'), ruleText('g', 3))
      fs.writeFileSync(path.join(projectFeedback, 'p.md'), ruleText('p', 4))
      const rules = await listRules(io)
      expect(rules.map((r) => r.name)).toEqual(['g', 'p'])
    })

    test('project rule wins over global rule with the same name', async () => {
      const { globalDir, projectFeedback, io } = setup()
      fs.writeFileSync(path.join(globalDir, 'dup.md'), ruleText('dup', 3))
      fs.writeFileSync(path.join(globalDir, 'only-g.md'), ruleText('only-g', 3))
      fs.writeFileSync(path.join(projectFeedback, 'dup.md'), ruleText('dup', 5))
      const rules = await listRules(io)
      const dups = rules.filter((r) => r.name === 'dup')
      expect(dups).toHaveLength(1)
      expect(dups[0]?.count).toBe(5)
      expect(dups[0]?.path).toBe(path.join(projectFeedback, 'dup.md'))
      expect(rules.map((r) => r.name)).toEqual(['only-g', 'dup'])
    })

    test('explicit feedbackDirPath does not read the project directory', async () => {
      const { globalDir, projectFeedback, io } = setup()
      fs.writeFileSync(path.join(globalDir, 'g.md'), ruleText('g', 3))
      fs.writeFileSync(path.join(projectFeedback, 'p.md'), ruleText('p', 3))
      expect((await listRules(io, globalDir)).map((r) => r.name)).toEqual(['g'])
    })

    test('same directory for global and project is read only once', async () => {
      const projectDir = path.join(tmp, 'same')
      const projectFeedback = projectFeedbackDir(makeIo({ projectDir }))
      fs.mkdirSync(projectFeedback, { recursive: true })
      fs.writeFileSync(path.join(projectFeedback, 'a.md'), ruleText('a', 3))
      const rules = await listRules(ioFor(projectDir, projectFeedback))
      expect(rules.map((r) => r.name)).toEqual(['a'])
    })
  })
})

describe('expires / projects / when_exists', () => {
  let tmp: string
  beforeEach(() => {
    tmp = tmpDir()
  })
  afterEach(() => rmTree(tmp))

  /** グローバル用ディレクトリに name のルールを書き、listRules（マージ経路）で返る名前を返す。 */
  const names = async (extra: string[], opts: { projectDir?: string; now?: number; home?: string } = {}) => {
    const globalDir = path.join(tmp, 'global')
    fs.mkdirSync(globalDir, { recursive: true })
    fs.writeFileSync(path.join(globalDir, 'r.md'), `---\nname: r\ndescription: d\ntype: feedback\ncount: 3\n${extra.join('\n')}\n---\nbody\n`)
    const projectDir = opts.projectDir ?? path.join(tmp, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    const now = opts.now
    const io = makeIo({
      projectDir,
      env: { CLAUDE_FEEDBACK_DIR: globalDir, ...(opts.home ? { HOME: opts.home } : {}) },
      ...(now === undefined ? {} : { now: () => now }),
    })
    return (await listRules(io)).map((r) => r.name)
  }
  const T = Date.parse('2026-06-15T12:00:00Z')

  test('loadRule reads the three keys', async () => {
    const p = path.join(tmp, 'x.md')
    fs.writeFileSync(p, "---\nname: x\nexpires: 2026-12-31T10:00:00Z\nprojects: '~/a/**'\nwhen_exists: ['go.mod', '**/*.go']\n---\n")
    const r = await loadRule(ioFor(tmp), p)
    expect(r?.expires).toBe(Date.parse('2026-12-31T10:00:00Z'))
    expect(r?.projects).toEqual(['~/a/**'])
    expect(r?.whenExists).toEqual(['go.mod', '**/*.go'])
  })

  test('expires in the future is active, in the past is excluded', async () => {
    expect(await names(['expires: 2026-12-31T00:00:00Z'], { now: T })).toEqual(['r'])
    expect(await names(['expires: 2026-01-01T00:00:00Z'], { now: T })).toEqual([])
  })

  test('YYYY-MM-DD is valid until the end of that day', async () => {
    expect(await names(['expires: 2026-06-15'], { now: Date.parse('2026-06-15T23:59:59.999Z') })).toEqual(['r'])
    expect(await names(['expires: 2026-06-15'], { now: Date.parse('2026-06-16T00:00:00Z') })).toEqual([])
    // 引用符付き（文字列）でも同じ
    expect(await names(["expires: '2026-06-15'"], { now: Date.parse('2026-06-15T23:59:59.999Z') })).toEqual(['r'])
  })

  test('unparsable expires is treated as no expiry', async () => {
    expect(await names(['expires: not-a-date'], { now: T })).toEqual(['r'])
  })

  test('projects: matches the project directory, excludes otherwise', async () => {
    const projectDir = path.join(tmp, 'src', 'myorg', 'app')
    expect(await names([`projects: ['${tmp}/src/myorg/**']`], { projectDir })).toEqual(['r'])
    expect(await names([`projects: '${tmp}/src/myorg/**'`], { projectDir })).toEqual(['r'])
    expect(await names([`projects: ['${tmp}/other/**']`], { projectDir })).toEqual([])
    expect(await names([`projects: ['${tmp}/other/**', '${tmp}/src/**']`], { projectDir })).toEqual(['r'])
    expect(await names(['projects: []'], { projectDir })).toEqual(['r'])
  })

  test('projects: leading ~ is expanded to HOME', async () => {
    const projectDir = path.join(tmp, 'src', 'myorg', 'app')
    expect(await names(["projects: ['~/src/myorg/**']"], { projectDir, home: tmp })).toEqual(['r'])
    expect(await names(["projects: ['~/src/another/**']"], { projectDir, home: tmp })).toEqual([])
  })

  test('when_exists: active only if one of the globs exists', async () => {
    const projectDir = path.join(tmp, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    expect(await names(["when_exists: ['go.mod']"], { projectDir })).toEqual([])
    fs.writeFileSync(path.join(projectDir, 'go.mod'), 'module x\n')
    expect(await names(["when_exists: ['go.mod']"], { projectDir })).toEqual(['r'])
    expect(await names(["when_exists: 'go.mod'"], { projectDir })).toEqual(['r'])
    expect(await names(["when_exists: ['Cargo.toml', 'go.mod']"], { projectDir })).toEqual(['r'])
    expect(await names(["when_exists: ['Cargo.toml']"], { projectDir })).toEqual([])
  })

  test('when_exists: recursive pattern', async () => {
    const projectDir = path.join(tmp, 'project')
    expect(await names(["when_exists: ['**/*.go']"], { projectDir })).toEqual([])
    fs.mkdirSync(path.join(projectDir, 'cmd', 'app'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'cmd', 'app', 'main.go'), 'package main\n')
    expect(await names(["when_exists: ['**/*.go']"], { projectDir })).toEqual(['r'])
  })

  test('all three conditions must hold', async () => {
    const projectDir = path.join(tmp, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'go.mod'), 'module x\n')
    const ok = [`projects: ['${tmp}/**']`, "when_exists: ['go.mod']", 'expires: 2026-12-31']
    expect(await names(ok, { projectDir, now: T })).toEqual(['r'])
    expect(await names(ok, { projectDir, now: Date.parse('2027-01-01T00:00:00Z') })).toEqual([])
  })

  test('isRuleActive takes an explicit projectDir', async () => {
    const dir = path.join(tmp, 'other')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'go.mod'), '')
    const r: Rule = { ...rule('r', 3), whenExists: ['go.mod'] }
    const io = ioFor(path.join(tmp, 'project'))
    expect(await isRuleActive(io, r)).toBe(false)
    expect(await isRuleActive(io, r, dir)).toBe(true)
  })

  test('explicit feedbackDirPath returns rules even when expired', async () => {
    const dir = path.join(tmp, 'explicit')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'r.md'), '---\nname: r\ncount: 3\nexpires: 2020-01-01\nprojects: [/nowhere/**]\n---\n')
    const io = makeIo({ projectDir: tmp, env: { CLAUDE_FEEDBACK_DIR: dir }, now: () => T })
    expect((await listRules(io, dir)).map((r) => r.name)).toEqual(['r'])
  })

  test('expired project rule does not resurrect the global rule of the same name', async () => {
    const globalDir = path.join(tmp, 'global')
    const projectDir = path.join(tmp, 'project')
    const projectFeedback = projectFeedbackDir(makeIo({ projectDir }))
    fs.mkdirSync(globalDir, { recursive: true })
    fs.mkdirSync(projectFeedback, { recursive: true })
    fs.writeFileSync(path.join(globalDir, 'dup.md'), '---\nname: dup\ncount: 3\n---\n')
    fs.writeFileSync(path.join(projectFeedback, 'dup.md'), '---\nname: dup\ncount: 5\nexpires: 2020-01-01\n---\n')
    const io = makeIo({ projectDir, env: { CLAUDE_FEEDBACK_DIR: globalDir }, now: () => T })
    expect(await listRules(io)).toEqual([])
  })
})

describe('glob helpers', () => {
  test('double star crosses directories, single star does not', () => {
    const rx = new RegExp(globToRegex('**/*.go'))
    expect(rx.test('pkg/domain/foo.go')).toBe(true)
    expect(rx.test('foo.go')).toBe(true)
    const rx2 = new RegExp(globToRegex('*.go'))
    expect(rx2.test('pkg/foo.go')).toBe(false)
    expect(rx2.test('foo.go')).toBe(true)
  })

  test('brace expansion', () => {
    expect(new Set(expandBraces('**/action.{yml,yaml}'))).toEqual(new Set(['**/action.yml', '**/action.yaml']))
  })

  test('relativize strips project dir prefix', () => {
    expect(relativize('/repo/.github/workflows/ci.yml', '/repo')).toBe('.github/workflows/ci.yml')
  })
})

describe('splitRoot', () => {
  const tmp = '/proj'
  test('worktree path returns worktree root and relative', () => {
    const wt = path.join(tmp, '.claude', 'worktrees', 'agent-abc123')
    expect(splitRoot(tmp, path.join(wt, 'hooks', 'foo.py'))).toEqual([wt, 'hooks/foo.py'])
  })
  test('non worktree absolute path returns project dir', () => {
    expect(splitRoot(tmp, path.join(tmp, 'hooks', 'foo.py'))).toEqual([tmp, 'hooks/foo.py'])
  })
  test('relative path is treated as project relative', () => {
    expect(splitRoot(tmp, 'hooks/foo.py')).toEqual([tmp, 'hooks/foo.py'])
  })
})
