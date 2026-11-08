// classic コマンド hook の結果（終了コード + stdout の JSON）を、function hook の戻り値へ変換する（src/go-bridge.ts が
// Go 版の出力をこれで戻す）。
import type { ScriptResult } from './io.ts'
import { type Dict, isDict } from './pyutil.ts'

export type Outcome = {
  block?: string
  deny?: string
  ask?: string
  allow?: true
  preventContinuation?: true
  stopReason?: string
  additionalContext?: string[]
  /** ユーザーに見せるメッセージ（ScriptResult.systemMessage か、stdout の JSON の systemMessage から）。 */
  systemMessage?: string
}

const TEXT_CONTEXT_EVENTS = new Set(['UserPromptSubmit', 'SessionStart'])

const parseJson = (text: string): Dict | undefined => {
  const t = text.trim()
  if (!t.startsWith('{')) return undefined
  try {
    const v: unknown = JSON.parse(t)
    return isDict(v) ? v : undefined
  } catch {
    return undefined
  }
}

const fromJson = (event: string, json: Dict): Outcome => {
  const out: Outcome = {}
  if (json.decision === 'block') out.block = String(json.reason ?? '')
  if (json.continue === false) {
    out.preventContinuation = true
    if (typeof json.stopReason === 'string') out.stopReason = json.stopReason
  }
  if (typeof json.systemMessage === 'string' && json.systemMessage !== '') out.systemMessage = json.systemMessage
  const specific = json.hookSpecificOutput
  if (isDict(specific)) {
    if (typeof specific.additionalContext === 'string' && specific.additionalContext !== '') {
      out.additionalContext = [specific.additionalContext]
    }
    if (event === 'PreToolUse') {
      const reason = String(specific.permissionDecisionReason ?? '')
      if (specific.permissionDecision === 'allow') out.allow = true
      else if (specific.permissionDecision === 'ask') out.ask = reason
      else if (specific.permissionDecision === 'deny') out.deny = reason
    }
  }
  return out
}

// classic コマンド hook の規約: exit 0 は stdout を解釈、exit 2 はブロック、他の非 0 は無視。
export const toOutcome = (event: string, ran: ScriptResult): Outcome => {
  if (ran.exitCode === 2) {
    const reason = ran.stderr.trim() || 'hook exited with code 2'
    return event === 'PreToolUse' ? { deny: reason } : { block: reason }
  }
  if (ran.exitCode !== 0) return {}
  const base = toOutcomeStdout(event, ran.stdout)
  return ran.systemMessage ? { ...base, systemMessage: ran.systemMessage } : base
}

const toOutcomeStdout = (event: string, stdout: string): Outcome => {
  const json = parseJson(stdout)
  if (json) return fromJson(event, json)
  const text = stdout.trim()
  return text !== '' && TEXT_CONTEXT_EVENTS.has(event) ? { additionalContext: [text] } : {}
}

// 先に出たものを優先し、additionalContext は連結する。
export const merge = (first: Outcome, second: Outcome): Outcome => {
  const out: Outcome = { ...second, ...first }
  const ctx = [...(first.additionalContext ?? []), ...(second.additionalContext ?? [])]
  if (ctx.length > 0) out.additionalContext = ctx
  else delete out.additionalContext
  const sys = [first.systemMessage, second.systemMessage].filter((m): m is string => m !== undefined && m !== '')
  if (sys.length > 0) out.systemMessage = sys.join('\n')
  else delete out.systemMessage
  return out
}
