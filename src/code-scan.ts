// 軽量な字句解析器: ソースコードを「コメント」「文字列リテラル」「それ以外（コード）」に切り分ける。
//
// 構文解析ではなく字句レベルの 1 パスの状態機械。feedback ルールの enforce `scope:` が、when / unless を
// 当てる範囲（コメントだけ・文字列だけ・コードだけ）を選ぶために使う。純 TS・依存なし。
//
// 既知の限界: 文字列補間の入れ子（JS/TS のテンプレートリテラルの `${ }` 以外）、Ruby の %q や正規表現リテラル、
// シェルの heredoc、Perl の POD、Swift の `\( )` 補間、C++ の数字区切り `1'000`、HTML 内の <script> / <style>
// などは正しく扱わない。閉じられていない文字列・コメントはファイル末尾まで続くものとして扱う。
// そのほか:
//  - JSX / TSX のテキスト中のアポストロフィは、直前が識別子文字なら（`don't`）文字列を始めないが、`it 's` のように
//    直前が空白だと文字列の開始とみなす（JSX テキスト）。
//  - JS/TS の正規表現リテラルは、直前の文字から判断する。`)` の直後（`if (x) /"/.test(y)`）は除算とみなす。
//  - YAML のブロックスカラー（`|` / `>`）の中で行頭に来た引用符は、文字列を開く。
//  - C# の verbatim 文字列 `@"a""b"` は 2 つの文字列に割れる。
//  - `.vue` / `.svelte` は `<!-- -->` だけを見る（`<script>` / `<style>` の中のコメントや文字列は見ない）。
//  - SCSS / Less の `//` は、直前が `:` のとき（`url(http://...)`）はコメントにしない。
//  - `make` は makefile の別名（言語 id の一覧にはない。isKnownLang は真）。

export type Segment = { kind: 'comment' | 'string'; text: string; line: number }

type Range = { kind: 'comment' | 'string'; start: number; end: number }

type Def = {
  /** 行コメントの開始記号。 */
  line?: string[]
  /** ブロックコメントの [開始, 終了]。 */
  block?: Array<[string, string]>
  /** ブロックコメントの入れ子を許す。 */
  nest?: boolean
  /** 文字列を作る引用符。 */
  quotes?: string
  /** 三重引用文字列の引用符。 */
  triple?: string[]
  /** エスケープ（バックスラッシュ）を持たない引用符。 */
  rawQuotes?: string
  /** 同じ引用符を 2 つ重ねるとその引用符 1 つを表す引用符（SQL / YAML）。 */
  dbl?: string
  /** `#` は空白・行頭・`;&|()` の直後にあるときだけコメント（シェル系）。 */
  hashBoundary?: boolean
  /** エスケープを持たない三重引用文字列の区切り（Kotlin / Scala の `"""`、TOML の `'''`）。triple のうちここに無いものはエスケープを持つ。 */
  rawTriple?: string[]
  /** SCSS / Less: 直前が `:` の `//`（URL）は行コメントにしない。 */
  colonGuard?: boolean
  /** JS 系: テンプレートリテラルの `${ }` と正規表現リテラル。 */
  js?: boolean
  /** Rust: 文字リテラルとライフタイムの区別、raw 文字列。 */
  rust?: boolean
  /** C++: R"delim( ... )delim"。 */
  cppRaw?: boolean
  /** Ruby: =begin 〜 =end。 */
  rubyBegin?: boolean
  /** Lua: [[ ]] / [=[ ]=] の長い括弧（文字列と --[[ ]] コメント）。 */
  lua?: boolean
  /** YAML: 引用符は値の位置（行頭・`:` `-` `[` `{` `,` `?` の直後）でだけ文字列を始める。 */
  yamlQuote?: boolean
  /** PHP: `#[` は属性でありコメントではない。 */
  phpAttr?: boolean
}

const CBLOCK: Array<[string, string]> = [['/*', '*/']]
const CFAMILY: Def = { line: ['//'], block: CBLOCK, quotes: '"\'`' }
const HASH: Def = { line: ['#'], quotes: '"\'' }
const SHELL: Def = { line: ['#'], quotes: '"\'', rawQuotes: "'", hashBoundary: true }

const DEFS: Record<string, Def> = {}
const define = (ids: string[], def: Def): void => {
  for (const id of ids) DEFS[id] = def
}

