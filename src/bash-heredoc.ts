// Bash コマンドのうち、実行前に「どのファイルに何を書くか」が文面から分かる heredoc の書き込みを取り出す。
// PreToolUse(Bash) で Edit / Write と同じ pre_edit の検査（feedback-guard.ts）を掛け、PostToolUse(Bash) の
// 実行後の pre_edit（feedback-bash-edit.ts）はこれらのファイルを飛ばす（二重に判定しない）ため。
//
// 拾う形（`<<` の直後の `-` と、区切り語の引用 'EOF' / "EOF" / \EOF はどれでもよい）:
//   cat > path <<'EOF' ... EOF        cat <<EOF >> path ... EOF        cat - <<EOF > path
//   tee path <<EOF / tee -a path <<EOF
//   cat <<EOF | tee path [| tee -a other] ... EOF
// 本文は区切り行まで（`<<-` なら各行の先頭のタブを落とす）で、Write の content と同じく書かれる内容そのもの。
// 区切り語が引用されていない heredoc の `$VAR` や `$(...)` は bash が展開するが、ここでは文面のまま扱う。
//
// 拾わないもの（PostToolUse の実行後の検査に任せる）:
//   - 書き先が `$VAR` / `$(...)` / バッククォートを含む、`~` で始まる（HOME が分からないとき）、/dev/null
//   - 本文を加工するコマンド（`sed ... <<EOF > out`、`cat <<EOF | sort > out`、`python - <<EOF` など）
//   - 区切り行が見つからない heredoc
//   - `cd dir && cat > rel <<EOF` の cd（相対パスは常にコマンドの cwd 起点とみなす）
import { expandUser, isAbsolute, join } from './path.ts'

export type HeredocWrite = {
  /** 書き先の絶対パス。 */
  file: string
  /** 書かれる内容（heredoc の本文。各行に改行付き）。 */
  content: string
  /** `>>` / `tee -a` による追記か。 */
  append: boolean
}

type Tok = { kind: 'word' | 'op'; text: string; dynamic: boolean; quoted: boolean }

const SPLIT_OPS = new Set(['|', '||', '&&', ';', '&', '(', ')'])

/** 1 行をクォートを考慮して語と演算子に分ける。クォートは外し、`$` / バッククォートを含む（展開される）語は dynamic。 */
export function tokenizeLine(line: string): Tok[] {
  const toks: Tok[] = []
  let word = ''
  let dynamic = false
  let quoted = false
  let has = false
  const flush = () => {
    if (has) toks.push({ kind: 'word', text: word, dynamic, quoted })
    word = ''
    dynamic = false
    quoted = false
    has = false
  }
  const op = (text: string) => toks.push({ kind: 'op', text, dynamic: false, quoted: false })
  let i = 0
  while (i < line.length) {
    const c = line[i] ?? ''
    if (c === ' ' || c === '\t') {
      flush()
      i++
      continue
    }
    if (c === '#' && !has) break
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      const body = end === -1 ? line.slice(i + 1) : line.slice(i + 1, end)
      word += body
      has = true
      quoted = true
      i = end === -1 ? line.length : end + 1
      continue
    }
    if (c === '"') {
      i++
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) {
          i++
        } else if (line[i] === '$' || line[i] === '`') dynamic = true
        word += line[i]
        i++
      }
      i++
      has = true
      quoted = true
      continue
    }
    if (c === '\\') {
      if (i + 1 < line.length) word += line[i + 1]
      has = true
      quoted = true // `\EOF` は引用扱い
      i += 2
      continue
    }
    if (c === '<' || c === '>') {
      // 直前に付いた数字はファイル記述子（2> など）: その語は捨て、リダイレクトは対象外にする
      const fd = has && /^\d+$/.test(word)
      if (fd) {
        word = ''
        has = false
      } else flush()
      if (c === '<' && line[i + 1] === '<' && line[i + 2] === '<') {
        op('<<<')
        i += 3
        continue
      }
      if (c === '<' && line[i + 1] === '<') {
        i += 2
        if (line[i] === '-') {
          op('<<-')
          i++
        } else op('<<')
        continue
      }
      let text = c
      i++
      if (c === '>' && line[i] === '>') {
        text = '>>'
        i++
      }
      if (line[i] === '&') {
        // `>&2` / `>&-`: 記述子の複製。次の語は書き先ではない
        text = 'fd'
        i++
      } else if (fd) text = 'fd'
      op(text)
      continue
    }
    if (c === '&' && line[i + 1] === '>') {
      // `&> path` / `&>> path`: stdout と stderr をまとめて書く（内容は本文のままなので対象にする）
      flush()
      i += 2
      if (line[i] === '>') {
        op('>>')
        i++
      } else op('>')
      continue
    }
    if (c === '|' || c === '&' || c === ';' || c === '(' || c === ')') {
      flush()
      if ((c === '|' || c === '&') && line[i + 1] === c) {
        op(c + c)
        i += 2
      } else {
        op(c)
        i++
      }
      continue
    }
    if (c === '$' || c === '`') dynamic = true
    word += c
    has = true
    i++
  }
  flush()
  return toks
}

type Heredoc = { delim: string; stripTabs: boolean; content: string; terminated: boolean }
type Redirect = { append: boolean; target: Tok }
type Segment = { sep: string; words: Tok[]; redirects: Redirect[]; heredocs: Heredoc[] }

