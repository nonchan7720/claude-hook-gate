import { describe, expect, test } from 'bun:test'
import picomatch from 'picomatch'
import { compileGlobs, expandBraces, globExists, globToRegex, matchPatterns } from '../src/glob.ts'
import { touch } from './helpers/gate.ts'
import { makeIo, withTmp } from './helpers/node-io.ts'

const matches = (pattern: string, p: string): boolean => compileGlobs([pattern]).some((rx) => rx.test(p))

describe('glob semantics (ported from the Python implementation)', () => {
  test('* does not cross /, ** does, **/ allows zero levels', () => {
    expect(matches('*.go', 'foo.go')).toBe(true)
    expect(matches('*.go', 'pkg/foo.go')).toBe(false)
    expect(matches('**/*.go', 'foo.go')).toBe(true)
    expect(matches('**/*.go', 'a/b/foo.go')).toBe(true)
    expect(matches('pkg/**', 'pkg/a/b.go')).toBe(true)
  })

  test('? and character classes', () => {
    expect(matches('a?.txt', 'ab.txt')).toBe(true)
    expect(matches('a?.txt', 'a/.txt')).toBe(false)
    expect(matches('[ab].txt', 'a.txt')).toBe(true)
    expect(matches('[!ab].txt', 'c.txt')).toBe(true)
    expect(matches('[!ab].txt', 'a.txt')).toBe(false)
  })

  test('brace expansion, including nesting and a single alternative', () => {
    expect(expandBraces('a.{yml,yaml}')).toEqual(['a.yml', 'a.yaml'])
    expect(expandBraces('{a,b{c,d}}x')).toEqual(['ax', 'bcx', 'bdx'])
    expect(expandBraces('{only}')).toEqual(['only'])
    expect(matchPatterns(['pkg/{a,b}/**']).map(([t]) => t)).toEqual(['pkg/a/**', 'pkg/b/**'])
  })

  test('regex metacharacters in literals are escaped', () => {
    expect(new RegExp(globToRegex('a+b(c).go')).test('a+b(c).go')).toBe(true)
    expect(new RegExp(globToRegex('a+b(c).go')).test('aab(c).go')).toBe(false)
  })
})

// 汎用ライブラリ（picomatch）とは意図的に挙動が違う箇所。元の Python 実装に合わせて自前実装を維持している理由を固定する。
describe('differences from picomatch', () => {
  const pm = (pattern: string, p: string) => picomatch(pattern, { dot: true })(p)

  test('** inside a segment crosses directories in the original, not in picomatch', () => {
    expect(matches('a**b', 'a/x/b')).toBe(true)
    expect(pm('a**b', 'a/x/b')).toBe(false)
  })

  test('a single-alternative brace is unwrapped in the original', () => {
    expect(expandBraces('{stem}_test.go')).toEqual(['stem_test.go'])
    expect(picomatch('{stem}_test.go', { dot: true })('stem_test.go')).toBe(false)
  })

  test('the common patterns agree', () => {
    for (const [pattern, p] of [
      ['**/*.go', 'a/b/c.go'],
      ['**/*.go', 'c.go'],
      ['*.md', 'README.md'],
      ['*.md', 'docs/README.md'],
      ['pkg/{domain,infrastructure}/**', 'pkg/domain/x.go'],
      ['pkg/{domain,infrastructure}/**', 'pkg/other/x.go'],
      ['**/*_test.go', 'pkg/a_test.go'],
      ['**/README.md', 'README.md'],
    ] as const) {
      expect(matches(pattern, p)).toBe(pm(pattern, p))
    }
  })
})

describe('globExists (filesystem walk, Python glob.glob semantics)', () => {
  test('literal, wildcard and recursive patterns', () =>
    withTmp(async (dir) => {
      const io = makeIo({ projectDir: dir })
      touch(dir, 'spec', 'models', 'user_spec.rb')
      touch(dir, 'lib', 'a.rb')
      expect(await globExists(io, `${dir}/spec/**/user_spec.rb`)).toBe(true)
      expect(await globExists(io, `${dir}/spec/*/user_spec.rb`)).toBe(true)
      expect(await globExists(io, `${dir}/spec/*.rb`)).toBe(false)
      expect(await globExists(io, `${dir}/lib/a.rb`)).toBe(true)
      expect(await globExists(io, `${dir}/lib/b.rb`)).toBe(false)
      expect(await globExists(io, `${dir}/nope/**/x.rb`)).toBe(false)
    }))

  test('hidden entries are not matched by wildcards unless the pattern says so', () =>
    withTmp(async (dir) => {
      const io = makeIo({ projectDir: dir })
      touch(dir, '.hidden', 'x_spec.rb')
      expect(await globExists(io, `${dir}/**/x_spec.rb`)).toBe(false)
      expect(await globExists(io, `${dir}/.hidden/x_spec.rb`)).toBe(true)
      expect(await globExists(io, `${dir}/.h*/x_spec.rb`)).toBe(true)
    }))
})
