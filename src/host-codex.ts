// Codex（plugins/codex の command hook）向けの Host。Codex の hook は Claude Code の classic コマンド hook と同じ名前の
// イベントを、ほぼ同じ stdin の JSON で送り、同じ規約の出力を読む。違うところだけをここで吸収し、中核（src/hooks.ts）は
// Claude Code と共有する。
//
// - ファイルの編集は Edit / Write ではなく apply_patch（tool_input.command がパッチ全文）。ファイルごとの Edit / Write の
//   payload に分けて（src/apply-patch.ts）、pre_edit / post_edit と gate の記録をファイル単位で走らせる。
// - 確認待ちの通知は Notification ではなく PermissionRequest（ツール呼び出しの承認待ち）で出す。何も返さないので、
//   承認の判断は通常の確認ダイアログに残る。
// - サブエージェントは Agent / SendMessage ではなく spawn_agent / send_input。agentLaunchGuard と、サブエージェントの
//   結果の受け渡し（PostToolUse(Agent)）のために名前と引数を読み替える。
// - PreToolUse の permissionDecision に ask が無い（返すと hook が失敗扱いになり、ツールはそのまま動く）。ask は deny に
//   して理由にその旨を添える。同じセッション・同じ対象の 2 回目は Claude Code と同じく warn に落ちるので、理由を読んで
//   やり直せば通る。
// - exit 0 の stderr（warn）は Codex では見えないので、PreToolUse / PostToolUse では additionalContext としてモデルに、
//   Stop / SubagentStop では systemMessage としてユーザーに渡す。
// - プラグイン設定は userConfig が無いので環境変数 FEEDBACK_GATE_<KEY> で受ける（optionsFromEnv）。
import type { PluginOptions } from 'claude-code'
import { patchPayloads } from './apply-patch.ts'
import type { CoreCall, Host } from './host.ts'
import { tr } from './i18n.ts'
import type { Io, ScriptResult } from './io.ts'
import type { Outcome } from './outcome.ts'
import { type Dict, isDict } from './pyutil.ts'

export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SubagentStop'] as const
export type CodexEvent = (typeof CODEX_EVENTS)[number]

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * プラグイン設定。Codex 用の環境変数 FEEDBACK_GATE_<KEY> を優先し、Claude Code の settings hook と同じ
 * CLAUDE_PLUGIN_OPTION_<key> も読む（boolean は "true" / "false" の文字列）。
 * - language: FEEDBACK_GATE_LANG は resolveLang（src/i18n.ts）が直接読むので、ここでは CLAUDE_PLUGIN_OPTION_language だけ。
 * - agentLaunchGuard: FEEDBACK_GATE_AGENT_LAUNCH_GUARD（既定 false）
 * - autoCount: FEEDBACK_GATE_AUTO_COUNT（既定 true）
 * - rulesFile: FEEDBACK_GATE_RULES_FILE
 */
export function optionsFromEnv(env: NodeJS.ProcessEnv): PluginOptions {
  const pick = (codexKey: string, claudeKey: string): string | undefined => env[`FEEDBACK_GATE_${codexKey}`] ?? env[`CLAUDE_PLUGIN_OPTION_${claudeKey}`]
  return {
    language: env.CLAUDE_PLUGIN_OPTION_language,
    agentLaunchGuard: pick('AGENT_LAUNCH_GUARD', 'agentLaunchGuard') === 'true',
    autoCount: pick('AUTO_COUNT', 'autoCount') !== 'false',
    rulesFile: pick('RULES_FILE', 'rulesFile'),
  }
}

/** Codex のツール名を Claude Code の名前に読み替える（それ以外はそのまま）。 */
export const claudeToolName = (tool: string): string => ({ spawn_agent: 'Agent', send_input: 'SendMessage' })[tool] ?? tool

/** spawn_agent / send_input の引数を Agent / SendMessage の引数（subagent_type / prompt / to / message）に揃える。 */
function agentPayload(payload: Dict, tool: string): Dict {
  const input = isDict(payload.tool_input) ? payload.tool_input : {}
  const toolInput: Dict = { ...input }
  if (tool === 'Agent') {
    if (toolInput.subagent_type === undefined && typeof input.agent_type === 'string') toolInput.subagent_type = input.agent_type
    if (toolInput.prompt === undefined && typeof input.message === 'string') toolInput.prompt = input.message
  } else if (tool === 'SendMessage') {
    if (toolInput.to === undefined && typeof input.agent_id === 'string') toolInput.to = input.agent_id
  }
  return { ...payload, tool_name: tool, tool_input: toolInput }
}

