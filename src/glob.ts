// glob の解釈: * は / を跨がない、** は跨ぐ、{a,b} 展開、?、[..]。
// gate.yaml の match と feedback ルールの path / changed / exclude_path で共通。
import type { Io } from './io.ts'
import { join } from './path.ts'

function splitTopCommas(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const c of s) {
    if (c === '{') {
      depth++
      cur += c
    } else if (c === '}') {
      depth--
      cur += c
    } else if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  parts.push(cur)
  return parts
}

export function expandBraces(s: string): string[] {
  let depth = 0
  let start = -1
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        const pre = s.slice(0, start)
        const inner = s.slice(start + 1, i)
        const post = s.slice(i + 1)
        const out: string[] = []
        for (const part of splitTopCommas(inner)) out.push(...expandBraces(pre + part + post))
        return out
      }
    }
  }
  return [s]
}

const escapeRegex = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

export function globToRegex(pat: string): string {
  const n = pat.length
  let i = 0
  let out = '^'
  while (i < n) {
    const c = pat.charAt(i)
    if (c === '*') {
      let j = i
      while (j < n && pat.charAt(j) === '*') j++
      if (j - i >= 2) {
        if (j < n && pat.charAt(j) === '/') {
          out += '(?:.*/)?' // **/ は 0 階層も許可
          i = j + 1
        } else {
          out += '.*'
          i = j
        }
      } else {
        out += '[^/]*'
        i++
      }
    } else if (c === '?') {
      out += '[^/]'
      i++
    } else if (c === '[') {
      let j = i + 1
      if (j < n && '!^'.includes(pat.charAt(j))) j++
      if (j < n && pat.charAt(j) === ']') j++
      while (j < n && pat.charAt(j) !== ']') j++
      let cls = pat.slice(i, j + 1)
      if (cls.startsWith('[!')) cls = `[^${cls.slice(2)}`
      out += cls
      i = j + 1
    } else {
      out += escapeRegex(c)
      i++
    }
  }
  return `${out}$`
}

export type PatternPair = [text: string, rx: RegExp]

/**
 * パターン文字列のリストをブレース展開し、(展開後パターン文字列, 正規表現) のペアを
 * match に書かれた順→ブレース展開順で返す。per_file_dir のルート抽出には展開後の
 * パターン文字列自体が必要。
 */
export function matchPatterns(pats: Iterable<string>): PatternPair[] {
  const pairs: PatternPair[] = []
  for (const pat of pats) {
    for (const ex of expandBraces(pat)) pairs.push([ex, new RegExp(globToRegex(ex))])
  }
  return pairs
}

export const compileGlobs = (patterns: Iterable<string>): RegExp[] => matchPatterns(patterns).map(([, rx]) => rx)

/** 文字列 or リスト（または未指定）を文字列リストにそろえる。 */
export function asList(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v as string[]
  return []
}

// ---- ファイルシステム上の glob（Python の glob.glob(recursive=True) 相当、存在判定だけ） ----
const hasMagic = (seg: string): boolean => /[*?[]/.test(seg)

/** pattern（絶対パス、または base からの相対）にマッチするパスが 1 つでも存在するか。 */
export async function globExists(io: Io, pattern: string): Promise<boolean> {
  const abs = pattern.startsWith('/')
  const segs = pattern.split('/').filter((s) => s !== '')
  return walk(io, abs ? '/' : '', segs, 0)
}

async function walk(io: Io, dir: string, segs: string[], i: number): Promise<boolean> {
  if (i >= segs.length) return dir === '' ? true : io.exists(dir)
  const seg = segs.at(i) ?? ''
  const here = dir === '' ? '.' : dir
  if (seg === '**') {
    if (i === segs.length - 1) return (await io.stat(here))?.kind === 'dir'
    if (await walk(io, dir, segs, i + 1)) return true
    for (const e of await io.list(here)) {
      if (e.name.startsWith('.')) continue
      const sub = join(dir, e.name)
      if ((await io.stat(sub))?.kind === 'dir' && (await walk(io, sub, segs, i))) return true
    }
    return false
  }
  if (!hasMagic(seg)) return walk(io, join(dir, seg), segs, i + 1)
  const rx = new RegExp(globToRegex(seg))
  for (const e of await io.list(here)) {
    if (e.name.startsWith('.') && !seg.startsWith('.')) continue
    if (!rx.test(e.name)) continue
    if (await walk(io, join(dir, e.name), segs, i + 1)) return true
  }
  return false
}
