import type { Engine, HookEvent, HookResult, Register } from 'claude-code'
import { agentLaunchGuard } from './agent-launch-guard.ts'
import { allStop } from './all-stop.ts'
import { createIo } from './engine-io.ts'
import { feedbackGuard } from './feedback-guard.ts'
import { feedbackInject } from './feedback-inject.ts'
import { feedbackStopCheck } from './feedback-stop-check.ts'
import type { Io, ScriptResult } from './io.ts'
import { notification } from './notification.ts'
import { decided, merge, type Outcome, toOutcome } from './outcome.ts'
import type { Dict } from './pyutil.ts'
import { recordChanges } from './record-changes.ts'
import { resetGate } from './reset-gate.ts'
import { loadRules } from './rules-file.ts'
import { stopTestGate } from './stop-test-gate.ts'

// settings.json の command hook をプラグイン同梱の TypeScript 関数（src/）として載せ替えた mod。
// 各関数は classic コマンド hook のスクリプトと同じ { exitCode, stdout, stderr } を返し、
// それを classic の規約どおりに戻り値（Outcome）へ変換する。

type Step = (io: Io) => Promise<ScriptResult>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

async function runSteps($: Engine, event: string, steps: Step[]): Promise<Outcome> {
  let acc: Outcome = {}
  const io = await createIo($)
  for (const step of steps) {
    // スクリプトの内部エラーで作業を止めない。
    const ran = await step(io).catch(() => undefined)
    if (ran) acc = merge(acc, toOutcome(event, ran))
  }
  return acc
}

// 次の hook の結果へ自分の結果を重ねる。decided 済みの Outcome は先のものが勝つ。
async function withNext(next: (e: HookEvent) => Promise<HookResult>, e: HookEvent, mine: Outcome): Promise<HookResult> {
  const rest = (await next(e)) as Outcome
  return merge(mine, rest) as HookResult
}

export const register: Register = (on, options) => {
  on('classic.SessionStart', async ($, e, next) => {
    const mine = await runSteps($, 'SessionStart', [(io) => resetGate(io, e)])
    return withNext(next, e, mine)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const mine: Outcome = {}
    const text = await createIo($).then((io) => loadRules(io, options.rulesFile))
    if (text !== '') mine.additionalContext = [text]
    const inject = await runSteps($, 'UserPromptSubmit', [(io) => feedbackInject(io)])
    return withNext(next, e, merge(mine, inject))
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const tool = str(e.tool)
    const guardsAgents = options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool)
    if (!guardsAgents && !/^(Bash|Edit|Write|MultiEdit)$/.test(tool)) return next(e)
    const { tool: _tool, tool_use_id, agentId: _agentId, ...toolInput } = e
    const payload: Dict = {
      session_id: await $.session.id(),
      cwd: await $.session.cwd(),
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id,
    }
    // settings では `|| true` 付きなので、deny 以外（exit 2 以外）は無視していた。
    const step: Step = guardsAgents ? async () => agentLaunchGuard(payload) : (io) => feedbackGuard(io, payload)
    const mine = await runSteps($, 'PreToolUse', [step])
    if (decided(mine)) return mine as HookResult
    return withNext(next, e, mine)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    if (!/^(Write|Edit|MultiEdit)$/.test(str(e.tool_name))) return next(e)
    const mine = await runSteps($, 'PostToolUse', [(io) => recordChanges(io, e), (io) => stopTestGate(io, 'rules', e)])
    return withNext(next, e, mine)
  })

  on('classic.Notification', async ($, e, next) => {
    await runSteps($, 'Notification', [(io) => notification(io, 'notify', e)])
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const mine = await runSteps($, 'Stop', [(io) => allStop(io, e)])
    return withNext(next, e, mine)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const mine = await runSteps($, 'SubagentStop', [(io) => stopTestGate(io, 'checks', e), (io) => feedbackStopCheck(io, e)])
    return withNext(next, e, mine)
  })
}
