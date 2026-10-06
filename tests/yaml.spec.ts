import { describe, expect, test } from 'bun:test'
import { parseYaml } from '../src/load-yaml.ts'

describe('parseYaml (yaml package, YAML 1.1 schema like PyYAML)', () => {
  test('scalars, nested maps and block sequences', () => {
    const doc = parseYaml(
      [
        'name: sample',
        'count: 4',
        'ratio: 1.5',
        'enabled: true',
        'disabled: false',
        'nothing:',
        'tilde: ~',
        'nested:',
        '  a: 1',
        '  b:',
        '    - x',
        '    - y',
        '',
      ].join('\n'),
    )
    expect(doc).toEqual({ name: 'sample', count: 4, ratio: 1.5, enabled: true, disabled: false, nothing: null, tilde: null, nested: { a: 1, b: ['x', 'y'] } })
  })

  test('sequence at the same indent as its key, sequence of mappings', () => {
    expect(parseYaml('run:\n- a\n- b\nnext: 1\n')).toEqual({ run: ['a', 'b'], next: 1 })
    const doc = parseYaml(
      ['rules:', '  - match: "**/*.py"', '    run:', '      - ruff check .', '      - cmd: pytest -q', '        timeout: 60', '  - match: [a, b]', ''].join(
        '\n',
      ),
    )
    expect(doc).toEqual({ rules: [{ match: '**/*.py', run: ['ruff check .', { cmd: 'pytest -q', timeout: 60 }] }, { match: ['a', 'b'] }] })
  })

  test('quoted scalars keep regex backslashes in single quotes', () => {
    expect(parseYaml(["a: 'go (test|vet)\\b'", "b: 'it''s'", 'c: "tab\\there"'].join('\n'))).toEqual({ a: 'go (test|vet)\\b', b: "it's", c: 'tab\there' })
  })

  test('block scalars', () => {
    expect(parseYaml('run:\n  - |\n    echo a\n    echo b\n  - echo c\n')).toEqual({ run: ['echo a\necho b\n', 'echo c'] })
  })

  test('JSON is valid input', () => {
    const obj = { rules: [{ match: '**/*.py', per_file_dir: true, run: ['echo "hi: there"', { cmd: 'x', timeout: 3 }] }], policy: false }
    expect(parseYaml(JSON.stringify(obj))).toEqual(obj)
  })

  test('empty documents are null', () => {
    expect(parseYaml('')).toBeNull()
    expect(parseYaml('# only a comment\n')).toBeNull()
  })

  // PyYAML との互換性（YAML 1.1）を固定する。
  test('YAML 1.1 booleans: yes/no/on/off are booleans, as in PyYAML', () => {
    expect(parseYaml('a: yes\nb: off\nc: On\nd: No\n')).toEqual({ a: true, b: false, c: true, d: false })
  })

  test('duplicate keys: the last one wins, as in PyYAML', () => {
    expect(parseYaml('a: 1\na: 2\n')).toEqual({ a: 2 })
  })

  test('y / n are plain strings, as in PyYAML (the yaml package treats them as booleans in 1.1 mode)', () => {
    expect(parseYaml('a: y\nb: n\nc: [y, n]\n')).toEqual({ a: 'y', b: 'n', c: ['y', 'n'] })
  })

  test('anchors, aliases and merge keys are supported', () => {
    expect(parseYaml('base: &b {x: 1}\nuse:\n  <<: *b\n  z: 2\n')).toEqual({ base: { x: 1 }, use: { x: 1, z: 2 } })
  })

  test('malformed YAML throws', () => {
    expect(() => parseYaml('a: [1, 2\n')).toThrow()
    expect(() => parseYaml('a: 1\n  b: 2\n')).toThrow()
  })
})

describe('differences from the YAML 1.2 parser built into Bun (why the 1.1 schema is pinned)', () => {
  test('yes/no stay strings under YAML 1.2', () => {
    expect(Bun.YAML.parse('a: yes\n')).toEqual({ a: 'yes' })
    expect(parseYaml('a: yes\n')).toEqual({ a: true })
  })
})
