// PostToolUse hook: feedback ルールの enforce (post_edit) を評価する。
//
// Edit / Write / MultiEdit の直後に、編集後のファイル全体（ディスク上の全文）を post_edit の enforce と照合する。
// pre_edit は tool_input の差分だけを見るため「console.log を残さない」のような“編集後の状態”を検査できない。
// それを補う。
//
// severity が warn 以外（block/deny/ask）の違反があれば stdout に {"decision":"block","reason":...} を出す
// （PostToolUse に ask は無いので block 扱い。exit 0 のまま outcome.ts が block に変換する）。
// warn のみなら stderr に書いて exit 0。違反が無ければ何も出さず exit 0。
//
// hook 自身のバグで作業を止めないよう、例外は必ず握りつぶして exit 0 にする（stderr に1行だけ出し、~/.claude/feedback/.errors.jsonl に残す）。
import { autoBumpCounts, countBumpNotes, errorText, evalPostEdit, listRules, logError, logViolation } from './feedback-rules.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { type Dict, isDict, truthy } from './pyutil.ts'

async function main(io: Io, payload: Dict): Promise<ScriptResult> {
  const toolName = truthy(payload.tool_name) ? String(payload.tool_name) : ''
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') return ok()
  const toolInput = isDict(payload.tool_input) ? payload.tool_input : {}
  const filePath = truthy(toolInput.file_path) ? String(toolInput.file_path) : ''
  if (!filePath) return ok()

  const rules = await listRules(io)
  const violations = await evalPostEdit(io, rules, filePath)
  if (violations.length === 0) return ok()

  for (const v of violations) await logViolation(io, v.rule, v.count, v.severity, v.event, v.detail)
  const notes = countBumpNotes(io.lang, await autoBumpCounts(io, rules, violations, payload.session_id))

  const warnings = violations.filter((v) => v.severity === 'warn')
  const blocking = violations.filter((v) => v.severity !== 'warn')

  let stderr = warnings.map((v) => `[feedback-post-edit] warn: ${v.rule} (count: ${v.count}): ${v.message}\n`).join('')
  if (blocking.length === 0) return ok('', stderr + notes.map((l) => `${l}\n`).join(''))

  const lines = [...blocking.map((v) => `[feedback-post-edit] ${v.rule} (count: ${v.count}): ${v.message} (${v.detail})`), ...notes]
  stderr += lines.map((l) => `${l}\n`).join('')
  const stdout = `${JSON.stringify({ decision: 'block', reason: lines.join('\n') })}\n`
  return ok(stdout, stderr)
}

export async function feedbackPostEdit(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await main(io, payload)
  } catch (e) {
    // hook のバグで作業を止めない（黙って全ルールが無効にならないよう .errors.jsonl に残す）
    await logError(io, 'feedback-post-edit', errorText(e))
    return ok('', `[feedback-post-edit] internal error (ignored): ${errorText(e)}\n`)
  }
}