/** spawn_agent の結果（文字列の JSON や agent_id キー）を、subagent-report が読む tool_response.agentId の形にする。 */
function agentResponse(payload: Dict): Dict {
  let response: unknown = payload.tool_response
  if (typeof response === 'string') {
    try {
      response = JSON.parse(response)
    } catch {
      return payload
    }
  }
  if (!isDict(response)) return payload
  const agentId = str(response.agentId) || str(response.agent_id)
  return agentId === '' ? payload : { ...payload, tool_response: { ...response, agentId } }
}

/** Codex のイベントと payload を中核の呼び出しに直す。 */
export function normalize(event: string, payload: Dict, io: Io): CoreCall {
  const base = str(payload.cwd) || io.cwd
  const rawTool = str(payload.tool_name)
  const tool = claudeToolName(rawTool)
  const ev = event as CodexEvent
  switch (ev) {
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'Stop':
    case 'SubagentStop':
      return { event: ev, payloads: [payload] }
    case 'PreToolUse': {
      if (rawTool === 'apply_patch') return { event: ev, payloads: patchPayloads(payload, base) }
      if (tool === 'Agent' || tool === 'SendMessage') return { event: ev, payloads: [agentPayload(payload, tool)] }
      return { event: ev, payloads: [payload] }
    }
    case 'PostToolUse': {
      if (rawTool === 'apply_patch') return { event: ev, payloads: patchPayloads(payload, base) }
      if (tool === 'Agent') return { event: ev, payloads: [agentResponse({ ...payload, tool_name: tool })] }
      return { event: ev, payloads: [payload] }
    }
    case 'PermissionRequest': {
      // 承認待ちの通知だけ。判定は返さない（render が PermissionRequest では何も出さない）。
      const input = isDict(payload.tool_input) ? payload.tool_input : {}
      const message = str(input.description) || str(input.command)
      return { event: 'Notification', payloads: [message === '' ? payload : { ...payload, message }] }
    }
    default:
      return undefined
  }
}

/**
 * Outcome を Codex の command hook の出力（exit 0 + stdout の JSON）にする。src/outcome.ts の outcomeToClassic に対応するが、
 * ask を deny に落とし、warn（stderr）を additionalContext / systemMessage にも載せる。
 */
export function render(event: string, outcome: Outcome, stderr: string, io: Io): ScriptResult {
  const json: Dict = {}
  const specific: Dict = {}
  const warnings = stderr.trim()
  const context = (outcome.additionalContext ?? []).filter((c) => c.trim() !== '').join('\n\n')
  if (event === 'PreToolUse') {
    if (outcome.deny !== undefined) {
      specific.permissionDecision = 'deny'
      specific.permissionDecisionReason = outcome.deny
    } else if (outcome.ask !== undefined) {
      specific.permissionDecision = 'deny'
      specific.permissionDecisionReason = `${outcome.ask}\n${tr(io.lang)('codex.askAsDeny')}`
    } else if (warnings !== '') {
      specific.additionalContext = warnings
    }
  } else if (event === 'PostToolUse') {
    if (outcome.block !== undefined) {
      json.decision = 'block'
      json.reason = outcome.block
    }
    const parts = [context, outcome.block === undefined ? warnings : ''].filter((s) => s !== '')
    if (parts.length > 0) specific.additionalContext = parts.join('\n\n')
  } else if (event === 'Stop' || event === 'SubagentStop') {
    if (outcome.block !== undefined) {
      json.decision = 'block'
      json.reason = outcome.block
    } else if (warnings !== '') {
      json.systemMessage = warnings
    }
    if (outcome.preventContinuation) {
      json.continue = false
      if (outcome.stopReason !== undefined) json.stopReason = outcome.stopReason
    }
  } else if (event === 'UserPromptSubmit' || event === 'SessionStart') {
    if (outcome.block !== undefined) {
      json.decision = 'block'
      json.reason = outcome.block
    }
    if (context !== '') specific.additionalContext = context
  }
  // PermissionRequest は何も返さない。
  if (Object.keys(specific).length > 0) json.hookSpecificOutput = { hookEventName: event, ...specific }
  return { exitCode: 0, stdout: Object.keys(json).length > 0 ? `${JSON.stringify(json)}\n` : '', stderr }
}

export const codexHost: Host = {
  appName: 'Codex',
  events: CODEX_EVENTS,
  options: optionsFromEnv,
  normalize,
  render,
}
