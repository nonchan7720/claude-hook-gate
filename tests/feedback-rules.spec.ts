import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  evalPreBash,
  evalPreEdit,
  evalStopCheck,
  getChangedFiles,
  listRules,
  loadRule,
  logViolation,
  looksLikeTestFile,
  type Rule,
  resolveSeverity,
} from '../src/feedback-rules.ts'
import { expandBraces, globToRegex } from '../src/glob.ts'
import { parseYaml } from '../src/load-yaml.ts'
import type { Dict } from '../src/pyutil.ts'
import { relativize, splitRoot } from '../src/roots.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

const REAL_FEEDBACK_DIR = path.join(os.homedir(), '.claude', 'feedback')
const hasRealDir = fs.existsSync(REAL_FEEDBACK_DIR)

const rule = (name: string, count: number, ...enforce: Dict[]): Rule => ({ name, count, description: '', enforce, path: '' })
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

describe('logViolation', () => {
  test('does not change the source rule file (count is never rewritten)', async () => {
    const dir = tmpDir()
    const logDir = tmpDir()
    try {
      const file = path.join(dir, 'tdd.md')
      fs.writeFileSync(file, '---\nname: tdd\ncount: 6\n---\nbody\n')
      const before = fs.readFileSync(file, 'utf8')
      await logViolation(ioFor(dir, logDir), 'tdd', 6, 'ask', 'pre_edit', 'test')
      expect(fs.readFileSync(file, 'utf8')).toBe(before)
      const entry = JSON.parse(fs.readFileSync(path.join(logDir, '.violations.jsonl'), 'utf8').trim()) as Dict
      expect(entry).toMatchObject({ rule: 'tdd', count: 6, severity: 'ask', event: 'pre_edit', detail: 'test' })
      expect(String(entry.ts)).toMatch(/\+00:00$/)
    } finally {
      rmTree(dir)
      rmTree(logDir)
    }
  })
})

// 利用者の実ルールに依存していた回帰テスト（golang_conventions / verify_via_hooks）を、同じ形のルールを
// frontmatter から読む自己完結のテストにしたもの。
describe('golang_conventions-style directory rule', () => {
  const FRONTMATTER = [
    'name: golang_conventions',
    'description: d',
    'type: feedback',
    'count: 5',
    'enforce:',
    '  - event: pre_edit',
    "    path: 'pkg/**/*.go'",
    '    exclude_path:',
    "      - '**/*_test.go'",
    "      - 'pkg/{config,cmd,domain,infrastructure,interfaces,services,internal,tests}/**'",
    "    when: '[\\s\\S]'",
    "    message: '構成に従うこと'",
    '    severity: warn',
    '',
  ].join('\n')

  test('block sequence exclude_path is read as a list', () => {
    const data = parseYaml(FRONTMATTER) as { enforce: Dict[] }
    const entry = data.enforce[0] as Dict
    expect(Array.isArray(entry.exclude_path)).toBe(true)
    expect(entry.exclude_path).toContain('**/*_test.go')
  })

  test('test file is not flagged and non-test is warn only', async () => {
    const tmp = tmpDir()
    try {
      fs.writeFileSync(path.join(tmp, 'golang_conventions.md'), `---\n${FRONTMATTER}---\n\n本文\n`)
      const io = ioFor(tmp)
      const rules = await listRules(io)
      expect(rules.length).toBe(1)
      const handler = path.join(tmp, 'pkg', 'handler')
      fs.mkdirSync(handler, { recursive: true })
      expect(await evalPreEdit(io, rules, path.join(handler, 'server_test.go'), 'package handler', tmp)).toEqual([])
      const v = await evalPreEdit(io, rules, path.join(handler, 'server.go'), 'package handler', tmp)
      expect(v.length).toBe(1)
      expect(v[0]?.severity).toBe('warn')
    } finally {
      rmTree(tmp)
    }
  })
})

