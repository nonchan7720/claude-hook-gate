// イベントごとの処理（中核）。mod（src/register.ts、classic.* から）がここを呼び、ここが各イベントの実装（src/feedback-guard.ts、
// src/stop-test-gate.ts など）を呼ぶ。command hook の CLI は Go 版（internal/hookgate/hooks.go と host*.go。バイナリは
// `feedback-gate claude|codex <Event>`）にあり、この中核を同じ構成で移したもの。
// 引数の payload は classic コマンド hook が stdin で受け取る JSON の形。各段は classic のスクリプトと同じ
// { exitCode, stdout, stderr } を返し、それを classic の規約どおり Outcome にまとめて返す。
import type { PluginOptions } from 'claude-code'
import { agentLaunchGuard, agentLaunchLists } from './agent-launch-guard.ts'
import { allStop } from './all-stop.ts'
import { bashChangeSteps, bashStarted } from './bash-changes.ts'
import { feedbackFileInject } from './feedback-file-inject.ts'
import { feedbackGuard } from './feedback-guard.ts'
import { feedbackInject } from './feedback-inject.ts'
import { feedbackPostEdit } from './feedback-post-edit.ts'
import { feedbackStopCheck } from './feedback-stop-check.ts'
import type { Io, ScriptResult } from './io.ts'
import { notification as desktopNotification } from './notification.ts'
import { merge, type Outcome, toOutcome } from './outcome.ts'
import type { Dict } from './pyutil.ts'
import { recordChanges } from './record-changes.ts'
import { resetGate } from './reset-gate.ts'
import { loadRules } from './rules-file.ts'
import { loadSummary } from './running-registry.ts'
import { stopTestGate } from './stop-test-gate.ts'
import { saveSubagentReport, subagentReport } from './subagent-report.ts'

type Step = (io: Io) => Promise<ScriptResult>

/** 1 イベント分の結果。stderr は正常終了（exit 0）した段が出したもの（warn など）。block の理由（exit 2）は outcome に入る。 */
export type HookRun = { outcome: Outcome; stderr: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const none: HookRun = { outcome: {}, stderr: '' }

/** 評価中表示（progress）を出し始めるまでの待ち時間。これより早く終わる評価では何も出さない。 */
const PROGRESS_DELAY_MS = 3000

/** 各段を順に走らせ、classic の規約で Outcome にまとめる。 */
async function runSteps(base: Io, sessionId: string, event: string, steps: Step[], first: Outcome = {}): Promise<HookRun> {
  let acc = first
  let stderr = ''
  // 処理中の 1 行（progress）を出した hook だけ、終わりに片付ける（毎回のちらつきを避ける）。gate の結果（result）は
  // 次のコマンドが走り始めるまで残すので、消さずに完了サマリへ戻す。
  // ただし最初の progress から PROGRESS_DELAY_MS 経っても終わっていないときだけ出す（すぐ終わる評価でステータス行を触らない）。
  // 画面を持たない Io（CLI）では progress / every が無いので、この部分は何もしない。
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

/** SessionStart: 自セッションの gate 状態を消す（startup / clear）。 */
export const sessionStart = (io: Io, sessionId: string, payload: Dict): Promise<HookRun> =>
  runSteps(io, sessionId, 'SessionStart', [(i) => resetGate(i, payload)])

/** UserPromptSubmit: rules ファイル（rulesFile か同梱のもの）と、確定した feedback ルールを context に足す。 */
export async function userPromptSubmit(io: Io, sessionId: string, options: PluginOptions): Promise<HookRun> {
  const text = await loadRules(io, options.rulesFile)
  return runSteps(io, sessionId, 'UserPromptSubmit', [(i) => feedbackInject(i, sessionId)], text === '' ? {} : { additionalContext: [text] })
}

/** PreToolUse の判定の対象: Bash / Edit / Write / MultiEdit と、agentLaunchGuard が有効なら Agent / SendMessage。 */
export const guardsTool = (options: PluginOptions, tool: string): boolean =>
  (options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool)) || /^(Bash|Edit|Write|MultiEdit)$/.test(tool)

/**
 * PreToolUse: pre_bash / pre_edit の enforce（または agentLaunchGuard）を評価し、deny / ask を返す。対象外のツールは何もしない。
 * settings では `|| true` 付きなので、deny 以外（exit 2 以外）は無視していた。
 * Bash は、開始時刻を控えてから guard を評価する（終了後の変更ファイル追跡用）。
 */
export function preToolUse(io: Io, sessionId: string, options: PluginOptions, payload: Dict): Promise<HookRun> {
  const tool = str(payload.tool_name)
  if (!guardsTool(options, tool)) return Promise.resolve(none)
  const guardsAgents = options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool)
  const step: Step = guardsAgents ? async (i) => agentLaunchGuard(payload, i.lang, agentLaunchLists(i.env)) : (i) => feedbackGuard(i, payload)
  return runSteps(io, sessionId, 'PreToolUse', tool === 'Bash' ? [(i) => bashStarted(i, payload), step] : [step])
}

