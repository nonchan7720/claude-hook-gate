// PreToolUse hook: feedback ルールの enforce (pre_bash / pre_edit) を評価し、
// count に応じた強制力（deny / ask / warn）を適用する。
//
// - Bash: command を pre_bash の enforce と照合する
// - Edit / Write / MultiEdit: file_path と変更後の内容を pre_edit の enforce と照合する
//
// severity が deny/ask（block は防御的に deny 扱い）の違反があれば stdout に hookSpecificOutput を出して
// 該当ツール呼び出しを止める。warn のみなら stderr に書いて exit 0（ツールは実行させる）。違反が無ければ
// 何も出さず exit 0。
//
// hook 自身のバグで作業を止めないよう、例外は必ず握りつぶして exit 0 にする（stderr に1行だけ出す）。
import { evalPreBash, evalPreEdit, extractPreEditContent, feedbackDir, listRules, logViolation, type Violation } from './feedback-rules.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { join } from './path.ts'
import { type Dict, isDict, truthy } from './pyutil.ts'

const SEVERITY_ORDER: Record<string, number> = { warn: 0, ask: 1, block: 2, deny: 3 }

/** PreToolUse の permissionDecision は allow/deny/ask のみ。block は防御的に deny 扱い。 */
export const decisionFor = (severity: string): 'deny' | 'ask' => (severity === 'deny' || severity === 'block' ? 'deny' : 'ask')

export const buildReason = (violations: Violation[]): string => violations.map((v) => `${v.rule} (count: ${v.count}): ${v.message}`).join('\n')

export const askStatePath = (io: Io, sessionId: string): string => join(feedbackDir(io), '.ask_state', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.json`)

export async function loadAskedKeys(io: Io, sessionId: string): Promise<Set<string>> {
  try {
    const text = await io.readFile(askStatePath(io, sessionId))
    if (text === undefined) return new Set()
    const data: unknown = JSON.parse(text)
    if (isDict(data) && Array.isArray(data.asked)) return new Set(data.asked.map(String))
  } catch {
    // 壊れた状態ファイルは空扱い
  }
  return new Set()
}

export async function saveAskedKeys(io: Io, sessionId: string, askedKeys: Set<string>): Promise<void> {
  try {
    await io.writeFile(askStatePath(io, sessionId), JSON.stringify({ asked: [...askedKeys].sort() }))
  } catch {
    // 状態の保存失敗で hook を止めない
  }
}

export function askKey(v: Violation, toolInput: Dict): string {
  const target = v.event === 'pre_edit' ? (truthy(toolInput.file_path) ? String(toolInput.file_path) : '') : ''
  return `${v.rule}|${v.event}|${target}`
}

/** 同一セッション・同一対象で 2 回目以降の ask は warn に落とす。deny/block は対象外。 */
export async function downgradeRepeatedAsks(io: Io, violations: Violation[], sessionId: unknown, toolInput: Dict): Promise<void> {
  if (!truthy(sessionId)) return
  const sid = String(sessionId)
  const asked = await loadAskedKeys(io, sid)
  const newlyAsked = new Set<string>()
  for (const v of violations) {
    if (v.severity !== 'ask') continue
    const key = askKey(v, toolInput)
    if (asked.has(key)) v.severity = 'warn'
    else newlyAsked.add(key)
  }
  if (newlyAsked.size > 0) await saveAskedKeys(io, sid, new Set([...asked, ...newlyAsked]))
}

async function main(io: Io, payload: Dict): Promise<ScriptResult> {
  const toolName = truthy(payload.tool_name) ? String(payload.tool_name) : ''
  const toolInput = isDict(payload.tool_input) ? payload.tool_input : {}

  const rules = await listRules(io)
  let violations: Violation[]
  if (toolName === 'Bash') {
    violations = await evalPreBash(io, rules, truthy(toolInput.command) ? String(toolInput.command) : '')
  } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    const filePath = truthy(toolInput.file_path) ? String(toolInput.file_path) : ''
    if (!filePath) return ok()
    violations = await evalPreEdit(io, rules, filePath, extractPreEditContent(toolName, toolInput))
  } else {
    return ok()
  }

  if (violations.length === 0) return ok()

  await downgradeRepeatedAsks(io, violations, payload.session_id, toolInput)

  for (const v of violations) await logViolation(io, v.rule, v.count, v.severity, v.event, v.detail)

  const blocking = violations.filter((v) => v.severity !== 'warn')
  const warnings = violations.filter((v) => v.severity === 'warn')

  let stdout = ''
  if (blocking.length > 0) {
    const top = blocking.reduce((a, b) => ((SEVERITY_ORDER[b.severity] ?? 0) > (SEVERITY_ORDER[a.severity] ?? 0) ? b : a))
    stdout = `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decisionFor(top.severity),
        permissionDecisionReason: buildReason(blocking),
      },
    })}\n`
  }
  const stderr = warnings.map((v) => `[feedback-guard] warn: ${v.rule} (count: ${v.count}): ${v.message}\n`).join('')
  return ok(stdout, stderr)
}

export async function feedbackGuard(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await main(io, payload)
  } catch (e) {
    // hook のバグで作業を止めない
    return ok('', `[feedback-guard] internal error (ignored): ${e instanceof Error ? e.message : String(e)}\n`)
  }
}
