import { describe, expect, test } from 'bun:test'
import { isKnownLang, langOf, type Segment, scanCode, stripToCode } from '../src/code-scan.ts'

const texts = (src: string, lang: string, kind?: Segment['kind']): string[] =>
  scanCode(src, lang)
    .filter((s) => kind === undefined || s.kind === kind)
    .map((s) => s.text)

describe('langOf / isKnownLang', () => {
  test('extensions and file names', () => {
    expect(langOf('src/a.ts')).toBe('ts')
    expect(langOf('src/a.d.ts')).toBe('ts')
    expect(langOf('/x/y/Main.KT')).toBe('kt')
    expect(langOf('Dockerfile')).toBe('dockerfile')
    expect(langOf('docker/Dockerfile.dev')).toBe('dockerfile')
    expect(langOf('Makefile')).toBe('makefile')
    expect(langOf('rules.mk')).toBe('makefile')
    expect(langOf('a.unknownext')).toBeUndefined()
    expect(langOf('README')).toBeUndefined()
    expect(langOf('.gitignore')).toBeUndefined()
  })
  test('known ids', () => {
    for (const id of ['ts', 'go', 'rs', 'py', 'rb', 'sql', 'lua', 'html', 'css', 'yaml', 'dockerfile', 'makefile', 'mk', 'TS'])
      expect(isKnownLang(id)).toBe(true)
    expect(isKnownLang('cobol')).toBe(false)
    expect(isKnownLang('toString')).toBe(false)
  })
})

