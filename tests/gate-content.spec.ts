import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseContentChecks } from '../src/gate.ts'
import { exists, lines, checks as runChecks, rules as runRules, statePath, writeChangedFiles, writeGateYaml } from './helpers/gate.ts'
import { withTmp } from './helpers/node-io.ts'

const put = (proj: string, rel: string, text: string) => {
  const p = path.join(proj, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}
const commentRule = { name: 'comment-format', scope: 'comments', when: '^//(?! (TODO|NOTE)\\(\\w+\\): )', message: 'use // TODO(name): form' }
const failedPath = (proj: string, id: string) => statePath(proj, 'gate_failed', id, 'txt')

describe('gate content checks', () => {
  test('a comment violation fails the rules phase with path:line message', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: 'src/**/*.ts', content: [commentRule] }] })
      put(proj, 'src/a.ts', 'const x = 1\n// bad comment\n')
      writeChangedFiles(proj, 'sess1', 'src/a.ts')
      const r = await runRules(proj)
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain('src/a.ts:2 use // TODO(name): form (')
      expect(r.stderr).toContain('(line 2)')
    }))

  test('the same text only inside a string literal passes (content-only rule, no run)', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: 'src/**/*.ts', content: [commentRule] }] })
      put(proj, 'src/a.ts', 'const s = "// bad comment"\n// TODO(me): ok\n')
      writeChangedFiles(proj, 'sess1', 'src/a.ts')
      const r = await runRules(proj)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('content:comment-format')
      expect(exists(failedPath(proj, 'sess1'))).toBe(false)
    }))

  test('content is evaluated first, then run still executes', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '*.ts', content: [commentRule], run: ['echo RAN-RUN'] }] })
      put(proj, 'a.ts', '// bad\n')
      writeChangedFiles(proj, 'sess1', 'a.ts')
      const r = await runRules(proj)
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain('a.ts:1 use // TODO(name): form')
      expect(r.stderr).toContain('RAN-RUN')
      expect(r.stderr.indexOf('a.ts:1')).toBeLessThan(r.stderr.indexOf('=== [gate] (.) $ echo RAN-RUN'))
    }))

  test('exclude drops files, lang overrides the extension, unknown extension finds nothing for comments', () =>
    withTmp(async (proj) => {
      const excl = { ...commentRule, exclude: ['src/**/*.spec.ts'] }
      const hash = { name: 'hash', scope: 'comments', lang: 'py', when: '^# bad', message: 'no bad' }
      writeGateYaml(proj, { rules: [{ match: ['src/**/*.ts', '**/*.txt', '**/*.zzz'], content: [excl, hash] }] })
      put(proj, 'src/a.spec.ts', '// bad\n')
      put(proj, 'notes.zzz', '// bad\n# bad\n')
      writeChangedFiles(proj, 'sess1', 'src/a.spec.ts')
      expect((await runRules(proj)).exitCode).toBe(0)
      // lang: py reads "# bad" in a .txt file as a comment
      put(proj, 'n.txt', '# bad\n')
      writeChangedFiles(proj, 'sess1', 'n.txt')
      const r = await runRules(proj)
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain('n.txt:1 no bad')
      // the unknown-extension file has no lang for the first entry: no violation from comments
      writeGateYaml(proj, { rules: [{ match: '**/*.zzz', content: [commentRule] }] })
      writeChangedFiles(proj, 'sess2', 'notes.zzz')
      expect((await runRules(proj, 'sess2')).exitCode).toBe(0)
    }))

  test('a failed file is kept in gate_failed and passes at Stop once fixed', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: 'src/**/*.ts', content: [commentRule] }] })
      put(proj, 'src/a.ts', '// bad\n')
      writeChangedFiles(proj, 'sess1', 'src/a.ts')
      expect((await runRules(proj)).exitCode).toBe(2)
      expect(lines(failedPath(proj, 'sess1'))).toEqual(['src/a.ts'])
      const blocked = await runChecks(proj)
      expect(blocked.exitCode).toBe(2)
      expect(blocked.stderr).toContain('src/a.ts:1 use // TODO(name): form')
      put(proj, 'src/a.ts', '// TODO(me): fixed\n')
      const r = await runChecks(proj)
      expect(r.stdout).toContain('content:comment-format')
      expect(exists(failedPath(proj, 'sess1'))).toBe(false)
    }))

  test('an unreadable file is skipped without a violation', () =>
    withTmp(async (proj) => {
      writeGateYaml(proj, { rules: [{ match: '*.ts', content: [commentRule] }] })
      writeChangedFiles(proj, 'sess1', 'gone.ts')
      expect((await runRules(proj)).exitCode).toBe(0)
    }))

  const badCases: Array<[string, unknown, string]> = [
    ['missing message', [{ when: 'x' }], 'content[0].message'],
    ['invalid scope', [{ when: 'x', message: 'm', scope: 'everything' }], 'content[0].scope'],
    ['invalid regex', [{ when: '(', message: 'm' }], 'content[0].when'],
    ['unknown lang', [{ when: 'x', message: 'm', lang: 'nope-lang' }], 'content[0].lang'],
    ['not a list', { when: 'x', message: 'm' }, 'content must be a list'],
    ['item not a mapping', ['x'], 'content[0] must be a mapping'],
  ]
  for (const [title, content, reason] of badCases) {
    test(`invalid config (${title}) skips the rule, logs the reason and fails the phase`, () =>
      withTmp(async (proj) => {
        writeGateYaml(proj, { rules: [{ match: '*.ts', content, run: ['echo SHOULD-NOT-RUN'] }] })
        put(proj, 'a.ts', '// whatever\n')
        writeChangedFiles(proj, 'sess1', 'a.ts')
        const r = await runRules(proj)
        expect(r.exitCode).toBe(2)
        expect(r.stderr).toContain(reason)
        expect(r.stderr).not.toContain('SHOULD-NOT-RUN')
        expect(lines(failedPath(proj, 'sess1'))).toEqual(['a.ts'])
      }))
  }

  test('parseContentChecks generates a name from when', () => {
    const r = parseContentChecks([{ when: '^//x', message: 'm' }])
    expect(typeof r).not.toBe('string')
    expect((r as Array<{ name: string }>)[0]?.name).toBe('x')
  })
})
