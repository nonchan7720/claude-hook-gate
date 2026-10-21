// PreToolUse(Agent|SendMessage): サブエージェントへ作業指示を送る前に、送信内容そのものを見せて ask を返す。
//
// サブエージェントはメインエージェントの会話コンテキストを持たないため、指示が雑だと別解釈で実装が進み
// 手戻りになる。確認ダイアログに本文を載せないと確認の意味がないので、permissionDecisionReason に
// prompt / message をそのまま入れる。
//
// - Agent: askAgentTypes（既定 ASK_AGENT_TYPES）に列挙した subagent_type の起動を ask
// - SendMessage: allowRecipients（既定 ALLOW_RECIPIENTS）以外の宛先への送信を ask
//
// 一覧は環境変数 FEEDBACK_GATE_ASK_AGENT_TYPES / FEEDBACK_GATE_ALLOW_RECIPIENTS で差し替えられる（Go 版と同じ）。
//
// どちらにも該当しなければ何も出力せず、通常のパーミッション判定に委ねる。
import { type Lang, tr } from './i18n.ts'
import { type EnvVars, ok, type ScriptResult } from './io.ts'
import { type Dict, isDict, jqStr } from './pyutil.ts'

export const ASK_AGENT_TYPES = ['code-implementer']

/** 確認なしで送ってよい宛先（エージェント名）。 */
export const ALLOW_RECIPIENTS = ['git-operator']

export type AgentLaunchLists = { askAgentTypes: readonly string[]; allowRecipients: readonly string[] }

/** `,` と `;` で区切った一覧を読む。名前の前後の空白は無視し、空の要素は捨てる（Go 版の ParseAgentList と同じ）。 */
export function parseAgentList(s: string | undefined): string[] {
  return (s ?? '')
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter((v) => v !== '')
}

/** 環境変数から確認対象と許可する宛先を決める。未設定や、区切りと空白だけの値は既定のまま（Go 版の AgentLaunchLists と同じ）。 */
export function agentLaunchLists(env: Readonly<EnvVars>): { askAgentTypes: string[]; allowRecipients: string[] } {
  const ask = parseAgentList(env.FEEDBACK_GATE_ASK_AGENT_TYPES)
  const allow = parseAgentList(env.FEEDBACK_GATE_ALLOW_RECIPIENTS)
  return { askAgentTypes: ask.length > 0 ? ask : [...ASK_AGENT_TYPES], allowRecipients: allow.length > 0 ? allow : [...ALLOW_RECIPIENTS] }
}

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

export function agentLaunchGuard(
  payload: Dict,
  lang: Lang,
  lists: AgentLaunchLists = { askAgentTypes: ASK_AGENT_TYPES, allowRecipients: ALLOW_RECIPIENTS },
): ScriptResult {
  const t = tr(lang)
  const tool = jqStr(payload.tool_name)
  const input = isDict(payload.tool_input) ? payload.tool_input : {}
  if (tool === 'Agent') {
    const agentType = jqStr(input.subagent_type)
    if (agentType === '') return ok()
    if (lists.askAgentTypes.includes(agentType)) {
      return ask(`${t('launch.promptTo', { agentType })}\n\n${jqStr(input.prompt)}\n\n${t('launch.checklist')}`)
    }
  } else if (tool === 'SendMessage') {
    const recipient = jqStr(input.to)
    if (!lists.allowRecipients.includes(recipient)) {
      return ask(`${t('launch.messageTo', { recipient: recipient || t('launch.unknownRecipient') })}\n\n${jqStr(input.message)}\n\n${t('launch.checklist')}`)
    }
  }
  return ok()
}