describe('scanCode', () => {
  test('// inside a string is not a comment, a quote inside a comment is not a string', () => {
    const src = 'const u = "http://x" // it\'s "fine"\n/* a " b */ const v = \'//\'\n'
    expect(texts(src, 'ts', 'comment')).toEqual(['// it\'s "fine"', '/* a " b */'])
    expect(texts(src, 'ts', 'string')).toEqual(['"http://x"', "'//'"])
  })
  test('escapes', () => {
    expect(texts('x = "a\\"// b" // c', 'ts')).toEqual(['"a\\"// b"', '// c'])
  })
  test('JS template literals, including ${ } with nested strings', () => {
    const src = 'const a = `x ${"}"} // y ${`n ${1}`} z` // c\n'
    expect(texts(src, 'ts')).toEqual(['`x ${"}"} // y ${`n ${1}`} z`', '// c'])
  })
  test('JS regex literal with a quote is skipped, division is not a regex', () => {
    expect(texts('const r = /"/g // c\n', 'ts')).toEqual(['// c'])
    expect(texts('const q = a / b // c "d"\n', 'ts')).toEqual(['// c "d"'])
  })
  test('Python triple quotes and prefixes', () => {
    const src = 'x = f"a # b"  # c\ny = r"""\n# not a comment\n"""\nz = \'\'\'q\'\'\'\n'
    expect(texts(src, 'py', 'comment')).toEqual(['# c'])
    expect(texts(src, 'py', 'string')).toEqual(['"a # b"', '"""\n# not a comment\n"""', "'''q'''"])
  })
  test('Go raw strings have no escapes, rune literals are strings', () => {
    const src = "a := `C:\\` // c\nb := 'x'\n"
    expect(texts(src, 'go')).toEqual(['`C:\\`', '// c', "'x'"])
  })
  test('Rust: lifetimes are not strings, char literals and raw strings are', () => {
    const src = "fn f<'a>(x: &'a str) -> &'a str { let c = 'x'; let n = '\\n'; let r = r#\"a \"b\" // c\"#; x } // end\n"
    expect(texts(src, 'rs', 'string')).toEqual(["'x'", "'\\n'", 'r#"a "b" // c"#'])
    expect(texts(src, 'rs', 'comment')).toEqual(['// end'])
  })
  test('Rust nested block comments', () => {
    expect(texts('/* a /* b */ c */ let x = 1;', 'rs')).toEqual(['/* a /* b */ c */'])
  })
  test('Ruby =begin / =end and # comments', () => {
    const src = 'a = 1\n=begin\nhello "\n=end\nb = "x#y" # c\n'
    expect(texts(src, 'rb', 'comment')).toEqual(['=begin\nhello "\n=end', '# c'])
    expect(texts(src, 'rb', 'string')).toEqual(['"x#y"'])
  })
  test('SQL: -- comments, block comments, doubled quotes', () => {
    const src = "SELECT 'it''s -- x' -- real\n/* b */\n"
    expect(texts(src, 'sql')).toEqual(["'it''s -- x'", '-- real', '/* b */'])
  })
  test('Lua: -- and --[[ ]]', () => {
    const src = 's = "a -- b" --[[ x\ny ]] t = [[ -- z ]] -- end\n'
    expect(texts(src, 'lua')).toEqual(['"a -- b"', '--[[ x\ny ]]', '[[ -- z ]]', '-- end'])
  })
  test('shell: # only at a word start', () => {
    const src = 'echo "a # b" $# a#b # c\n'
    expect(texts(src, 'sh')).toEqual(['"a # b"', '# c'])
  })
  test('YAML: apostrophes in plain scalars are not strings', () => {
    const src = "a: it's fine # c\nb: 'x # y'\nc: \"z\"\n"
    expect(texts(src, 'yaml', 'comment')).toEqual(['# c'])
    expect(texts(src, 'yaml', 'string')).toEqual(["'x # y'", '"z"'])
  })
  test('HTML comments only', () => {
    const src = '<!-- a\nb --><p class="x">don\'t</p><!-- c -->'
    expect(texts(src, 'html')).toEqual(['<!-- a\nb -->', '<!-- c -->'])
  })
  test('PHP has // and # comments but #[ is an attribute', () => {
    expect(texts('<?php #[Attr] $a = "x"; # c\n// d\n', 'php')).toEqual(['"x"', '# c', '// d'])
  })
  test('CSS has block comments and strings only', () => {
    expect(texts('a { content: "x /* y */"; } /* z */', 'css')).toEqual(['"x /* y */"', '/* z */'])
  })
  test('unknown language yields no segments', () => {
    expect(scanCode('// x "y"', 'cobol')).toEqual([])
  })
  test('line numbers are 1-based and point at the segment start', () => {
    const src = 'a\n// one\nb\n/* two\nthree */\n"s"\n'
    expect(scanCode(src, 'ts').map((s) => [s.kind, s.line])).toEqual([
      ['comment', 2],
      ['comment', 4],
      ['string', 6],
    ])
  })
  test('unterminated string and comment run to the end of the file', () => {
    expect(texts('a = "abc\nb', 'ts')).toEqual(['"abc\nb'])
    expect(texts('a /* abc\nb', 'ts')).toEqual(['/* abc\nb'])
    expect(texts('a """abc\nb', 'py')).toEqual(['"""abc\nb'])
  })
  test('line comments exclude the line break (also CRLF)', () => {
    expect(texts('a // c\r\nb', 'ts')).toEqual(['// c'])
  })
})

describe('stripToCode', () => {
  test('keeps length and line breaks, blanks comments and strings', () => {
    const src = 'const a = "x // y" // c\n/* m\nn */ console.log(`t`)\n'
    const out = stripToCode(src, 'ts')
    expect(out.length).toBe(src.length)
    expect(out.split('\n').length).toBe(src.split('\n').length)
    expect(out).toBe(`const a = ${' '.repeat(8)} ${' '.repeat(4)}\n${' '.repeat(4)}\n${' '.repeat(4)} console.log(${' '.repeat(3)})\n`)
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') expect(out[i]).toBe('\n')
  })
  test('unknown language is returned as is; unterminated comment is blanked to the end', () => {
    expect(stripToCode('// x', 'cobol')).toBe('// x')
    expect(stripToCode('a /* b\nc', 'ts')).toBe('a     \n ')
  })
})