/**
 * PostToolUse: 変更ファイルの記録、post_edit の検査、gate の rules フェーズ。Agent / Task はサブエージェントの結果の受け渡し。
 * Read と、Edit / Write / MultiEdit / Bash（heredoc）の書き先では、files 付きの feedback ルールの注入（feedback-file-inject.ts）を先に行う。対象外は何もしない。
 */
export function postToolUse(io: Io, sessionId: string, payload: Dict): Promise<HookRun> {
  const tool = str(payload.tool_name)
  const run = (steps: Step[]) => runSteps(io, sessionId, 'PostToolUse', steps)
  // 終わったサブエージェントの SubagentStop で走った hook の結果を、呼び出し元の context へ渡す（gate のログを読ませない）。
  if (/^(Agent|Task)$/.test(tool)) return run([(i) => subagentReport(i, payload)])
  const inject: Step = (i) => feedbackFileInject(i, payload)
  // 読んだファイルにスコープされたルールを、編集の前に届ける。
  if (tool === 'Read') return run([inject])
  // Bash が実際に書き換えたファイルを拾い、Edit / Write と同じく feedback の post_edit（と、実行後に判定できる
  // pre_edit）で検査してから、メモに記録できたときだけ rules フェーズを走らせる。gate.yaml が無くても feedback の検査は動く。
  if (tool === 'Bash') return run([inject, ...bashChangeSteps(payload)])
  if (!/^(Write|Edit|MultiEdit)$/.test(tool)) return Promise.resolve(none)
  // gate の実行より先に、軽い feedback の post_edit 検査を済ませる。
  return run([inject, (i) => recordChanges(i, payload), (i) => feedbackPostEdit(i, payload), (i) => stopTestGate(i, 'rules', payload)])
}

/** 複数ファイルを 1 回で編集するツール向け: ファイルごとに preToolUse を走らせ、deny > ask で 1 つの判定にする。 */
export async function preToolUseEdits(io: Io, sessionId: string, options: PluginOptions, payloads: Dict[]): Promise<HookRun> {
  const runs: HookRun[] = []
  for (const p of payloads) runs.push(await preToolUse(io, sessionId, options, p))
  const denies = runs.map((r) => r.outcome.deny).filter((r): r is string => r !== undefined)
  const asks = runs.map((r) => r.outcome.ask).filter((r): r is string => r !== undefined)
  const outcome: Outcome = {}
  if (denies.length > 0) outcome.deny = [...denies, ...asks].join('\n')
  else if (asks.length > 0) outcome.ask = asks.join('\n')
  return { outcome, stderr: runs.map((r) => r.stderr).join('') }
}

/** 複数ファイルを 1 回で編集するツール向け: ファイルごとの記録と post_edit の後、gate の rules フェーズは 1 回だけ走らせる。 */
export function postToolUseEdits(io: Io, sessionId: string, payloads: Dict[]): Promise<HookRun> {
  const [first] = payloads
  if (!first) return Promise.resolve(none)
  const steps: Step[] = payloads.flatMap((p): Step[] => [(i) => feedbackFileInject(i, p), (i) => recordChanges(i, p), (i) => feedbackPostEdit(i, p)])
  steps.push((i) => stopTestGate(i, 'rules', first))
  return runSteps(io, sessionId, 'PostToolUse', steps)
}

/** Notification: 確認待ちのデスクトップ通知。何も返さない。 */
export const notification = (io: Io, sessionId: string, payload: Dict): Promise<HookRun> =>
  runSteps(io, sessionId, 'Notification', [(i) => desktopNotification(i, 'notify', payload)])

/** Stop: gate の checks フェーズ、feedback の stop_check、完了通知（src/all-stop.ts）。 */
export const stop = (io: Io, sessionId: string, payload: Dict): Promise<HookRun> => runSteps(io, sessionId, 'Stop', [(i) => allStop(i, payload)])

/** SubagentStop: gate の checks フェーズと stop_check。結果は呼び出し元の PostToolUse(Agent) へ渡すために控える（src/subagent-report.ts）。 */
export function subagentStop(io: Io, sessionId: string, payload: Dict): Promise<HookRun> {
  let gate: ScriptResult | undefined
  let feedback: ScriptResult | undefined
  return runSteps(io, sessionId, 'SubagentStop', [
    async (i) => (gate = await stopTestGate(i, 'checks', payload)),
    async (i) => (feedback = await feedbackStopCheck(i, payload)),
    (i) => saveSubagentReport(i, payload, gate, feedback),
  ])
}
