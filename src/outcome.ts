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

// Outcome を classic コマンド hook の出力（終了コード 0 + stdout の JSON）へ戻す。settings hook の CLI（src/cli.ts）が使う。
// toOutcome の逆変換で、exit 2 の block / deny は JSON の判定（decision: block / permissionDecision: deny）で同じ効果になる
// （exit 2 は stderr を理由にするだけで、stdout の JSON は無視される規約なので、情報は reason に移す）。
// stderr は warn など正常終了時の出力で、そのまま stderr へ出す。
export const outcomeToClassic = (event: string, outcome: Outcome, stderr = ''): ScriptResult => {
  const json: Dict = {}
  const specific: Dict = {}
  const context = (outcome.additionalContext ?? []).filter((c) => c.trim() !== '').join('\n\n')
  if (event === 'PreToolUse') {
    // 返す判定は deny / ask だけ（allow は返さず、ユーザーの判断に委ねる）。deny が先。
    const decision = outcome.deny !== undefined ? 'deny' : outcome.ask !== undefined ? 'ask' : undefined
    if (decision !== undefined) {
      specific.permissionDecision = decision
      specific.permissionDecisionReason = outcome.deny ?? outcome.ask ?? ''
    }
  } else if (outcome.block !== undefined) {
    json.decision = 'block'
    json.reason = outcome.block
  }
  if (context !== '' && event !== 'Stop' && event !== 'SubagentStop' && event !== 'Notification') specific.additionalContext = context
  if (Object.keys(specific).length > 0) json.hookSpecificOutput = { hookEventName: event, ...specific }
  if (outcome.preventContinuation) {
    json.continue = false
    if (outcome.stopReason !== undefined) json.stopReason = outcome.stopReason
  }
  return { exitCode: 0, stdout: Object.keys(json).length > 0 ? `${JSON.stringify(json)}\n` : '', stderr }
}
