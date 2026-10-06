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
 * 先頭の (?i) / (?s) / (?m) と名前付きグループ (?P<name>...) だけは読み替える。
 */
export function pyRegExp(source: string, flags = ''): RegExp {
  let src = source
  let fl = flags
  const m = /^\(\?([aiLmsux]+)\)/.exec(src)
  if (m) {
    src = src.slice(m[0].length)
    for (const c of m[1] ?? '') if ('ims'.includes(c) && !fl.includes(c)) fl += c
  }
  src = src.replace(/\(\?P<([A-Za-z_]\w*)>/g, '(?<$1>').replace(/\(\?P=([A-Za-z_]\w*)\)/g, '\\k<$1>')
  return new RegExp(src, fl)
}

/** jq の `.x // empty`（null / false は空）+ `-r`（文字列はそのまま）に相当する取り出し。 */
export function jqStr(v: unknown): string {
  if (v === null || v === undefined || v === false) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}

export type Dict = Record<string, unknown>

export const isDict = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v)
