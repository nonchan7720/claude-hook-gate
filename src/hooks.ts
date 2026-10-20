import type { PluginOptions } from 'claude-code'
import { agentLaunchGuard } from './agent-launch-guard.ts'
import { bashChangeSteps, bashStarted } from './bash-changes.ts'
import { feedbackGuard } from './feedback-guard.ts'
import { feedbackInject } from './feedback-inject.ts'
import { feedbackPostEdit } from './feedback-post-edit.ts'
import { feedbackStopCheck } from './feedback-stop-check.ts'
import type { Io, ScriptResult } from './io.ts'
import { merge, type Outcome, toOutcome } from './outcome.ts'
import type { Dict } from './pyutil.ts'
import { recordChanges } from './record-changes.ts'
import { loadRules } from './rules-file.ts'
import { loadSummary } from './running-registry.ts'
import { stopTestGate } from './stop-test-gate.ts'
import { saveSubagentReport, subagentReport } from './subagent-report.ts'

// イベントごとの処理の組み立て。mod（src/register.ts）と settings hook の CLI（src/cli.ts）が共有する。
// 各段は classic コマンド hook のスクリプトと同じ { exitCode, stdout, stderr } を返す。

export type Step = (io: Io) => Promise<ScriptResult>

/** 評価中表示（progress）を出し始めるまでの待ち時間。これより早く終わる評価では何も出さない。 */
const PROGRESS_DELAY_MS = 3000

export type StepsResult = {
  outcome: Outcome
  /** 正常終了（exit 0）した段が stderr に出したもの（warn など）。block の理由（exit 2）は outcome に入るので含めない。 */
  stderr: string
}

/** 各段を順に走らせ、classic の規約で Outcome にまとめる。 */
export async function runStepsCollect(base: Io, sessionId: string, event: string, steps: Step[]): Promise<StepsResult> {
  let acc: Outcome = {}
  let stderr = ''
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
      if (!ran) continue
      acc = merge(acc, toOutcome(event, ran))
      if (ran.exitCode === 0) stderr += ran.stderr
    }
  } finally {
    cancelDelay?.()
    // 出していたなら、残っている gate の完了サマリがあればそれに戻し、無ければ消す。
    if (shown) base.progress?.(await loadSummary(base, sessionId))
  }
  return { outcome: acc, stderr }
}

export const runSteps = async (base: Io, sessionId: string, event: string, steps: Step[]): Promise<Outcome> =>
  (await runStepsCollect(base, sessionId, event, steps)).outcome

/** Bash / Edit / Write / MultiEdit（と、agentLaunchGuard が有効なら Agent / SendMessage）は PreToolUse の判定の対象。 */
export const guardsTool = (options: PluginOptions, tool: string): boolean =>
  (options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool)) || /^(Bash|Edit|Write|MultiEdit)$/.test(tool)

/**
 * PreToolUse の判定の各段。settings では `|| true` 付きなので、deny 以外（exit 2 以外）は無視していた。
 * Bash は、開始時刻を控えてから guard を評価する（終了後の変更ファイル追跡用）。
 */
export function preGuardSteps(options: PluginOptions, tool: string, payload: Dict): Step[] {
  const guardsAgents = options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool)
  const step: Step = guardsAgents ? async (io) => agentLaunchGuard(payload, io.lang) : (io) => feedbackGuard(io, payload)
  return tool === 'Bash' ? [(io) => bashStarted(io, payload), step] : [step]
}

/** PostToolUse の各段。対象外のツールは undefined。payload は classic.PostToolUse の stdin JSON の形。 */
export function postToolSteps(tool: string, payload: Dict): Step[] | undefined {
  // 終わったサブエージェントの SubagentStop で走った hook の結果を、呼び出し元の context へ渡す（gate のログを読ませない）。
  if (/^(Agent|Task)$/.test(tool)) return [(io) => subagentReport(io, payload)]
  // Bash が実際に書き換えたファイルを拾い、Edit / Write と同じく feedback の post_edit（と、実行後に判定できる
  // pre_edit）で検査してから、メモに記録できたときだけ rules フェーズを走らせる。gate.yaml が無くても feedback の検査は動く。
  if (tool === 'Bash') return bashChangeSteps(payload)
  if (!/^(Write|Edit|MultiEdit)$/.test(tool)) return undefined
  // gate の実行より先に、軽い feedback の post_edit 検査を済ませる。
  return [(io) => recordChanges(io, payload), (io) => feedbackPostEdit(io, payload), (io) => stopTestGate(io, 'rules', payload)]
}

/** SubagentStop の各段。結果は呼び出し元の PostToolUse(Agent) へ渡すために控える（src/subagent-report.ts）。 */
export function subagentStopSteps(payload: Dict): Step[] {
  let gate: ScriptResult | undefined
  let feedback: ScriptResult | undefined
  return [
    async (io) => (gate = await stopTestGate(io, 'checks', payload)),
    async (io) => (feedback = await feedbackStopCheck(io, payload)),
    (io) => saveSubagentReport(io, payload, gate, feedback),
  ]
}

/** UserPromptSubmit が Claude の context に足すもの: rules ファイルと、確定した feedback ルール。 */
export async function promptStepsResult(io: Io, sessionId: string, options: PluginOptions): Promise<StepsResult> {
  const mine: Outcome = {}
  const text = await loadRules(io, options.rulesFile)
  if (text !== '') mine.additionalContext = [text]
  const inject = await runStepsCollect(io, sessionId, 'UserPromptSubmit', [(i) => feedbackInject(i)])
  return { outcome: merge(mine, inject.outcome), stderr: inject.stderr }
}

export const promptOutcome = async (io: Io, sessionId: string, options: PluginOptions): Promise<Outcome> =>
  (await promptStepsResult(io, sessionId, options)).outcome
