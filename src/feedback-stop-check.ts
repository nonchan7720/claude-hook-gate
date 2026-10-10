// Stop hook: feedback ルールの stop_check enforce を評価する。
//
// 変更ファイルの一覧は record-changes が書く
// ${projectDir}/.claude/.gate-status/changed_files.${sessionId}[--${agentId}].txt を優先して読む
// （gate.yaml を持つプロジェクトでしか作られないため、無ければ getChangedFiles() が git diff / git status で
// フォールバックする）。payload に agent_id があれば SubagentStop（サブエージェントの Stop）とみなし、
// そのエージェント別メモ・attempts ファイル（feedback_gate_attempts.${sessionId}--${agentId}.txt）だけを見る。
//
// severity が warn 以外（block/ask/deny）の違反があれば stderr に出して exit 2（修正を継続させる）。
// warn のみなら stderr に出して exit 0。
//
// 無限ループ防止のため、MAX_ATTEMPTS 回連続でブロックしたら諦めて exit 0 にする。
import { evalStopCheck, getChangedFiles, listRules, logViolation } from './feedback-rules.ts'
import { tr } from './i18n.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { STOP_CHECK_FIX_ABOVE, STOP_CHECK_GAVE_UP } from './messages.ts'
import { join } from './path.ts'
import { type Dict, truthy } from './pyutil.ts'

export const MAX_ATTEMPTS = 3

export const attemptsPath = (projectDir: string, sessionId: string, agentId?: string | null): string =>
  join(projectDir, '.claude', '.gate-status', `feedback_gate_attempts.${agentId ? `${sessionId}--${agentId}` : sessionId}.txt`)

async function bumpAttempts(io: Io, path: string): Promise<number> {
  let attempts = 0
  const text = await io.readFile(path)
  if (text !== undefined && /^\s*[+-]?\d+\s*$/.test(text)) attempts = Number.parseInt(text.trim(), 10)
  attempts += 1
  try {
    await io.writeFile(path, String(attempts))
  } catch {
    // 書けなくても続ける
  }
  return attempts
}

async function main(io: Io, payload: Dict): Promise<ScriptResult> {
  const projectDir = io.projectDir || io.cwd
  const sessionId = truthy(payload.session_id) ? String(payload.session_id) : 'unknown'
  const agentId = truthy(payload.agent_id) ? String(payload.agent_id) : null
  const ap = attemptsPath(projectDir, sessionId, agentId)

  const files = await getChangedFiles(io, projectDir, sessionId, agentId)
  if (files.length === 0) {
    await io.removeFiles([ap])
    return ok()
  }

  const rules = await listRules(io)
  const violations = await evalStopCheck(io, rules, projectDir, files)
  if (violations.length === 0) {
    await io.removeFiles([ap])
    return ok()
  }

  for (const v of violations) await logViolation(io, v.rule, v.count, v.severity, v.event, v.detail)

  const warnings = violations.filter((v) => v.severity === 'warn')
  const blocking = violations.filter((v) => v.severity !== 'warn')

  let stderr = warnings.map((v) => `[feedback-stop-check] warn: ${v.rule} (count: ${v.count}): ${v.message}\n`).join('')

  if (blocking.length === 0) {
    await io.removeFiles([ap])
    return ok('', stderr)
  }

  const attempts = await bumpAttempts(io, ap)
  if (attempts >= MAX_ATTEMPTS) {
    stderr += `${tr(io.lang)(STOP_CHECK_GAVE_UP, MAX_ATTEMPTS)}\n`
    await io.removeFiles([ap])
    return ok('', stderr)
  }

  const lines = blocking.map((v) => `[feedback-stop-check] ${v.rule} (count: ${v.count}): ${v.message} (${v.detail})`)
  lines.push(tr(io.lang)(STOP_CHECK_FIX_ABOVE, attempts, MAX_ATTEMPTS))
  stderr += lines.map((l) => `${l}\n`).join('')
  const stdout = `${JSON.stringify({ decision: 'block', reason: lines.join('\n') })}\n`
  return { exitCode: 2, stdout, stderr }
}

export async function feedbackStopCheck(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await main(io, payload)
  } catch (e) {
    // hook のバグで作業を止めない
    return ok('', `[feedback-stop-check] internal error (ignored): ${e instanceof Error ? e.message : String(e)}\n`)
  }
}
