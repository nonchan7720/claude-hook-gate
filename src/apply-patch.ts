// Codex の apply_patch ツール（tool_name: apply_patch）の入力を、Edit / Write の tool_input の形に読み替える。
//
// Codex はファイルの編集を 1 つのパッチ（下の形式）で行い、hook にはパッチ全文が tool_input.command として届く
// （Claude Code の Edit / Write のような file_path / content / new_string は無い）。feedback の pre_edit / post_edit や
// gate の変更ファイルの記録はファイル単位で動くので、パッチをファイルごとに分け、Add File は Write（content = 全文）、
// Update File は Edit（new_string = 追加された行）として扱う。Delete File は検査の対象外（ファイルが無くなる）。
//
//   *** Begin Patch
//   *** Add File: path/to/new.py
//   +line
//   *** Update File: path/to/existing.py
//   *** Move to: path/to/renamed.py        （任意）
//   @@ context
//    unchanged
//   -removed
//   +added
//   *** End of File                         （任意）
//   *** Delete File: path/to/old.py
//   *** End Patch
//
// パスは cwd 相対（絶対パスも可）。相対パスは payload の cwd（無ければ Io の cwd）を起点に絶対パスへ直す。
import { isAbsolute, join } from './path.ts'
import { type Dict, isDict } from './pyutil.ts'

export type PatchOp = 'add' | 'update' | 'delete'

export type PatchFile = {
  op: PatchOp
  /** パッチに書かれたままのパス。 */
  path: string
  /** Update File の Move to（移動先）。 */
  movedTo?: string
  /** 追加された行（先頭の + を除いたもの）を改行でつないだもの。Add File では新しいファイルの全文。 */
  added: string
}

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'

/** tool_input からパッチ本文を取り出す。command（現行）→ input / patch（古い形）の順。 */
export function patchText(toolInput: unknown): string {
  if (!isDict(toolInput)) return ''
  for (const key of ['command', 'input', 'patch']) {
    const v = toolInput[key]
    if (typeof v === 'string' && v.includes(BEGIN)) return v
  }
  return ''
}

/** パッチ本文をファイルごとに分ける。パッチの形をしていなければ空配列。 */
export function parsePatch(text: string): PatchFile[] {
  const begin = text.indexOf(BEGIN)
  if (begin < 0) return []
  const body = text.slice(begin + BEGIN.length)
  const end = body.indexOf(END)
  const lines = (end < 0 ? body : body.slice(0, end)).split('\n')
  const files: PatchFile[] = []
  let current: (PatchFile & { lines: string[] }) | undefined
  const flush = () => {
    if (!current) return
    const { lines: added, ...file } = current
    files.push({ ...file, added: added.join('\n') })
    current = undefined
  }
  const header = (line: string, prefix: string): string | undefined => (line.startsWith(prefix) ? line.slice(prefix.length).trim() : undefined)
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const add = header(line, '*** Add File:')
    const update = header(line, '*** Update File:')
    const del = header(line, '*** Delete File:')
    const move = header(line, '*** Move to:')
    if (add !== undefined) {
      flush()
      current = { op: 'add', path: add, added: '', lines: [] }
    } else if (update !== undefined) {
      flush()
      current = { op: 'update', path: update, added: '', lines: [] }
    } else if (del !== undefined) {
      flush()
      files.push({ op: 'delete', path: del, added: '' })
    } else if (move !== undefined) {
      if (current?.op === 'update' && move !== '') current.movedTo = move
    } else if (current && line.startsWith('+')) {
      current.lines.push(line.slice(1))
    }
    // それ以外（@@ の行、文脈行、削除行、*** End of File）は読み飛ばす。
  }
  flush()
  return files
}

/** パッチ内のパスを絶対パスにする（相対パスは base 起点）。 */
export const absolutePath = (p: string, base: string): string => (isAbsolute(p) ? p : join(base, p))

/**
 * apply_patch の payload を、ファイルごとの Edit / Write の payload に分ける（Delete File は除く）。
 * 共通のキー（session_id / cwd / tool_use_id / agent_id など）はそのまま写し、tool_name と tool_input を差し替える。
 * 移動を伴う更新は移動先のパスで扱う（パッチ適用後にファイルがある場所）。
 */
export function patchPayloads(payload: Dict, base: string): Dict[] {
  const files = parsePatch(patchText(payload.tool_input))
  const out: Dict[] = []
  for (const f of files) {
    if (f.op === 'delete') continue
    const filePath = absolutePath(f.movedTo ?? f.path, base)
    const toolInput: Dict = f.op === 'add' ? { file_path: filePath, content: f.added } : { file_path: filePath, old_string: '', new_string: f.added }
    out.push({ ...payload, tool_name: f.op === 'add' ? 'Write' : 'Edit', tool_input: toolInput })
  }
  return out
}
