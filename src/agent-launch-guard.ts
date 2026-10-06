// PreToolUse(Agent|SendMessage): サブエージェントへ作業指示を送る前に、送信内容そのものを見せて ask を返す。
//
// サブエージェントはメインエージェントの会話コンテキストを持たないため、指示が雑だと別解釈で実装が進み
// 手戻りになる。確認ダイアログに本文を載せないと確認の意味がないので、permissionDecisionReason に
// prompt / message をそのまま入れる。
//
// - Agent: ASK_AGENT_TYPES に列挙した subagent_type の起動を ask
// - SendMessage: ALLOW_RECIPIENTS 以外の宛先への送信を ask
//
// どちらにも該当しなければ何も出力せず、通常のパーミッション判定に委ねる。
import { ok, type ScriptResult } from './io.ts'
import { type Dict, isDict, jqStr } from './pyutil.ts'

export const ASK_AGENT_TYPES = ['code-implementer']

/** 確認なしで送ってよい宛先（エージェント名）。 */
export const ALLOW_RECIPIENTS = ['git-operator']

const CHECKLIST = '--- チェック: やること / 背景 / 既存コードの現状 / やらないこと / 完了条件'

const ask = (reason: string): ScriptResult =>
  ok(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: reason,
      },
    })}\n`,
  )

export function agentLaunchGuard(payload: Dict): ScriptResult {
  const tool = jqStr(payload.tool_name)
  const input = isDict(payload.tool_input) ? payload.tool_input : {}
  if (tool === 'Agent') {
    const agentType = jqStr(input.subagent_type)
    if (agentType === '') return ok()
    if (ASK_AGENT_TYPES.includes(agentType)) {
      return ask(`${agentType} に送るプロンプト:\n\n${jqStr(input.prompt)}\n\n${CHECKLIST}`)
    }
  } else if (tool === 'SendMessage') {
    const recipient = jqStr(input.to)
    if (!ALLOW_RECIPIENTS.includes(recipient)) {
      return ask(`${recipient || '宛先不明'} に送るメッセージ:\n\n${jqStr(input.message)}\n\n${CHECKLIST}`)
    }
  }
  return ok()
}
