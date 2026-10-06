import type { Register } from 'claude-code'

// settings.json の command hook を、プラグイン同梱の scripts/ 配下のスクリプトをそのまま呼ぶ形で載せ替えた mod。
// スクリプトの終了コード・stdout の JSON を、classic コマンド hook の規約どおりに戻り値へ変換する。

type Ran = { exitCode: number; stdout: string; stderr: string }

type Outcome = {
  block?: string
  deny?: string
  ask?: string
  allow?: true
  preventContinuation?: true
  stopReason?: string
  additionalContext?: string[]
}

type Script = { interp: 'bash' | 'python3'; file: string; args?: string[]; long?: boolean }

const LONG_TIMEOUT_MS = 600000
const TEXT_CONTEXT_EVENTS = new Set(['UserPromptSubmit', 'SessionStart'])

const parseJson = (text: string): Record<string, any> | undefined => {
  const t = text.trim()
  if (!t.startsWith('{')) return undefined
  try {
    const v = JSON.parse(t)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

const fromJson = (event: string, json: Record<string, any>): Outcome => {
  const out: Outcome = {}
  if (json.decision === 'block') out.block = String(json.reason ?? '')
  if (json.continue === false) {
    out.preventContinuation = true
    if (typeof json.stopReason === 'string') out.stopReason = json.stopReason
  }
  const specific = json.hookSpecificOutput
  if (specific && typeof specific === 'object') {
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
const toOutcome = (event: string, ran: Ran): Outcome => {
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
const merge = (first: Outcome, second: Outcome): Outcome => {
  const out: Outcome = { ...second, ...first }
  const ctx = [...(first.additionalContext ?? []), ...(second.additionalContext ?? [])]
  if (ctx.length > 0) out.additionalContext = ctx
  else delete out.additionalContext
  return out
}

const decided = (o: Outcome) => o.block !== undefined || o.deny !== undefined || o.ask !== undefined || o.allow === true

async function home($: any) {
  return (await $.env.get('HOME')) as string | undefined
}

const DEFAULT_RULES_FILE = '~/.claude/feedback-gate/feedback_rules.md'

// rulesFile（先頭の ~ は HOME に展開）があればその内容、無ければプラグイン同梱の rules/feedback_rules.md の内容。
async function loadRules($: any, rulesFile: unknown): Promise<string> {
  const h = await home($)
  const configured = typeof rulesFile === 'string' && rulesFile !== '' ? rulesFile : DEFAULT_RULES_FILE
  const custom = configured.startsWith('~') ? (h ? `${h}${configured.slice(1)}` : undefined) : configured
  const bundled = `${$.plugin.root}/rules/feedback_rules.md`
  for (const path of [custom, bundled]) {
    if (path && (await $.fs.exists(path))) return String(await $.fs.read(path)).trim()
  }
  return ''
}

async function runScripts($: any, event: string, stdin: unknown, scripts: Script[]): Promise<Outcome> {
  const env = { CLAUDE_PROJECT_DIR: await $.session.root() }
  const input = JSON.stringify(stdin)
  let acc: Outcome = {}
  for (const s of scripts) {
    const path = `${$.plugin.root}/scripts/${s.file}`
    if (!(await $.fs.exists(path))) continue
    const ran: Ran | undefined = await $.process
      .run([s.interp, path, ...(s.args ?? [])], {
        stdin: input,
        env,
        ...(s.long ? { timeoutMs: LONG_TIMEOUT_MS } : {}),
      })
      .catch(() => undefined)
    if (ran) acc = merge(acc, toOutcome(event, ran))
  }
  return acc
}

// 次の hook の結果へスクリプトの結果を重ねる。decided 済みの Outcome は先のものが勝つ。
async function withNext(next: (e: any) => Promise<any>, e: any, mine: Outcome) {
  const rest = (await next(e)) as Outcome
  return merge(mine, rest) as any
}

export const register: Register = (on, options) => {
  on('classic.SessionStart', async ($, e, next) => {
    const mine = await runScripts($, 'SessionStart', e, [{ interp: 'bash', file: 'reset-gate.sh' }])
    return withNext(next, e, mine)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const mine: Outcome = {}
    const text = await loadRules($, options.rulesFile)
    if (text !== '') mine.additionalContext = [text]
    const inject = await runScripts($, 'UserPromptSubmit', e, [{ interp: 'python3', file: 'feedback-inject.py' }])
    return withNext(next, e, merge(mine, inject))
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const guardsAgents = options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(e.tool)
    if (!guardsAgents && !/^(Bash|Edit|Write|MultiEdit)$/.test(e.tool)) return next(e)
    const { tool, tool_use_id, agentId, ...toolInput } = e as Record<string, unknown>
    const stdin = {
      session_id: await $.session.id(),
      cwd: await $.session.cwd(),
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id,
    }
    // settings では `|| true` 付きなので、deny 以外（exit 2 以外）は無視していた。
    const scripts: Script[] = guardsAgents
      ? [{ interp: 'bash', file: 'agent-launch-guard.sh' }]
      : [{ interp: 'python3', file: 'feedback-guard.py' }]
    const mine = await runScripts($, 'PreToolUse', stdin, scripts)
    if (decided(mine)) return mine as any
    return withNext(next, e, mine)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    if (!/^(Write|Edit|MultiEdit)$/.test(e.tool_name)) return next(e)
    const mine = await runScripts($, 'PostToolUse', e, [
      { interp: 'bash', file: 'record-changes.sh' },
      { interp: 'bash', file: 'stop-test-gate.sh', args: ['rules'], long: true },
    ])
    return withNext(next, e, mine)
  })

  on('classic.Notification', async ($, e, next) => {
    await runScripts($, 'Notification', e, [{ interp: 'bash', file: 'notification.sh', args: ['notify'] }])
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const mine = await runScripts($, 'Stop', e, [{ interp: 'bash', file: 'all-stop.sh', long: true }])
    return withNext(next, e, mine)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const mine = await runScripts($, 'SubagentStop', e, [
      { interp: 'bash', file: 'stop-test-gate.sh', args: ['checks'], long: true },
      { interp: 'python3', file: 'feedback-stop-check.py' },
    ])
    return withNext(next, e, mine)
  })
}
