// classic コマンド hook の結果（終了コード + stdout の JSON）を、function hook の戻り値へ変換する。
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
  const json = parseJson(ran.stdout)
  if (json) return fromJson(event, json)
  const text = ran.stdout.trim()
  return text !== '' && TEXT_CONTEXT_EVENTS.has(event) ? { additionalContext: [text] } : {}
}

// 先に出たものを優先し、additionalContext は連結する。
export const merge = (first: Outcome, second: Outcome): Outcome => {
  const out: Outcome = { ...second, ...first }
  const ctx = [...(first.additionalContext ?? []), ...(second.additionalContext ?? [])]
  if (ctx.length > 0) out.additionalContext = ctx
  else delete out.additionalContext
  return out
}

export const decided = (o: Outcome) => o.block !== undefined || o.deny !== undefined || o.ask !== undefined || o.allow === true
