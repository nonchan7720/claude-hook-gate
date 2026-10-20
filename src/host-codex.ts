// Codex（plugins/codex）向けの Host。Codex の hook は Claude Code の classic コマンド hook と同じイベント名・JSON・出力規約で、
// 違い（apply_patch、PermissionRequest、spawn_agent、ask が無いこと、stderr が見えないこと）だけをここで吸収する。
import type { PluginOptions } from 'claude-code'
import { patchPayloads } from './apply-patch.ts'
import type { CoreCall, Host } from './host.ts'
import { tr } from './i18n.ts'
import type { Io, ScriptResult } from './io.ts'
import type { Outcome } from './outcome.ts'
import { type Dict, isDict } from './pyutil.ts'

export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SubagentStop'] as const
export type CodexEvent = (typeof CODEX_EVENTS)[number]

/** Codex は .agents を使う。.claude は Claude Code と共用するプロジェクトのため。 */
export const CODEX_CONFIG_DIRS: readonly string[] = ['.agents', '.claude']

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Codex に userConfig は無いので FEEDBACK_GATE_<KEY> で受ける。CLAUDE_PLUGIN_OPTION_<key> も読む。 */
export function optionsFromEnv(env: NodeJS.ProcessEnv): PluginOptions {
  const pick = (codexKey: string, claudeKey: string): string | undefined => env[`FEEDBACK_GATE_${codexKey}`] ?? env[`CLAUDE_PLUGIN_OPTION_${claudeKey}`]
  return {
    // FEEDBACK_GATE_LANG は resolveLang（src/i18n.ts）が直接読む。
    language: env.CLAUDE_PLUGIN_OPTION_language,
    agentLaunchGuard: pick('AGENT_LAUNCH_GUARD', 'agentLaunchGuard') === 'true',
    autoCount: pick('AUTO_COUNT', 'autoCount') !== 'false',
    rulesFile: pick('RULES_FILE', 'rulesFile'),
  }
}

export const claudeToolName = (tool: string): string => ({ spawn_agent: 'Agent', send_input: 'SendMessage' })[tool] ?? tool

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
      // Codex に Notification は無い。承認待ちを「確認待ち」の通知にし、判定は返さない（render が PermissionRequest では何も出さない）。
      const input = isDict(payload.tool_input) ? payload.tool_input : {}
      const message = str(input.description) || str(input.command)
      return { event: 'Notification', payloads: [message === '' ? payload : { ...payload, message }] }
    }
    default:
      return undefined
  }
}

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
      // Codex の PreToolUse に ask は無い（返すと hook が失敗扱いになりツールが動く）。同じ対象の 2 回目は中核が warn に落とす。
      specific.permissionDecision = 'deny'
      specific.permissionDecisionReason = `${outcome.ask}\n${tr(io.lang)('codex.askAsDeny')}`
    } else if (warnings !== '') {
      // exit 0 の stderr は Codex では見えないので、warn はモデルの context に載せる（PostToolUse も同じ、Stop は systemMessage）。
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
  if (Object.keys(specific).length > 0) json.hookSpecificOutput = { hookEventName: event, ...specific }
  return { exitCode: 0, stdout: Object.keys(json).length > 0 ? `${JSON.stringify(json)}\n` : '', stderr }
}

export const codexHost: Host = {
  appName: 'Codex',
  events: CODEX_EVENTS,
  configDirNames: CODEX_CONFIG_DIRS,
  options: optionsFromEnv,
  normalize,
  render,
}