define(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'], { ...CFAMILY, js: true })
define(['go'], { ...CFAMILY, rawQuotes: '`' })
define(['rs'], { line: ['//'], block: CBLOCK, nest: true, quotes: '"', rust: true })
define(['java'], { line: ['//'], block: CBLOCK, quotes: '"\'', triple: ['"""'] })
define(['kt', 'kts', 'scala'], { line: ['//'], block: CBLOCK, nest: true, quotes: '"\'', triple: ['"""'], rawTriple: ['"""'] })
define(['swift'], { line: ['//'], block: CBLOCK, nest: true, quotes: '"', triple: ['"""'] })
define(['c', 'h'], { line: ['//'], block: CBLOCK, quotes: '"\'' })
define(['cpp', 'hpp', 'cc', 'cxx'], { line: ['//'], block: CBLOCK, quotes: '"\'', cppRaw: true })
define(['cs'], { line: ['//'], block: CBLOCK, quotes: '"\'', triple: ['"""'] })
define(['dart'], { line: ['//'], block: CBLOCK, nest: true, quotes: '"\'', triple: ['"""', "'''"] })
define(['php'], { line: ['//', '#'], block: CBLOCK, quotes: '"\'`', phpAttr: true })

define(['py'], { ...HASH, triple: ['"""', "'''"] })
define(['rb'], { ...HASH, quotes: '"\'`', rubyBegin: true })
define(['sh', 'bash', 'zsh', 'makefile', 'mk', 'dockerfile'], SHELL)
define(['yaml', 'yml'], { line: ['#'], quotes: '"\'', dbl: "'", rawQuotes: "'", hashBoundary: true, yamlQuote: true })
define(['toml'], { line: ['#'], quotes: '"\'', rawQuotes: "'", triple: ['"""', "'''"], rawTriple: ["'''"] })
define(['pl'], HASH)
define(['r'], { line: ['#'], quotes: '"\'`' })

define(['sql'], { line: ['--'], block: CBLOCK, quotes: '"\'`', rawQuotes: '"\'`', dbl: '"\'`' })
define(['lua'], { line: ['--'], quotes: '"\'', lua: true })

define(['html', 'htm', 'xml', 'vue', 'svelte'], { block: [['<!--', '-->']] })
define(['css'], { block: CBLOCK, quotes: '"\'' })
define(['scss', 'less'], { line: ['//'], block: CBLOCK, quotes: '"\'', colonGuard: true })

const EXT_ALIAS: Record<string, string> = { mk: 'makefile', make: 'makefile' }
const FILE_NAMES: Record<string, string> = { makefile: 'makefile', gnumakefile: 'makefile' }

const normalizeId = (id: string): string => {
  const lower = id.toLowerCase()
  return EXT_ALIAS[lower] ?? lower
}

/** 言語 id として知っているか（大文字小文字は区別しない）。 */
export function isKnownLang(id: string): boolean {
  return Object.hasOwn(DEFS, normalizeId(id))
}

/** ファイルパスから言語 id を決める（拡張子、または Dockerfile / Makefile などのファイル名）。分からなければ undefined。 */
export function langOf(filePath: string): string | undefined {
  const name = (filePath.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (name === '') return undefined
  const byName = FILE_NAMES[name]
  if (byName) return byName
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = normalizeId(name.slice(dot + 1))
  return Object.hasOwn(DEFS, ext) ? ext : undefined
}

const isIdentChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c)

/** `/` が正規表現リテラルの開始になりうるか（直前の意味のある文字から判断する）。 */
function regexAllowed(text: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && /\s/.test(text.charAt(j))) j--
  if (j < 0) return true
  const c = text.charAt(j)
  if ('(,=:[!&|?{};+-*%~^'.includes(c)) return true
  if (isIdentChar(c)) {
    let k = j
    while (k >= 0 && isIdentChar(text.charAt(k))) k--
    return /^(return|typeof|case|do|else|in|of|void|delete|throw|new|yield|await)$/.test(text.slice(k + 1, j + 1))
  }
  return false
}

/** 正規表現リテラル `/.../flags` の終端を返す。同じ行で閉じなければ -1（除算とみなす）。 */
function regexEnd(text: string, i: number): number {
  let j = i + 1
  let inClass = false
  while (j < text.length) {
    const c = text.charAt(j)
    if (c === '\n') return -1
    if (c === '\\') j += 2
    else if (c === '[') {
      inClass = true
      j++
    } else if (c === ']') {
      inClass = false
      j++
    } else if (c === '/' && !inClass) return j + 1
    else j++
  }
  return -1
}

