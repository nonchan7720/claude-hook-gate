import type { Engine, HookEvent, HookResult, PluginOptions, Register } from 'claude-code'
import { agentLaunchGuard } from './agent-launch-guard.ts'
import { allStop } from './all-stop.ts'
import { bashChanges, bashStarted } from './bash-changes.ts'
import { correctCommand } from './correct.ts'
import { createIo } from './engine-io.ts'
import { feedbackGuard } from './feedback-guard.ts'
import { feedbackInject } from './feedback-inject.ts'
import { feedbackPostEdit } from './feedback-post-edit.ts'
import { feedbackStopCheck } from './feedback-stop-check.ts'
import { tr } from './i18n.ts'
import type { Io, ScriptResult } from './io.ts'
import { notification } from './notification.ts'
import { decided, merge, type Outcome, toOutcome } from './outcome.ts'
import type { Dict } from './pyutil.ts'
import { recordChanges } from './record-changes.ts'
import { resetGate } from './reset-gate.ts'
import { loadRules } from './rules-file.ts'
import { listRunning, loadSummary, runningBand } from './running-registry.ts'
import { stopTestGate } from './stop-test-gate.ts'

// settings.json の command hook をプラグイン同梱の TypeScript 関数（src/）として載せ替えた mod。
// 各関数は classic コマンド hook のスクリプトと同じ { exitCode, stdout, stderr } を返し、
// それを classic の規約どおりに戻り値（Outcome）へ変換する。

type Step = (io: Io) => Promise<ScriptResult>

/** 評価中表示（progress）を出し始めるまでの待ち時間。これより早く終わる評価では何も出さない。 */
const PROGRESS_DELAY_MS = 3000

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

async function runSteps($: Engine, options: PluginOptions, event: string, steps: Step[]): Promise<Outcome> {
  let acc: Outcome = {}
  const base = await createIo($, options)
  const sessionId = await $.session.id()
  // 処理中の 1 行（progress）を出した hook だけ、終わりに片付ける（毎回のちらつきを避ける）。gate の結果（result）は
  // 次のコマンドが走り始めるまで残すので、消さずに完了サマリへ戻す。
  // ただし最初の progress から PROGRESS_DELAY_MS 経っても終わっていないときだけ出す（すぐ終わる評価でステータス行を触らない）。
  let shown = false
  let pending: string | undefined
  let cancelDelay: (() => void) | undefined
  const show = () => {
    if (shown || pending === undefined) return
    shown = true
    cancelDelay?.()
    base.progress?.(pending)
  }
  const io: Io = {
    ...base,
    progress: (text) => {
      if (shown) return base.progress?.(text)
      pending = text
      if (text === undefined || cancelDelay) return
      if (!base.every) return show()
      cancelDelay = base.every(PROGRESS_DELAY_MS, show)
      // every が登録中に fn を呼ぶ実装でも、cancelDelay の代入後に止める。
      if (shown) cancelDelay()
    },
  }
  try {
    for (const step of steps) {
      // スクリプトの内部エラーで作業を止めない。
      const ran = await step(io).catch(() => undefined)
      if (ran) acc = merge(acc, toOutcome(event, ran))
    }
  } finally {
    cancelDelay?.()
    // 出していたなら、残っている gate の完了サマリがあればそれに戻し、無ければ消す。
    if (shown) base.progress?.(await loadSummary(base, sessionId))
  }
  return acc
}

// 次の hook の結果へ自分の結果を重ねる。decided 済みの Outcome は先のものが勝つ。
async function withNext(next: (e: HookEvent) => Promise<HookResult>, e: HookEvent, mine: Outcome): Promise<HookResult> {
  const rest = (await next(e)) as Outcome
  return merge(mine, rest) as HookResult
}

