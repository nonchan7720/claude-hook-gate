// Bash で書き換えたファイルにも、Edit / Write と同じ feedback の post_edit（と、実行後に判定できる pre_edit）が
// かかることを確かめる（src/bash-changes.ts の bashChanges → src/feedback-bash-edit.ts）。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { bashChanges, bashStarted } from '../src/bash-changes.ts'
import { addedLines, feedbackBashEdits } from '../src/feedback-bash-edit.ts'
import { readCountLine } from '../src/feedback-rules.ts'
import type { Dict } from '../src/pyutil.ts'
import { exists, writeGateYaml } from './helpers/gate.ts'
import { makeIo, rmTree, tmpDir } from './helpers/node-io.ts'

const T0 = 1_700_000_000_000
const git = (cwd: string, ...args: string[]) => {
  const date = `@${Math.floor((T0 - 3_600_000) / 1000)} +0000`
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
}
const setMtime = (p: string, ms: number) => fs.utimesSync(p, ms / 1000, ms / 1000)

describe('Bash edits are checked by feedback rules', () => {
  let proj: string
  let fb: string

  beforeEach(() => {
    proj = tmpDir('bash-edit-proj-')
    fb = tmpDir('bash-edit-fb-')
  })
  afterEach(() => {
    rmTree(proj)
    rmTree(fb)
  })

  const io = () => makeIo({ projectDir: proj, now: () => T0, env: { CLAUDE_FEEDBACK_DIR: fb } })
  const payload = (command = "cat > src/a.ts <<'EOF' ... EOF", extra: Dict = {}): Dict => ({
    session_id: 'sess-1',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'tu1',
    cwd: proj,
    ...extra,
  })

  const writeRule = (name: string, count: number, enforce: string[]): void => {
    const content = ['---', `name: ${name}`, 'description: test', 'type: feedback', `count: ${count}`, 'enforce:', ...enforce, '---', '', 'body', ''].join('\n')
    fs.writeFileSync(path.join(fb, `${name}.md`), content, 'utf8')
  }
  const consoleLogPost = (count: number) =>
    writeRule('no_console_log', count, [
      '  - event: post_edit',
      "    path: 'src/**/*.ts'",
      "    when: '^\\s*console\\.log\\('",
      "    message: 'console.log を残さない'",
    ])
  const noAnyPre = (count: number) =>
    writeRule('no_any', count, ['  - event: pre_edit', "    path: 'src/**/*.ts'", "    when: ':\\s*any\\b'", "    message: 'any を書かない'"])

  /** git init して src/old.ts をコミットした PJ（開始時刻より前のコミット）。 */
  const initRepo = (gate: boolean) => {
    if (gate) writeGateYaml(proj, { rules: [] })
    git(proj, 'init', '-q')
    git(proj, 'config', 'user.email', 't@example.com')
    git(proj, 'config', 'user.name', 't')
    fs.writeFileSync(path.join(proj, '.gitignore'), '.claude/.gate-status/\n')
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
    fs.writeFileSync(path.join(proj, 'src', 'old.ts'), 'export const x: any = 1\n')
    git(proj, 'add', '.')
    git(proj, 'commit', '-q', '-m', 'init')
  }

  /** Bash が書いたことにする（開始以降の mtime）。 */
  const bashWrite = (rel: string, text: string) => {
    const abs = path.join(proj, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
    setMtime(abs, T0 + 500)
    return abs
  }

  const runBash = async (write: () => void, p: Dict = payload()) => {
    await bashStarted(io(), p)
    write()
    return bashChanges(io(), p)
  }

  test('a file written by Bash is blocked by a post_edit rule, like Edit / Write (with gate.yaml)', async () => {
    initRepo(true)
    consoleLogPost(4)
    const r = await runBash(() => bashWrite('src/a.ts', 'console.log(1)\n'))
    const out = JSON.parse(r.stdout)
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('no_console_log (count: 4): console.log を残さない (src/a.ts: content matched')
  })

  test('works without gate.yaml, keeping state out of the project', async () => {
    initRepo(false)
    consoleLogPost(4)
    await bashStarted(io(), payload())
    // 開始時刻は feedback 側の状態置き場に置く（PJ の .claude/ には何も作らない）
    expect(fs.readdirSync(path.join(fb, '.bash_started'))).toEqual(['bash_started.sess-1--tu1.json'])
    bashWrite('src/a.ts', 'console.log(1)\n')
    const r = await bashChanges(io(), payload())
    expect(JSON.parse(r.stdout).decision).toBe('block')
    expect(exists(path.join(proj, '.claude'))).toBe(false)
    expect(fs.readdirSync(path.join(fb, '.bash_started'))).toEqual([])
  })

  test('a clean file and files outside path are not blocked; count 1 only warns', async () => {
    initRepo(false)
    consoleLogPost(1)
    const r = await runBash(() => {
      bashWrite('src/a.ts', 'console.log(1)\n')
      bashWrite('src/b.ts', 'export {}\n')
      bashWrite('other/c.ts', 'console.log(1)\n')
    })
    expect(r.stdout).toBe('')
    const [warn, ...rest] = r.stderr.trimEnd().split('\n')
    expect(warn).toBe('[feedback-post-edit] warn: no_console_log (count: 1): console.log を残さない (src/a.ts)')
    // 残りは count の自動引き上げの通知だけ
    expect(rest).toHaveLength(1)
    expect(rest[0]).toContain('no_console_log の count を 1 → 2 に上げました')
  })

  test('violations in several files are merged into one block', async () => {
    initRepo(false)
    consoleLogPost(4)
    const r = await runBash(() => {
      bashWrite('src/a.ts', 'console.log(1)\n')
      bashWrite('src/b.ts', 'console.log(2)\n')
    })
    const reason: string = JSON.parse(r.stdout).reason
    expect(reason).toContain('(src/a.ts: ')
    expect(reason).toContain('(src/b.ts: ')
  })

  test('git history / working-tree commands are not checked', async () => {
    initRepo(false)
    consoleLogPost(4)
    const r = await runBash(() => bashWrite('src/a.ts', 'console.log(1)\n'), payload('git checkout -b feature'))
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  test('violations are logged', async () => {
    initRepo(false)
    consoleLogPost(4)
    await runBash(() => bashWrite('src/a.ts', 'console.log(1)\n'))
    const lines = fs.readFileSync(path.join(fb, '.violations.jsonl'), 'utf8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l))).toMatchObject([{ rule: 'no_console_log', event: 'post_edit', severity: 'block' }])
  })

  test('a broken rule file elsewhere does not disable the post_edit / pre_edit checks; it is logged', async () => {
    initRepo(false)
    consoleLogPost(4)
    // YAML として読めないファイル
    fs.writeFileSync(path.join(fb, 'aa_yaml.md'), "---\nname: aa_yaml\ncount: 3\nenforce:\n  - event: post_edit\n    path: 'it's'\n---\n", 'utf8')
    // Python 互換でない正規表現の要素（その要素だけ捨てる）と、enforce が辞書でないルール
    writeRule('aa_regex', 4, ['  - event: post_edit', "    path: 'src/**/*.ts'", "    when: 'x(?i)y'", "    message: 'x'"])
    writeRule('aa_null', 4, ['  -'])
    // 同じルール内の壊れた要素は飛ばし、正しい要素（pre_edit）は効く
    writeRule('no_any', 3, [
      '  - event: pre_edit',
      "    path: 'src/**/*.ts'",
      "    when: '(?<'",
      "    message: 'x'",
      '  - event: pre_edit',
      "    path: 'src/**/*.ts'",
      "    when: ':\\s*any\\b'",
      "    message: 'any を書かない'",
    ])
    const r = await runBash(() => bashWrite('src/a.ts', 'console.log(1)\nexport const y: any = 2\n'))
    const reason: string = JSON.parse(r.stdout).reason
    expect(reason).toContain('no_console_log (count: 4): console.log を残さない (src/a.ts: ')
    expect(reason).toContain('no_any (count: 3): any を書かない (src/a.ts: ')
    const errors = fs.readFileSync(path.join(fb, '.errors.jsonl'), 'utf8')
    for (const f of ['aa_yaml', 'aa_regex', 'aa_null', 'no_any']) expect(errors).toContain(path.join(fb, `${f}.md`))
    // 壊れた要素を持つルールでも count の自動引き上げは frontmatter の count 行だけを書き換える
    const noAny = fs.readFileSync(path.join(fb, 'no_any.md'), 'utf8')
    expect(readCountLine(noAny)).toBe(4)
    expect(noAny).toContain("when: '(?<'")
    expect(readCountLine(fs.readFileSync(path.join(fb, 'aa_yaml.md'), 'utf8'))).toBe(3)
  })

  test('an internal error is logged to .errors.jsonl and does not stop the work', async () => {
    initRepo(false)
    noAnyPre(4)
    const abs = bashWrite('src/a.ts', 'export const y: any = 2\n')
    const broken = io()
    broken.run = async () => {
      throw new Error('boom')
    }
    const r = await feedbackBashEdits(broken, payload(), [abs], T0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('[feedback-bash-edit] internal error (ignored): boom\n')
    expect(fs.readFileSync(path.join(fb, '.errors.jsonl'), 'utf8')).toContain('"source":"feedback-bash-edit"')
  })

  describe('count auto bump', () => {
    const countOf = (name: string) => readCountLine(fs.readFileSync(path.join(fb, `${name}.md`), 'utf8'))

    test('a post_edit violation in a file written by Bash raises the count once per session', async () => {
      initRepo(false)
      consoleLogPost(3)
      const r = await runBash(() => bashWrite('src/a.ts', 'console.log(1)\n'))
      expect(countOf('no_console_log')).toBe(4)
      const reason: string = JSON.parse(r.stdout).reason
      expect(reason).toContain('no_console_log (count: 3)')
      expect(reason).toContain('no_console_log の count を 3 → 4 に上げました')

      // 同じセッションでの 2 回目は上げない
      const r2 = await runBash(() => bashWrite('src/b.ts', 'console.log(2)\n'), payload(undefined, { tool_use_id: 'tu2' }))
      expect(JSON.parse(r2.stdout).reason).toContain('no_console_log (count: 4)')
      expect(r2.stdout).not.toContain('上げました')
      expect(countOf('no_console_log')).toBe(4)

      // 別のセッションならまた上がる
      await runBash(() => bashWrite('src/c.ts', 'console.log(3)\n'), payload(undefined, { session_id: 'sess-2' }))
      expect(countOf('no_console_log')).toBe(5)
    })

    test('a warn-level violation also raises the count, with the note on stderr', async () => {
      initRepo(false)
      consoleLogPost(1)
      const r = await runBash(() => bashWrite('src/a.ts', 'console.log(1)\n'))
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain('no_console_log の count を 1 → 2 に上げました')
      expect(countOf('no_console_log')).toBe(2)
    })

    test('a pre_edit violation detected after the command raises the count', async () => {
      initRepo(false)
      noAnyPre(3)
      const r = await runBash(() => bashWrite('src/new.ts', 'export const y: any = 2\n'))
      expect(JSON.parse(r.stdout).reason).toContain('no_any の count を 3 → 4 に上げました')
      expect(countOf('no_any')).toBe(4)
    })

    test('autoCount=false leaves the count alone', async () => {
      initRepo(false)
      consoleLogPost(4)
      const p = payload()
      const off = () => makeIo({ projectDir: proj, now: () => T0, env: { CLAUDE_FEEDBACK_DIR: fb }, autoCount: false })
      await bashStarted(off(), p)
      bashWrite('src/a.ts', 'console.log(1)\n')
      const r = await bashChanges(off(), p)
      expect(JSON.parse(r.stdout).decision).toBe('block')
      expect(r.stdout).not.toContain('上げました')
      expect(countOf('no_console_log')).toBe(4)
    })
  })

  describe('pre_edit (checked after the command)', () => {
    test('a new file whose content matches when is blocked, saying it was detected after the command', async () => {
      initRepo(false)
      noAnyPre(5)
      const r = await runBash(() => bashWrite('src/a.ts', 'export const y: any = 2\n'))
      const reason: string = JSON.parse(r.stdout).reason
      expect(reason).toContain('[feedback-guard] no_any (count: 5): any を書かない (src/a.ts: content matched')
      expect(reason).toContain('実行後に検知しました')
    })

    test('only the lines this command added to a tracked file are matched', async () => {
      initRepo(false)
      noAnyPre(5)
      // old.ts には元から ": any" があるが、このコマンドが足したのは別の行
      const clean = await runBash(() => bashWrite('src/old.ts', 'export const x: any = 1\nexport const z = 3\n'))
      expect(clean.stdout).toBe('')
      const dirty = await runBash(
        () => bashWrite('src/old.ts', 'export const x: any = 1\nexport const z = 3\nexport const w: any = 4\n'),
        payload('sed -i ...', { tool_use_id: 'tu2' }),
      )
      expect(JSON.parse(dirty.stdout).reason).toContain('no_any')
    })

    test('lines committed within the same command are matched', async () => {
      initRepo(false)
      noAnyPre(5)
      const p = payload('cat > src/old.ts && git commit -am wip')
      await bashStarted(io(), p)
      bashWrite('src/old.ts', 'export const x: any = 1\nexport const w: any = 4\n')
      const date = `@${Math.floor((T0 + 1000) / 1000)} +0000`
      execFileSync('git', ['commit', '-qam', 'wip'], { cwd: proj, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
      const r = await bashChanges(io(), p)
      expect(JSON.parse(r.stdout).reason).toContain('no_any')
    })

    test('absent_sibling: an implementation written without its test is blocked; with the test it passes', async () => {
      initRepo(false)
      writeRule('tdd', 4, ['  - event: pre_edit', "    path: 'src/**/*.ts'", "    absent_sibling: '{stem}.test.ts'", "    message: 'テストを先に書く'"])
      const bad = await runBash(() => bashWrite('src/foo.ts', 'export {}\n'))
      expect(JSON.parse(bad.stdout).reason).toContain('tdd (count: 4): テストを先に書く (src/foo.ts: missing test file: foo.test.ts)')
      // 違反で count が 5（deny）に上がるので、残しておくと次の実行でも block になる。テストのある側だけを確かめる。
      fs.rmSync(path.join(proj, 'src', 'foo.ts'))
      const good = await runBash(
        () => {
          bashWrite('src/bar.ts', 'export {}\n')
          bashWrite('src/bar.test.ts', 'test\n')
        },
        payload('python3 gen.py', { tool_use_id: 'tu2' }),
      )
      expect(good.stdout).toBe('')
    })

    test('an ask already answered for the same file in this session is downgraded to warn', async () => {
      initRepo(false)
      noAnyPre(3)
      const first = await runBash(() => bashWrite('src/a.ts', 'export const y: any = 2\n'))
      expect(JSON.parse(first.stdout).decision).toBe('block')
      const second = await runBash(() => bashWrite('src/a.ts', 'export const y: any = 3\n'), payload('sed -i ...', { tool_use_id: 'tu2' }))
      expect(second.stdout).toBe('')
      // 1 回目の違反で count は 4 に上がっている（4 でもまだ ask なので、承認済みとして warn に落ちる）
      expect(second.stderr).toContain('[feedback-guard] warn: no_any (count: 4)')
    })
  })
})

describe('addedLines', () => {
  test('takes only the added lines inside hunks', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1,2 @@',
      '-old',
      '+new',
      '+++ starts with pluses',
      'diff --git a/y b/y',
      '+++ b/y',
      '@@ -0,0 +1 @@',
      '+y',
    ].join('\n')
    expect(addedLines(diff)).toEqual(['new', '++ starts with pluses', 'y'])
  })
})

describe('Bash edits: scope', () => {
  let proj: string
  let fb: string
  beforeEach(() => {
    proj = tmpDir('bash-edit-scope-proj-')
    fb = tmpDir('bash-edit-scope-fb-')
  })
  afterEach(() => {
    rmTree(proj)
    rmTree(fb)
  })

  test('scope applies to files rewritten by Bash for post_edit and pre_edit', async () => {
    const content = [
      '---',
      'name: scoped',
      'description: t',
      'type: feedback',
      'count: 4',
      'enforce:',
      '  - event: post_edit',
      "    path: 'src/**/*.ts'",
      "    when: '^//(?! TODO)'",
      '    scope: comments',
      "    message: 'comment form'",
      '---',
      '',
      'b',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(fb, 'scoped.md'), content)
    const io = () => makeIo({ projectDir: proj, now: () => T0, env: { CLAUDE_FEEDBACK_DIR: fb } })
    const p: Dict = { session_id: 's', tool_name: 'Bash', tool_input: { command: 'cat > src/a.ts' }, tool_use_id: 'tu1', cwd: proj }
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
    git(proj, 'init', '-q')
    await bashStarted(io(), p)
    const abs = path.join(proj, 'src', 'a.ts')
    fs.writeFileSync(abs, 'const s = "// x"\n// bad\n')
    setMtime(abs, T0 + 500)
    const r = await bashChanges(io(), p)
    expect(JSON.parse(r.stdout).reason).toContain('comment matched: ^//(?! TODO) (line 2)')

    // 文字列中の同じ文言だけなら違反にならない
    const p2: Dict = { ...p, tool_use_id: 'tu2' }
    await bashStarted(io(), p2)
    fs.writeFileSync(abs, 'const s = "// x"\n')
    setMtime(abs, T0 + 600)
    expect((await bashChanges(io(), p2)).stdout).toBe('')
  })
})