/** 本文を 1 パスで走査し、コメントと文字列リテラルの範囲を返す。 */
function scanRanges(text: string, def: Def): Range[] {
  const n = text.length
  const out: Range[] = []

  /** 正規表現リテラルの探索が失敗した行の終端。同じ行の以降の `/` は再探索しない（二乗時間の防止）。 */
  let regexFailedUntil = -1

  const atLineStart = (i: number): boolean => i === 0 || text.charAt(i - 1) === '\n'

  /** 行コメントの終端（改行・CR の手前）。 */
  const lineEnd = (i: number): number => {
    let j = text.indexOf('\n', i)
    if (j < 0) j = n
    if (j > i && text.charAt(j - 1) === '\r') j--
    return j
  }

  /** ブロックコメントの終端（閉じ記号の後ろ）。閉じなければ n。入れ子を許す言語では対応を数える。 */
  const blockEnd = (i: number, open: string, close: string): number => {
    let depth = 1
    let j = i + open.length
    while (j < n) {
      if (def.nest && text.startsWith(open, j)) {
        depth++
        j += open.length
      } else if (text.startsWith(close, j)) {
        depth--
        j += close.length
        if (depth === 0) return j
      } else j++
    }
    return n
  }

  /** エスケープ付きの引用符文字列の終端。閉じなければ n。 */
  const quoteEnd = (i: number, q: string): number => {
    const raw = def.rawQuotes?.includes(q) ?? false
    const dbl = def.dbl?.includes(q) ?? false
    let j = i + 1
    while (j < n) {
      const c = text.charAt(j)
      if (c === '\\' && !raw) j += 2
      else if (c === q) {
        if (dbl && text.charAt(j + 1) === q) j += 2
        else return j + 1
      } else j++
    }
    return n
  }

  /** 終端文字列 close までの範囲の終端（閉じなければ n）。 */
  const untilEnd = (from: number, close: string, escapes: boolean): number => {
    let j = from
    while (j < n) {
      if (escapes && text.charAt(j) === '\\') j += 2
      else if (text.startsWith(close, j)) return j + close.length
      else j++
    }
    return n
  }

  /** JS のテンプレートリテラルの終端。`${ }` の中は括弧の深さを数えて飛ばす。 */
  const templateEnd = (i: number): number => {
    let j = i + 1
    while (j < n) {
      const c = text.charAt(j)
      if (c === '\\') j += 2
      else if (c === '`') return j + 1
      else if (c === '$' && text.charAt(j + 1) === '{') j = scan(j + 2, true, null)
      else j++
    }
    return n
  }

  /** Rust の ' が文字リテラルなら終端、ライフタイムなら -1。 */
  const rustCharEnd = (i: number): number => {
    if (text.charAt(i + 1) === '\\') {
      const close = text.indexOf("'", i + 3)
      return close >= 0 && close - i <= 12 ? close + 1 : -1
    }
    const cp = text.codePointAt(i + 1)
    if (cp === undefined || cp === 0x27 || cp === 0x0a) return -1
    const len = cp > 0xffff ? 2 : 1
    return text.charAt(i + 1 + len) === "'" ? i + 2 + len : -1
  }

  /** Rust の raw 文字列 r"..." / r#"..."# / br"..." の終端。raw 文字列でなければ -1。 */
  const rustRawEnd = (i: number): number => {
    let j = i
    if (text.charAt(j) === 'b') j++
    if (text.charAt(j) !== 'r') return -1
    j++
    let hashes = 0
    while (text.charAt(j) === '#') {
      hashes++
      j++
    }
    if (text.charAt(j) !== '"') return -1
    return untilEnd(j + 1, `"${'#'.repeat(hashes)}`, false)
  }

  /** C++ の R"delim( ... )delim" の終端。なければ -1。 */
  const cppRawEnd = (i: number): number => {
    const m = /^(?:u8|u|U|L)?R"([^()\\\s]{0,16})\(/.exec(text.slice(i, i + 32))
    if (!m) return -1
    return untilEnd(i + m[0].length, `)${m[1] ?? ''}"`, false)
  }

  /** Lua の長い括弧 [[ / [=[ の開始から、対応する閉じまでの終端。開始でなければ -1。 */
  const luaLongEnd = (i: number): number => {
    const m = /^\[(=*)\[/.exec(text.slice(i, i + 40))
    if (!m) return -1
    return untilEnd(i + m[0].length, `]${m[1] ?? ''}]`, false)
  }

  const hashIsComment = (i: number): boolean => {
    const prev = i > 0 ? text.charAt(i - 1) : ''
    if (prev === '$') return false
    if (def.hashBoundary && prev !== '' && !/[\s;&|()]/.test(prev)) return false
    if (def.phpAttr && text.charAt(i + 1) === '[') return false
    return true
  }

  const quoteAllowed = (i: number): boolean => {
    if (!def.yamlQuote) return true
    let j = i - 1
    while (j >= 0 && (text.charAt(j) === ' ' || text.charAt(j) === '\t')) j--
    return j < 0 || '\n:-[{,?'.includes(text.charAt(j))
  }

  /**
   * i から走査する。stopAtBrace なら、対応する `}` の直後で戻る（テンプレートの `${ }` 用）。
   * sink が null なら範囲は記録しない。
   */
  function scan(from: number, stopAtBrace: boolean, sink: Range[] | null): number {
    let depth = 0
    let i = from
    const emit = (kind: 'comment' | 'string', end: number): void => {
      sink?.push({ kind, start: i, end })
      i = end
    }
    while (i < n) {
      const c = text.charAt(i)

      if (stopAtBrace) {
        if (c === '{') depth++
        else if (c === '}') {
          if (depth === 0) return i + 1
          depth--
        }
      }

      if (def.rubyBegin && c === '=' && atLineStart(i) && text.startsWith('=begin', i)) {
        const m = /^=end\b.*$/m.exec(text.slice(i + 6))
        emit('comment', m ? i + 6 + m.index + m[0].length : n)
        continue
      }

      if (def.lua && c === '-' && text.startsWith('--', i)) {
        const long = text.charAt(i + 2) === '[' ? luaLongEnd(i + 2) : -1
        emit('comment', long >= 0 ? long : lineEnd(i))
        continue
      }

      const block = def.block?.find(([open]) => text.startsWith(open, i))
      if (block) {
        emit('comment', blockEnd(i, block[0], block[1]))
        continue
      }
      const lineStart = def.line?.find((s) => text.startsWith(s, i))
      if (lineStart && (lineStart !== '#' || hashIsComment(i)) && !(def.colonGuard && text.charAt(i - 1) === ':')) {
        emit('comment', lineEnd(i))
        continue
      }

      if (def.rust && (c === 'r' || c === 'b') && !isIdentChar(text.charAt(i - 1))) {
        const end = rustRawEnd(i)
        if (end >= 0) {
          emit('string', end)
          continue
        }
      }
      if (def.cppRaw && (c === 'R' || c === 'u' || c === 'U' || c === 'L') && !isIdentChar(text.charAt(i - 1))) {
        const end = cppRawEnd(i)
        if (end >= 0) {
          emit('string', end)
          continue
        }
      }
      if (def.rust && c === '"') {
        emit('string', quoteEnd(i, '"'))
        continue
      }
      if (def.rust && c === "'") {
        const end = rustCharEnd(i)
        if (end >= 0) emit('string', end)
        else i++
        continue
      }
      if (def.lua && c === '[') {
        const end = luaLongEnd(i)
        if (end >= 0) {
          emit('string', end)
          continue
        }
      }

      const triple = def.triple?.find((t) => text.startsWith(t, i))
      if (triple) {
        emit('string', untilEnd(i + 3, triple, !def.rawTriple?.includes(triple)))
        continue
      }

      if (def.js && c === '`') {
        emit('string', templateEnd(i))
        continue
      }
      if (def.js && c === '/') {
        let end = -1
        if (i >= regexFailedUntil && regexAllowed(text, i)) {
          end = regexEnd(text, i)
          if (end < 0) regexFailedUntil = lineEnd(i)
        }
        i = end >= 0 ? end : i + 1
        continue
      }

      // JS/TS には文字列プレフィックスが無いので、識別子文字の直後の引用符は文字列ではない（JSX テキストの `don't`）。
      if (def.quotes?.includes(c) && quoteAllowed(i) && !(def.js && isIdentChar(text.charAt(i - 1)))) {
        emit('string', quoteEnd(i, c))
        continue
      }
      i++
    }
    return n
  }

  scan(0, false, out)
  return out
}

const defOf = (lang: string): Def | undefined => {
  const id = normalizeId(lang)
  return Object.hasOwn(DEFS, id) ? DEFS[id] : undefined
}

/** 各位置の行番号（1 始まり）を求める関数。 */
function lineIndex(text: string): (pos: number) => number {
  const nl: number[] = []
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) nl.push(i)
  return (pos) => {
    let lo = 0
    let hi = nl.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((nl[mid] as number) < pos) lo = mid + 1
      else hi = mid
    }
    return lo + 1
  }
}

/** コメントと文字列リテラルを出現順に 1 つずつ返す（区切り記号を含む原文）。未知の言語は空。 */
export function scanCode(text: string, lang: string): Segment[] {
  const def = defOf(lang)
  if (!def) return []
  const lineAt = lineIndex(text)
  return scanRanges(text, def).map((r) => ({ kind: r.kind, text: text.slice(r.start, r.end), line: lineAt(r.start) }))
}

/** コメントと文字列リテラル（区切り記号を含む）を同じ長さの空白に置き換える。改行は残す。未知の言語はそのまま。 */
export function stripToCode(text: string, lang: string): string {
  const def = defOf(lang)
  if (!def) return text
  let out = ''
  let pos = 0
  for (const r of scanRanges(text, def)) {
    out += text.slice(pos, r.start) + text.slice(r.start, r.end).replace(/[^\r\n]/g, ' ')
    pos = r.end
  }
  return out + text.slice(pos)
}