/** 1 行の語を `|` / `&&` / `||` / `;` / `&` / `(` / `)` で区切り、各区切りの語・リダイレクト・heredoc に分ける。 */
function segmentsOf(toks: Tok[]): Segment[] {
  const segs: Segment[] = []
  let cur: Segment = { sep: '', words: [], redirects: [], heredocs: [] }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok
    if (t.kind === 'word') {
      cur.words.push(t)
      continue
    }
    if (SPLIT_OPS.has(t.text)) {
      segs.push(cur)
      cur = { sep: t.text, words: [], redirects: [], heredocs: [] }
      continue
    }
    const next = toks[i + 1]
    const arg = next?.kind === 'word' ? next : undefined
    if (arg) i++
    if (t.text === '<<' || t.text === '<<-') {
      if (arg) cur.heredocs.push({ delim: arg.text, stripTabs: t.text === '<<-', content: '', terminated: false })
    } else if (t.text === '>' || t.text === '>>') {
      if (arg) cur.redirects.push({ append: t.text === '>>', target: arg })
    }
    // `<`, `<<<`, `fd`: 引数を読み飛ばすだけ
  }
  segs.push(cur)
  return segs
}

const nameOf = (t: Tok | undefined): string => (t?.text ?? '').replace(/^.*\//, '')

/** `cat` が本文をそのまま流すか（`-` / `--` 以外の引数やオプションがあれば加工されうる）。 */
const isPlainCat = (words: Tok[]): boolean => nameOf(words[0]) === 'cat' && words.slice(1).every((w) => w.text === '-' || w.text === '--')

const TEE_FLAGS = new Set(['-i', '--ignore-interrupts', '-p', '--output-error'])

/** `tee` の書き先（オプション以外の引数）と追記かどうか。tee でなければ undefined。 */
function teeTargets(words: Tok[]): { targets: Tok[]; append: boolean } | undefined {
  if (nameOf(words[0]) !== 'tee') return undefined
  const targets: Tok[] = []
  let append = false
  for (const w of words.slice(1)) {
    if (w.text === '-a' || w.text === '--append') append = true
    else if (TEE_FLAGS.has(w.text) || w.text.startsWith('--output-error=')) continue
    else if (w.text.startsWith('-') && !w.quoted && w.text !== '-')
      return undefined // 知らないオプション
    else targets.push(w)
  }
  return { targets, append }
}

/** 書き先の語を絶対パスにする。展開される語・/dev/null・HOME 無しの `~` は undefined。 */
function resolveTarget(t: Tok, cwd: string, home: string | undefined): string | undefined {
  if (t.dynamic || t.text === '' || t.text === '/dev/null' || t.text === '-') return undefined
  let p = t.text
  if (p.startsWith('~')) {
    if (!home) return undefined
    p = expandUser(p, home)
  }
  return isAbsolute(p) ? p : join(cwd, p)
}

/**
 * command に書かれた heredoc の書き込みを、書き先ごとにまとめて返す（出現順。同じファイルへ複数回書く場合は内容を順につなぐ）。
 * 相対パスは cwd 起点。
 */
export function heredocWrites(command: string, cwd: string, home?: string): HeredocWrite[] {
  const lines = command.split('\n')
  const out: HeredocWrite[] = []
  const add = (file: string, content: string, append: boolean) => {
    const prev = out.find((w) => w.file === file)
    if (prev) prev.content += content
    else out.push({ file, content, append })
  }

  let i = 0
  while (i < lines.length) {
    const segs = segmentsOf(tokenizeLine(lines[i] ?? ''))
    const heredocs = segs.flatMap((s) => s.heredocs)
    let next = i + 1
    for (const h of heredocs) {
      const body: string[] = []
      while (next < lines.length) {
        const raw = lines[next] ?? ''
        const l = h.stripTabs ? raw.replace(/^\t+/, '') : raw
        next++
        if (l === h.delim) {
          h.terminated = true
          break
        }
        body.push(l)
      }
      h.content = body.map((l) => `${l}\n`).join('')
      if (!h.terminated) break
    }
    i = next

    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s] as Segment
      if (seg.heredocs.length === 0) continue
      const h = seg.heredocs[seg.heredocs.length - 1] as Heredoc // 複数あれば最後のものが stdin になる
      if (!h.terminated) continue
      const targets: Array<{ file: string; append: boolean }> = []
      const push = (t: Tok, append: boolean) => {
        const file = resolveTarget(t, cwd, home)
        if (file !== undefined) targets.push({ file, append })
      }
      const tee = teeTargets(seg.words)
      if (tee) for (const t of tee.targets) push(t, tee.append)
      else if (!isPlainCat(seg.words)) continue
      const last = seg.redirects[seg.redirects.length - 1]
      if (last) push(last.target, last.append)
      // `| tee path` の連鎖（tee 以外のコマンドに渡った先は本文のままとは限らないので見ない）
      for (let p = s + 1; p < segs.length && (segs[p] as Segment).sep === '|'; p++) {
        const ps = segs[p] as Segment
        const pt = teeTargets(ps.words)
        if (!pt) break
        for (const t of pt.targets) push(t, pt.append)
        const pr = ps.redirects[ps.redirects.length - 1]
        if (pr) push(pr.target, pr.append)
      }
      for (const t of targets) add(t.file, h.content, t.append)
    }
  }
  return out
}
