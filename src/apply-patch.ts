// Codex の apply_patch（tool_input.command がパッチ全文）を、ファイルごとの Edit / Write の tool_input に読み替える。
//
//   *** Begin Patch
//   *** Add File: path            → Write（content = + の行の全文）
//   *** Update File: path         → Edit（new_string = + の行）
//   *** Move to: new/path         （任意。検査は移動先のパスで行う）
//   *** Delete File: path         （検査しない）
//   *** End Patch
import { isAbsolute, join } from './path.ts'
import { type Dict, isDict } from './pyutil.ts'

export type PatchOp = 'add' | 'update' | 'delete'

export type PatchFile = { op: PatchOp; path: string; movedTo?: string; added: string }

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'

/** command のほか、古い形の input / patch も見る。 */
export function patchText(toolInput: unknown): string {
  if (!isDict(toolInput)) return ''
  for (const key of ['command', 'input', 'patch']) {
    const v = toolInput[key]
    if (typeof v === 'string' && v.includes(BEGIN)) return v
  }
  return ''
}

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
  }
  flush()
  return files
}

export const absolutePath = (p: string, base: string): string => (isAbsolute(p) ? p : join(base, p))

/** 共通のキー（session_id / cwd / tool_use_id / agent_id ...）は写し、tool_name と tool_input だけ差し替える。 */
export function patchPayloads(payload: Dict, base: string): Dict[] {
  const out: Dict[] = []
  for (const f of parsePatch(patchText(payload.tool_input))) {
    if (f.op === 'delete') continue
    const filePath = absolutePath(f.movedTo ?? f.path, base)
    const toolInput: Dict = f.op === 'add' ? { file_path: filePath, content: f.added } : { file_path: filePath, old_string: '', new_string: f.added }
    out.push({ ...payload, tool_name: f.op === 'add' ? 'Write' : 'Edit', tool_input: toolInput })
  }
  return out
}