export const register: Register = (on, options) => {
  // /correct: feedback ルールと違反ログを集計し、count の引き上げや enforce の追加を提案する。
  on('session.start', async ($, e, next) => {
    try {
      const io = await createIo($, options)
      await $.command.register({
        name: 'correct',
        description: tr(io.lang)('correct.description'),
        argumentHint: '[--window 30d] [--min 2] [apply]',
      })
    } catch {
      // コマンド API の無いエンジンでもセッション開始は止めない。
    }
    return next(e)
  })

  on('command.run', { command: 'correct' }, async ($, e) => correctCommand(await createIo($, options), String(e.args ?? '')))

  on('classic.SessionStart', async ($, e, next) => {
    const mine = await runSteps($, options, 'SessionStart', [(io) => resetGate(io, e)])
    return withNext(next, e, mine)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const mine: Outcome = {}
    const text = await createIo($, options).then((io) => loadRules(io, options.rulesFile))
    if (text !== '') mine.additionalContext = [text]
    const inject = await runSteps($, options, 'UserPromptSubmit', [(io) => feedbackInject(io)])
    return withNext(next, e, merge(mine, inject))
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const tool = str(e.tool)
    const guardsAgents = options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool)
    if (!guardsAgents && !/^(Bash|Edit|Write|MultiEdit)$/.test(tool)) return next(e)
    const { tool: _tool, tool_use_id, agentId, ...toolInput } = e
    const payload: Dict = {
      session_id: await $.session.id(),
      cwd: await $.session.cwd(),
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id,
    }
    // エンジンは classic.PreToolUse のイベントにエージェント ID を入れない（tool.call の入力から agentId を落として
    // tool / tool_use_id を足した形）。入っていたときだけ揃えておく。bash_started は tool_use_id で引くので、
    // サブエージェントの中でもここに agent_id が無いことは問題にならない（src/bash-changes.ts）。
    if (typeof agentId === 'string' && agentId !== '') payload.agent_id = agentId
    // settings では `|| true` 付きなので、deny 以外（exit 2 以外）は無視していた。
    const step: Step = guardsAgents ? async (io) => agentLaunchGuard(payload, io.lang) : (io) => feedbackGuard(io, payload)
    // Bash は、開始時刻を控えてから guard を評価する（終了後の変更ファイル追跡用）。
    const steps: Step[] = tool === 'Bash' ? [(io) => bashStarted(io, payload), step] : [step]
    const mine = await runSteps($, options, 'PreToolUse', steps)
    if (decided(mine)) return mine as HookResult
    return withNext(next, e, mine)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    if (str(e.tool_name) === 'Bash') {
      // Bash が実際に書き換えたファイルだけを記録し、あれば rules フェーズを走らせる。
      const mine = await runSteps($, options, 'PostToolUse', [(io) => bashChanges(io, e)])
      return withNext(next, e, mine)
    }
    if (!/^(Write|Edit|MultiEdit)$/.test(str(e.tool_name))) return next(e)
    // gate の実行より先に、軽い feedback の post_edit 検査を済ませる。
    const mine = await runSteps($, options, 'PostToolUse', [
      (io) => recordChanges(io, e),
      (io) => feedbackPostEdit(io, e),
      (io) => stopTestGate(io, 'rules', e),
    ])
    return withNext(next, e, mine)
  })

  on('classic.Notification', async ($, e, next) => {
    await runSteps($, options, 'Notification', [(io) => notification(io, 'notify', e)])
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const mine = await runSteps($, options, 'Stop', [(io) => allStop(io, e)])
    return withNext(next, e, mine)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const mine = await runSteps($, options, 'SubagentStop', [(io) => stopTestGate(io, 'checks', e), (io) => feedbackStopCheck(io, e)])
    return withNext(next, e, mine)
  })

  // gate が実行中のコマンドを、プロンプトの上の帯に複数行で出す。自セッションの実行が終わるか、
  // アンケートが帯を使っている間は、エンジンの帯に譲る。描き直しは gate が $.ui.invalidate で促す。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const io = await createIo($, options)
    return runningBand(await listRunning(io, await $.session.id()), await io.now(), io.lang) ?? next(e)
  })
}