describe('wrapper-prefixed command rule', () => {
  const WHEN = '(^|&&|\\|\\||;)\\s*(mise\\s+(exec|x)\\s+--\\s+|uv\\s+run\\s+|bundle\\s+exec\\s+|env\\s+\\S+=\\S+\\s+)?(pytest|go test|rspec)\\b'
  const r = rule('verify_via_hooks', 6, { event: 'pre_bash', when: WHEN, message: 'hookに任せる', severity: 'deny' })
  const io = ioFor(os.tmpdir())

  test('wrapper prefixed commands are denied', async () => {
    for (const command of ['mise exec -- pytest tests', 'mise x -- go test ./...', 'uv run pytest', 'env FOO=1 pytest tests', 'bundle exec rspec']) {
      const v = await evalPreBash(io, [r], command)
      expect(v.length).toBeGreaterThan(0)
      expect(v[0]?.severity).toBe('deny')
    }
  })

  test('mise run task is not denied', async () => {
    for (const command of ['mise run test', 'mise run lint']) expect(await evalPreBash(io, [r], command)).toEqual([])
  })

  test('bare command is still denied', async () => {
    const v = await evalPreBash(io, [r], 'pytest tests')
    expect(v[0]?.severity).toBe('deny')
  })

  test('wrapper name without tool is not a false positive', async () => {
    expect(await evalPreBash(io, [r], 'mise exec -- echo hi')).toEqual([])
  })
})

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
})

