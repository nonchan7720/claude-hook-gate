// Python 由来の挙動（真偽判定・repr・int()・正規表現の書き方）を TypeScript で再現する小物。

/** Python の bool(value) と同じ真偽判定（空のリスト・辞書、0、空文字は偽）。 */
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (v !== null && typeof v === 'object') return Object.keys(v).length > 0
  return Boolean(v)
}

/** Python の repr() の近似（メッセージに値を埋め込む用）。 */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    const quote = v.includes("'") && !v.includes('"') ? '"' : "'"
    const body = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`
  if (typeof v === 'object') {
    return `{${Object.entries(v)
      .map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`)
      .join(', ')}}`
  }
  return String(v)
}

/** `int(value or 0)` を try/except で包んだ呼び出しと同じ。変換できなければ 0。 */
export function toCount(v: unknown): number {
  if (!truthy(v)) return 0
  if (typeof v === 'number') return Math.trunc(v)
  if (v === true) return 1
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10)
  return 0
}

/**
 * Python の re 形式の正規表現を JavaScript の RegExp にする。
 * 先頭の (?i) / (?s) / (?m) と名前付きグループ (?P<name>...) / (?P=name) を読み替える。
 * JS では黙って意味が変わる \A（文字列の先頭）と \Z / \z（文字列の末尾）は、m フラグの有無によらず
 * 同じ意味になる後読み・先読み（(?<![\s\S]) / (?![\s\S])）に置き換える（m フラグ付きの ^ / $ は行頭・行末にも一致するため）。
 * 対応できない書き方（先頭の (?x) など）や JS で不正な正規表現は例外を投げる（呼び出し側がその要素だけを無効にする）。
 */
export function pyRegExp(source: string, flags = ''): RegExp {
  let src = source
  let fl = flags
  const m = /^\(\?([aiLmsux]+)\)/.exec(src)
  if (m) {
    src = src.slice(m[0].length)
    const pyFlags = m[1] ?? ''
    if (pyFlags.includes('x')) throw new Error(`unsupported Python inline flag (?x): ${source}`)
    for (const c of pyFlags) if ('ims'.includes(c) && !fl.includes(c)) fl += c
  }
  src = replaceAnchors(src)
    .replace(/\(\?P<([A-Za-z_]\w*)>/g, '(?<$1>')
    .replace(/\(\?P=([A-Za-z_]\w*)\)/g, '\\k<$1>')
  return new RegExp(src, fl)
}

/** 文字クラスの外にある \A / \Z / \z を、文字列の先頭・末尾にだけ一致する先読み・後読みに置き換える。 */
function replaceAnchors(src: string): string {
  let out = ''
  let inClass = false
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i)
    if (c === '\\') {
      const next = src.charAt(i + 1)
      if (!inClass && next === 'A') out += '(?<![\\s\\S])'
      else if (!inClass && (next === 'Z' || next === 'z')) out += '(?![\\s\\S])'
      else out += c + next
      i++
      continue
    }
    if (c === '[' && !inClass) {
      inClass = true
      out += c
      // 先頭の ^ の直後の ] はクラスの中身（Python では []] / [^]] の ] は文字。JS では [] が空のクラスになるのでエスケープする）
      if (src.charAt(i + 1) === '^') out += src.charAt(++i)
      if (src.charAt(i + 1) === ']') {
        i++
        out += '\\]'
      }
      continue
    }
    if (c === ']' && inClass) inClass = false
    out += c
  }
  return out
}

/** jq の `.x // empty`（null / false は空）+ `-r`（文字列はそのまま）に相当する取り出し。 */
export function jqStr(v: unknown): string {
  if (v === null || v === undefined || v === false) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}

export type Dict = Record<string, unknown>

export const isDict = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v)
