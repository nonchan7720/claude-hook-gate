// PostToolUse hook: files を持つ feedback ルール（ファイル種別にスコープされたルール）を、対象のファイルに触れた直後に注入する。
//
// files 付きのルールは毎プロンプトには注入されない（feedback-inject.ts）。代わりに、
// - Read: 読んだファイル（ほぼ必ず編集の前にある。ここで届けば、編集内容を考える前にルールが手元にある）
// - Edit / Write / MultiEdit: 編集したファイル（Read を挟まずに書いたときの保険。次の編集から効く）
// - Bash: コマンドの文面から書き先が分かる heredoc の書き込み先（bash-heredoc.ts。Write と同じ扱い）
// のパスに files がマッチする count >= 3 のルールを、additionalContext として返す。
//
// 同じターンに同じルールを何度も出さないよう、注入済みのルール名を ~/.claude/feedback/.inject_state/<session>[--<agent>].json に
// 控える。UserPromptSubmit（feedback-inject.ts）と SessionStart の startup / clear / compact（reset-gate.ts）で消える。
//
// hook 自身のバグで作業を止めないよう、例外は握りつぶして exit 0 にする（.errors.jsonl に残す）。
import { heredocWrites } from './bash-heredoc.ts'
import { formatRules } from './feedback-inject.ts'
import { errorText, injectStateId, isFileScoped, listRules, loadInjected, logError, type Rule, rulesForFile, saveInjected } from './feedback-rules.ts'
import { tr } from './i18n.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { relpath } from './path.ts'
import { type Dict, isDict, jqStr, truthy } from './pyutil.ts'

/** 表示用のパス: projectDir 配下ならその相対パス。 */
const fileLabel = (projectDir: string, file: string): string => {
  const rel = relpath(file, projectDir)
  return rel.startsWith('../') || rel === '..' ? file : rel
}

/** ツールの入力から、注入の対象にするファイルのパスを取り出す。対象外のツールは空。 */
export function targetFiles(payload: Dict, io: Io): string[] {
  const tool = jqStr(payload.tool_name)
  const toolInput = isDict(payload.tool_input) ? payload.tool_input : {}
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
    return truthy(toolInput.file_path) ? [String(toolInput.file_path)] : []
  }
  if (tool === 'Bash') {
    const command = truthy(toolInput.command) ? String(toolInput.command) : ''
    if (!command) return []
    return heredocWrites(command, jqStr(payload.cwd) || io.cwd, io.env.HOME).map((w) => w.file)
  }
  return []
}

/** ファイル群に対する注入テキスト（ヘッダ + ルール）。 */
export async function buildFileOutput(io: Io, rules: Rule[], files: string[], mode: 'read' | 'edit', projectDir: string): Promise<string> {
  const label = files.map((f) => fileLabel(projectDir, f)).join(', ')
  return tr(io.lang)(mode === 'read' ? 'inject.fileHeaderRead' : 'inject.fileHeaderEdit', { files: label }) + (await formatRules(io, rules))
}

async function main(io: Io, payload: Dict): Promise<ScriptResult> {
  const files = targetFiles(payload, io)
  if (files.length === 0) return ok()
  const rules = (await listRules(io)).filter((r) => r.count >= 3 && isFileScoped(r))
  if (rules.length === 0) return ok()
  const projectDir = io.projectDir || io.cwd

  // 対象ファイルごとのマッチの和集合（ルールの順序は保つ）。
  const matched: Rule[] = []
  for (const file of files) {
    for (const r of rulesForFile(io, rules, file, projectDir)) if (!matched.includes(r)) matched.push(r)
  }
  if (matched.length === 0) return ok()

  const stateId = injectStateId(payload.session_id, payload.agent_id)
  const injected = stateId !== '' ? await loadInjected(io, stateId) : new Set<string>()
  const fresh = matched.filter((r) => !injected.has(r.name))
  if (fresh.length === 0) return ok()
  if (stateId !== '') await saveInjected(io, stateId, new Set([...injected, ...fresh.map((r) => r.name)]))

  const mode = jqStr(payload.tool_name) === 'Read' ? 'read' : 'edit'
  const text = await buildFileOutput(io, fresh, files, mode, projectDir)
  return ok(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })}\n`)
}

export async function feedbackFileInject(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await main(io, payload)
  } catch (e) {
    // hook のバグで作業を止めない
    await logError(io, 'feedback-file-inject', errorText(e))
    return ok('', `[feedback-file-inject] internal error (ignored): ${errorText(e)}\n`)
  }
}