describe('resolveSeverity', () => {
  test('count 6 and 5 are deny', () => {
    expect(resolveSeverity(6)).toBe('deny')
    expect(resolveSeverity(5)).toBe('deny')
  })
  test('count 4 is ask for pre events and block for stop_check', () => {
    expect(resolveSeverity(4, undefined, 'pre_bash')).toBe('ask')
    expect(resolveSeverity(4, undefined, 'pre_edit')).toBe('ask')
    expect(resolveSeverity(4, undefined, 'stop_check')).toBe('block')
  })
  test('count 3 matches same boundaries as 4', () => {
    expect(resolveSeverity(3, undefined, 'pre_bash')).toBe('ask')
    expect(resolveSeverity(3, undefined, 'stop_check')).toBe('block')
  })
  test('count 2 and 1 are warn', () => {
    expect(resolveSeverity(2, undefined, 'pre_bash')).toBe('warn')
    expect(resolveSeverity(1, undefined, 'stop_check')).toBe('warn')
  })
  test('explicit severity overrides count', () => {
    expect(resolveSeverity(6, 'warn')).toBe('warn')
    expect(resolveSeverity(1, 'deny')).toBe('deny')
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

describe('evalPreBash', () => {
  const io = ioFor(os.tmpdir())
  const goTest = (count: number) =>
    rule('dont_run_tests_manually', count, { event: 'pre_bash', when: '(^|&&|\\|\\||;)\\s*go test\\b', message: 'hookに任せる', severity: 'deny' })

  test('go test is flagged', async () => {
    const v = await evalPreBash(io, [goTest(6)], 'go test ./...')
    expect(v.length).toBe(1)
    expect(v[0]?.severity).toBe('deny')
  })

  test('unrelated string is not a false positive', async () => {
    expect(await evalPreBash(io, [goTest(6)], 'echo go test')).toEqual([])
  })

  test('unless excludes draft PR', async () => {
    const r = rule('x', 2, { event: 'pre_bash', when: 'gh pr create', unless: '--draft', message: 'draftで作成', severity: 'warn' })
    expect(await evalPreBash(io, [r], 'gh pr create --draft')).toEqual([])
    const v = await evalPreBash(io, [r], 'gh pr create')
    expect(v.length).toBe(1)
    expect(v[0]?.severity).toBe('warn')
  })

  test('check command confirms violation when nonzero', async () => {
    const r = rule('x', 1, { event: 'pre_bash', when: 'git commit', check: 'exit 1', message: '保護ブランチ', severity: 'warn' })
    expect((await evalPreBash(io, [r], 'git commit -m x')).length).toBe(1)
  })

  test('check command zero exit means no violation', async () => {
    const r = rule('x', 1, { event: 'pre_bash', when: 'git commit', check: 'exit 0', message: '保護ブランチ', severity: 'warn' })
    expect(await evalPreBash(io, [r], 'git commit -m x')).toEqual([])
  })

  test('python-style inline flags and named groups are translated', async () => {
    const r = rule('x', 1, { event: 'pre_bash', when: '(?i)(?P<tool>PYTEST)\\b', message: 'm', severity: 'warn' })
    expect((await evalPreBash(io, [r], 'pytest -q')).length).toBe(1)
  })
})

describe('evalPreEdit', () => {
  let tmp: string
  let io: ReturnType<typeof ioFor>
  beforeEach(() => {
    tmp = tmpDir()
    io = ioFor(tmp)
  })
  afterEach(() => rmTree(tmp))

  const touch = (...parts: string[]): string => {
    const p = path.join(tmp, ...parts)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '')
    return p
  }
  const tdd = (extra: Dict = {}, count = 6, glob = '**/*.go'): Rule[] => [
    rule('tdd', count, { event: 'pre_edit', path: glob, message: '先にテストを書く', severity: 'ask', ...extra }),
  ]
  const siblingGo = { absent_sibling: '{stem}_test.go' }
  const rb = (patterns: unknown): Rule[] => tdd({ absent_glob: patterns }, 7, '**/*.rb')
  const py = (patterns: unknown): Rule[] => tdd({ absent_glob: patterns }, 7, '**/*.py')
  const check = (rules: Rule[], file: string, content = 'x') => evalPreEdit(io, rules, file, content, tmp)

  test('missing test sibling is ask', async () => {
    const v = await check(tdd(siblingGo), path.join(tmp, 'foo.go'), 'package main')
    expect(v.length).toBe(1)
    expect(v[0]?.severity).toBe('ask')
  })

  test('existing test sibling passes', async () => {
    const foo = touch('foo.go')
    touch('foo_test.go')
    expect(await check(tdd(siblingGo), foo)).toEqual([])
  })

  test('test file itself is excluded', async () => {
    expect(await check(tdd(siblingGo), touch('foo_test.go'))).toEqual([])
  })

  test('exclude_path skips absent_sibling check', async () => {
    const iface = touch('interfaces', 'repo.go')
    expect(await check(tdd({ ...siblingGo, exclude_path: ['**/interfaces/**', '**/*_iface.go'] }), iface)).toEqual([])
  })

  test('exclude_path does not affect unmatched files', async () => {
    const foo = touch('foo.go')
    expect((await check(tdd({ ...siblingGo, exclude_path: ['**/interfaces/**'] }), foo)).length).toBe(1)
  })

  test('exclude_path accepts single string', async () => {
    expect(await check(tdd({ ...siblingGo, exclude_path: '**/*_iface.go' }), touch('svc_iface.go'))).toEqual([])
  })

  test('exclude_path applies to when-pattern rules', async () => {
    const f = path.join(tmp, 'gen', 'x.go')
    const r = [
      rule('modern_go_map_any', 1, {
        event: 'pre_edit',
        path: '**/*.go',
        exclude_path: '**/gen/**',
        when: 'interface\\{\\}',
        message: 'anyを使う',
        severity: 'warn',
      }),
    ]
    expect(await check(r, f, 'var m map[string]interface{}')).toEqual([])
  })

  test('absent_glob finds spec in separate tree', async () => {
    const impl = touch('app', 'models', 'user.rb')
    touch('spec', 'models', 'user_spec.rb')
    expect(await check(rb(['{dir}/{stem}_spec.rb', 'spec/**/{stem}_spec.rb']), impl)).toEqual([])
  })

  test('absent_glob flags when no candidate exists', async () => {
    const impl = touch('app', 'models', 'user.rb')
    const v = await check(rb(['{dir}/{stem}_spec.rb', 'spec/**/{stem}_spec.rb']), impl)
    expect(v.length).toBe(1)
    expect(v[0]?.severity).toBe('ask')
  })

  test('absent_glob matches same directory candidate', async () => {
    const impl = touch('lib', 'user.rb')
    touch('lib', 'user_spec.rb')
    expect(await check(rb(['{dir}/{stem}_spec.rb', 'spec/**/{stem}_spec.rb']), impl)).toEqual([])
  })

  test('absent_glob accepts single string', async () => {
    const impl = touch('lib', 'user.rb')
    touch('spec', 'user_spec.rb')
    expect(await check(rb('spec/**/{stem}_spec.rb'), impl)).toEqual([])
  })

  test('absent_glob handles project root file', async () => {
    const impl = touch('user.rb')
    touch('user_spec.rb')
    expect(await check(rb(['{dir}/{stem}_spec.rb']), impl)).toEqual([])
  })

  test('absent_glob skips test file itself', async () => {
    expect(await check(rb(['spec/**/{stem}_spec.rb']), touch('spec', 'models', 'user_spec.rb'), 'describe User')).toEqual([])
  })

  test('absent_glob respects exclude_path', async () => {
    const impl = touch('db', 'migrate', '001_create_users.rb')
    const r = tdd({ exclude_path: '**/db/migrate/**', absent_glob: ['spec/**/{stem}_spec.rb'] }, 7, '**/*.rb')
    expect(await check(r, impl)).toEqual([])
  })

  test('absent_glob and absent_sibling are ORed', async () => {
    const impl = touch('lib', 'user.rb')
    touch('lib', 'user_spec.rb')
    const r = tdd({ absent_sibling: '{stem}_spec.rb', absent_glob: ['spec/**/{stem}_spec.rb'] }, 7, '**/*.rb')
    expect(await check(r, impl)).toEqual([])
  })

  test('absent_glob expands braces', async () => {
    const impl = touch('src', 'user.ts')
    touch('src', '__tests__', 'user.spec.ts')
    const r = tdd({ absent_glob: ['{dir}/__tests__/{stem}.{test,spec}.ts'] }, 7, '**/*.ts')
    expect(await check(r, impl)).toEqual([])
  })

  test('absent_glob expands braces in directory part', async () => {
    const impl = touch('src', 'user.ts')
    touch('tests', 'unit', 'user.test.ts')
    const r = tdd({ absent_glob: ['{test,tests}/**/{stem}.{test,spec}.ts'] }, 7, '**/*.ts')
    expect(await check(r, impl)).toEqual([])
  })

  test('absent_glob matches snake_case test for kebab-case impl', async () => {
    const impl = touch('hooks', 'stop-gate.py')
    touch('hooks', 'tests', 'test_stop_gate.py')
    expect(await check(py(['{dir}/tests/test_{stem}.py']), impl)).toEqual([])
  })

  test('absent_glob matches kebab-case test for snake_case impl', async () => {
    const impl = touch('hooks', 'stop_gate.py')
    touch('hooks', 'tests', 'test_stop-gate.py')
    expect(await check(py(['{dir}/tests/test_{stem}.py']), impl)).toEqual([])
  })

  test('absent_sibling matches underscore variant for kebab-case impl', async () => {
    const impl = touch('pkg', 'my-handler.go')
    touch('pkg', 'my_handler_test.go')
    expect(await check(tdd(siblingGo), impl)).toEqual([])
  })

  test('absent_glob with no separator stem still flags when missing', async () => {
    const impl = touch('hooks', 'gate.py')
    const v = await check(py(['{dir}/tests/test_{stem}.py']), impl)
    expect(v.length).toBe(1)
    expect(v[0]?.detail).toBe('missing test file: hooks/tests/test_gate.py')
  })

  test('absent_glob kebab-case impl without any test still flags', async () => {
    const impl = touch('hooks', 'new-thing.py')
    const v = await check(py(['{dir}/tests/test_{stem}.py']), impl)
    expect(v.length).toBe(1)
    expect(v[0]?.detail).toContain('test_new-thing.py')
    expect(v[0]?.detail).toContain('test_new_thing.py')
  })

  test('absent_sibling kebab-case impl without any test still flags', async () => {
    const impl = touch('pkg', 'my-other.go')
    const v = await check(tdd(siblingGo), impl)
    expect(v.length).toBe(1)
    expect(v[0]?.detail).toContain('my-other_test.go')
    expect(v[0]?.detail).toContain('my_other_test.go')
  })

  test('spec and underscore test files are treated as test files', () => {
    for (const name of ['user.spec.ts', 'user.spec.tsx', 'user_test.py', 'user_test.rb']) expect(looksLikeTestFile(name)).toBe(true)
  })

  test('when pattern on content flags violation', async () => {
    const r = [rule('modern_go_map_any', 1, { event: 'pre_edit', path: '**/*.go', when: 'interface\\{\\}', message: 'anyを使う', severity: 'warn' })]
    expect((await check(r, path.join(tmp, 'x.go'), 'var m map[string]interface{}')).length).toBe(1)
  })

  test('path glob not matching is ignored', async () => {
    const r = [rule('modern_go_map_any', 1, { event: 'pre_edit', path: '**/*.go', when: 'interface\\{\\}', message: 'anyを使う', severity: 'warn' })]
    expect(await check(r, path.join(tmp, 'x.rb'), 'interface{}')).toEqual([])
  })
})

describe('evalStopCheck', () => {
  let tmp: string
  beforeEach(() => {
    tmp = tmpDir()
  })
  afterEach(() => rmTree(tmp))
  const readme = [
    rule('readme_bilingual', 4, { event: 'stop_check', changed: '**/README.md', require_sibling: 'README_ja.md', message: '日英併記', severity: 'block' }),
  ]

  test('README without ja sibling is blocked', async () => {
    fs.writeFileSync(path.join(tmp, 'README.md'), '')
    const v = await evalStopCheck(ioFor(tmp), readme, tmp, ['README.md'])
    expect(v.length).toBe(1)
    expect(v[0]?.severity).toBe('block')
  })

  test('README with ja sibling passes', async () => {
    fs.writeFileSync(path.join(tmp, 'README.md'), '')
    fs.writeFileSync(path.join(tmp, 'README_ja.md'), '')
    expect(await evalStopCheck(ioFor(tmp), readme, tmp, ['README.md'])).toEqual([])
  })

  test('unrelated changed file is ignored', async () => {
    expect(await evalStopCheck(ioFor(tmp), readme, tmp, ['main.go'])).toEqual([])
  })
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
const initRepo = (dir: string) => {
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 't')
}

describe('getChangedFiles', () => {
  let tmp: string
  beforeEach(() => {
    tmp = tmpDir()
  })
  afterEach(() => rmTree(tmp))
  const stateDir = () => path.join(tmp, '.claude', '.gate-status')
  const memo = (name: string, text: string) => {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.writeFileSync(path.join(stateDir(), name), text)
  }

  test('prefers changed_files memo', async () => {
    memo('changed_files.sess1.txt', 'a.go\nb.go\n')
    expect(await getChangedFiles(ioFor(tmp), tmp, 'sess1')).toEqual(['a.go', 'b.go'])
  })

  test('falls back to git when no memo', async () => {
    initRepo(tmp)
    fs.writeFileSync(path.join(tmp, 'committed.txt'), '1')
    git(tmp, 'add', '.')
    git(tmp, 'commit', '-q', '-m', 'init')
    fs.writeFileSync(path.join(tmp, 'committed.txt'), '2')
    fs.writeFileSync(path.join(tmp, 'untracked.txt'), '3')
    const files = await getChangedFiles(ioFor(tmp), tmp, 'no-such-session')
    expect(files).toContain('committed.txt')
    expect(files).toContain('untracked.txt')
  })

  test('agent_id reads only agent suffixed memo', async () => {
    memo('changed_files.sess1.txt', 'main_only.go\n')
    memo('changed_files.sess1--agent1.txt', 'agent_only.go\n')
    expect(await getChangedFiles(ioFor(tmp), tmp, 'sess1', 'agent1')).toEqual(['agent_only.go'])
  })

  test('agent fallback without memo uses worktree cwd and returns absolute paths', async () => {
    const worktree = path.join(tmp, '.claude', 'worktrees', 'agent-agent1')
    fs.mkdirSync(worktree, { recursive: true })
    initRepo(worktree)
    fs.writeFileSync(path.join(worktree, 'committed.txt'), '1')
    git(worktree, 'add', '.')
    git(worktree, 'commit', '-q', '-m', 'init')
    fs.writeFileSync(path.join(worktree, 'committed.txt'), '2')
    expect(await getChangedFiles(ioFor(tmp), tmp, 'sess1', 'agent1')).toEqual([path.join(worktree, 'committed.txt')])
  })

  test('agent fallback without worktree uses project dir', async () => {
    initRepo(tmp)
    fs.writeFileSync(path.join(tmp, 'untracked.txt'), '1')
    expect(await getChangedFiles(ioFor(tmp), tmp, 'sess1', 'agent-without-worktree')).toContain('untracked.txt')
  })

  test('main call merges plain and agent suffixed memos', async () => {
    memo('changed_files.sess1.txt', 'main.go\n')
    memo('changed_files.sess1--agentA.txt', 'agentA.go\n')
    memo('changed_files.sess1--agentB.txt', 'agentB.go\nmain.go\n')
    expect(await getChangedFiles(ioFor(tmp), tmp, 'sess1')).toEqual(['main.go', 'agentA.go', 'agentB.go'])
  })

  test('main call with only agent suffixed memos does not fall back to git', async () => {
    memo('changed_files.sess1--agentA.txt', 'agentA.go\n')
    expect(await getChangedFiles(ioFor(tmp), tmp, 'sess1')).toEqual(['agentA.go'])
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

describe('evalStopCheck with worktrees', () => {
  let tmp: string
  let worktree: string
  beforeEach(() => {
    tmp = tmpDir()
    worktree = path.join(tmp, '.claude', 'worktrees', 'agent-abc')
    fs.mkdirSync(path.join(worktree, 'hooks'), { recursive: true })
  })
  afterEach(() => rmTree(tmp))

  test('worktree file matches anchored glob by root relative path', async () => {
    const f = path.join(worktree, 'hooks', 'foo.py')
    fs.writeFileSync(f, '')
    const r = [rule('some_rule', 4, { event: 'stop_check', changed: 'hooks/**/*.py', message: 'check', severity: 'block', check: 'exit 1' })]
    expect((await evalStopCheck(ioFor(tmp), r, tmp, [f])).length).toBe(1)
  })

  test('require_sibling checks worktree absolute path', async () => {
    const f = path.join(worktree, 'hooks', 'README.md')
    fs.writeFileSync(f, '')
    const r = [
      rule('readme_bilingual', 4, { event: 'stop_check', changed: '**/README.md', require_sibling: 'README_ja.md', message: 'bilingual', severity: 'block' }),
    ]
    expect((await evalStopCheck(ioFor(tmp), r, tmp, [f])).length).toBe(1)
    fs.writeFileSync(path.join(worktree, 'hooks', 'README_ja.md'), '')
    expect(await evalStopCheck(ioFor(tmp), r, tmp, [f])).toEqual([])
  })

  test('check command receives worktree absolute file and cwd', async () => {
    const f = path.join(worktree, 'hooks', 'foo.py')
    fs.writeFileSync(f, '')
    const marker = path.join(tmp, 'marker.txt')
    const r = [
      rule('some_rule', 4, {
        event: 'stop_check',
        changed: '**/*.py',
        message: 'check',
        severity: 'block',
        check: `printf "%s\\n%s" "$FILE" "$(pwd)" > ${marker}; exit 1`,
      }),
    ]
    await evalStopCheck(ioFor(tmp), r, tmp, [f])
    const [recordedFile, recordedCwd] = fs.readFileSync(marker, 'utf8').split('\n')
    expect(recordedFile).toBe(f)
    expect(fs.realpathSync(recordedCwd as string)).toBe(fs.realpathSync(worktree))
  })

  test('main tree check command cwd is project dir', async () => {
    const f = path.join(tmp, 'hooks', 'bar.py')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, '')
    const marker = path.join(tmp, 'marker.txt')
    const r = [
      rule('some_rule', 4, { event: 'stop_check', changed: '**/*.py', message: 'check', severity: 'block', check: `printf "%s" "$(pwd)" > ${marker}; exit 1` }),
    ]
    await evalStopCheck(ioFor(tmp), r, tmp, [f])
    expect(fs.realpathSync(fs.readFileSync(marker, 'utf8'))).toBe(fs.realpathSync(tmp))
  })
})

describe('evalPreEdit with worktrees', () => {
  let tmp: string
  let worktree: string
  beforeEach(() => {
    tmp = tmpDir()
    worktree = path.join(tmp, '.claude', 'worktrees', 'agent-abc')
  })
  afterEach(() => rmTree(tmp))
  const mkfile = (...parts: string[]): string => {
    const p = path.join(...parts)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '')
    return p
  }
  const golang = [
    rule('golang_conventions', 5, {
      event: 'pre_edit',
      path: 'pkg/**/*.go',
      exclude_path: ['pkg/{domain,infrastructure}/**', '**/*_test.go'],
      when: '[\\s\\S]',
      message: '構成に従うこと',
      severity: 'warn',
    }),
  ]
  const specRule = [
    rule('tdd', 7, { event: 'pre_edit', path: '**/*.rb', absent_glob: ['spec/**/{stem}_spec.rb'], message: '先にテストを書く', severity: 'ask' }),
  ]

  test('worktree file matches project root anchored path glob', async () => {
    const f = mkfile(worktree, 'pkg', 'cmd', 'server.go')
    expect((await evalPreEdit(ioFor(tmp), golang, f, 'package cmd', tmp)).length).toBe(1)
  })

  test('worktree file under excluded dir is not flagged', async () => {
    const f = mkfile(worktree, 'pkg', 'domain', 'model.go')
    expect(await evalPreEdit(ioFor(tmp), golang, f, 'package domain', tmp)).toEqual([])
  })

  test('worktree absent_glob resolves against worktree root', async () => {
    const impl = mkfile(worktree, 'app', 'models', 'user.rb')
    mkfile(worktree, 'spec', 'models', 'user_spec.rb')
    expect(await evalPreEdit(ioFor(tmp), specRule, impl, 'class User; end', tmp)).toEqual([])
  })

  test('worktree absent_glob flags when only project dir has the test', async () => {
    const impl = mkfile(worktree, 'app', 'models', 'user.rb')
    mkfile(tmp, 'spec', 'models', 'user_spec.rb')
    expect((await evalPreEdit(ioFor(tmp), specRule, impl, 'class User; end', tmp)).length).toBe(1)
  })
})
