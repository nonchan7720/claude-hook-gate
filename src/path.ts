// POSIX パス操作。hook モジュールは Node の組み込みを使えない環境で動くので自前で持つ。
// 挙動は Python の os.path（posixpath）に合わせている。

export const isAbsolute = (p: string): boolean => p.startsWith('/')

/** Python の os.path.join と同じ。後ろの要素が絶対パスならそこから作り直す（正規化はしない）。 */
export function join(...parts: string[]): string {
  let out = ''
  for (const part of parts) {
    if (part.startsWith('/')) out = part
    else if (out === '' || out.endsWith('/')) out += part
    else out += `/${part}`
  }
  return out
}

/** Python の os.path.normpath と同じ。 */
export function normpath(p: string): string {
  if (p === '') return '.'
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      const last = out[out.length - 1]
      if (last !== undefined && last !== '..') out.pop()
      else if (!abs) out.push('..')
    } else {
      out.push(seg)
    }
  }
  const joined = out.join('/')
  if (abs) return `/${joined}`
  return joined === '' ? '.' : joined
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/') + 1
  const head = p.slice(0, i)
  if (head !== '' && head !== '/'.repeat(head.length)) return head.replace(/\/+$/, '')
  return head
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** [拡張子を除いた部分, 拡張子]。先頭のドット（隠しファイル）は拡張子と見なさない。 */
export function splitext(p: string): [string, string] {
  const base = basename(p)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || /^\.+$/.test(base.slice(0, dot))) return [p, '']
  const cut = p.length - base.length + dot
  return [p.slice(0, cut), p.slice(cut)]
}

/** Python の os.path.relpath。引数は絶対パス（または共通の基準からの相対パス）を想定する。 */
export function relpath(path: string, start: string): string {
  const a = normpath(path).split('/').filter(Boolean)
  const b = normpath(start).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const rel = [...b.slice(i).map(() => '..'), ...a.slice(i)]
  return rel.length === 0 ? '.' : rel.join('/')
}

/** 先頭の ~（単独、または ~/ 始まり）を home に展開する。home が無ければそのまま返す。 */
export function expandUser(p: string, home: string | undefined): string {
  if (!home) return p
  if (p === '~') return home
  if (p.startsWith('~/')) return home.replace(/\/+$/, '') + p.slice(1)
  return p
}
