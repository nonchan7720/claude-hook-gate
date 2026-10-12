// サブエージェントの停止時（SubagentStop）に走った hook の結果を、呼び出し元のエージェントへ渡す。
//
// SubagentStop の gate（checks フェーズ）と feedback の stop_check の結果は、サブエージェント自身にしか届かない
// （block の reason はサブエージェントへ、systemMessage はユーザーへ）。呼び出し元は Agent ツールの結果（サブ
// エージェントの最後の発言）しか見えないので、検証が通ったのかを知るには gate のログを読むしかなかった。
//
// そこで SubagentStop のたびに、その回の結果を <feedbackDir>/.subagent_reports/<session>--<agent>.json に書き
// （saveSubagentReport）、呼び出し元の PostToolUse(Agent) で tool_response.agentId から引いて additionalContext と
// して渡し、ファイルを消す（subagentReport）。SubagentStop は block のたびに繰り返されるので、最後の回（サブエージェントが
// 実際に止まった回）の結果が残る。ただし成功報告の直後の Stop（gate が印を消費して素通しした回）は gate の結果を
// 上書きせず、直前の「すべて通った」を残す。
//
// 置き場所は作業ツリーの外（feedback の状態置き場。.bash_started / .count_state と同じ流儀）。gate.yaml の無い PJ でも
// stop_check の結果は渡したいが、その PJ の作業ツリーに状態ファイルを作りたくないため。バックグラウンドで起動した
// サブエージェントは PostToolUse(Agent) が先に来るので引き取られず残る。書くたびに 24h より古いものを掃く。
import { feedbackDir } from './feedback-rules.ts'
import { tr } from './i18n.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { join } from './path.ts'
import { type Dict, isDict, jqStr } from './pyutil.ts'

const DAY_MS = 1440 * 60 * 1000

type Report = { agentType?: string; gate?: string; feedback?: string }

const reportsDir = (io: Io): string => join(feedbackDir(io), '.subagent_reports')

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_')

const reportPath = (io: Io, sessionId: string, agentId: string): string => join(reportsDir(io), `${safe(sessionId)}--${safe(agentId)}.json`)

const blockReason = (stdout: string): string => {
  for (const line of stdout.split('\n')) {
    try {
      const v: unknown = JSON.parse(line)
      if (isDict(v) && v.decision === 'block' && typeof v.reason === 'string') return v.reason
    } catch {
      // JSON でない行は読み飛ばす
    }
  }
  return ''
}

/** feedback の stop_check の結果のうち、呼び出し元へ渡すもの（block の理由、または warn / 打ち切りの出力）。 */
const feedbackText = (r: ScriptResult): string => (r.exitCode === 2 ? blockReason(r.stdout) || r.stderr : r.stderr).trim()

async function loadReport(io: Io, path: string): Promise<Report | undefined> {
  const text = await io.readFile(path)
  if (text === undefined) return undefined
  try {
    const v: unknown = JSON.parse(text)
    return isDict(v) ? (v as Report) : undefined
  } catch {
    return undefined
  }
}

async function sweepStale(io: Io, now: number): Promise<void> {
  const dir = reportsDir(io)
  const old = (await io.list(dir)).filter((e) => e.kind === 'file' && e.mtimeMs < now - DAY_MS).map((e) => join(dir, e.name))
  await io.removeFiles(old)
}

/** SubagentStop: その回の gate と stop_check の結果を控える。常に ok() を返す（作業を止めない）。 */
export async function saveSubagentReport(io: Io, payload: Dict, gate: ScriptResult | undefined, feedback: ScriptResult | undefined): Promise<ScriptResult> {
  try {
    const agentId = jqStr(payload.agent_id)
    if (agentId === '') return ok()
    const path = reportPath(io, jqStr(payload.session_id) || 'unknown', agentId)
    // 成功報告の直後の回は gate を走らせていないので、前の回の結果（すべて通った）を残す。
    const gateText = gate?.reportConsumed ? ((await loadReport(io, path))?.gate ?? '') : (gate?.report ?? '').trim()
    const fbText = feedback ? feedbackText(feedback) : ''
    if (gateText === '' && fbText === '') {
      await io.removeFiles([path])
      return ok()
    }
    const report: Report = {
      ...(jqStr(payload.agent_type) ? { agentType: jqStr(payload.agent_type) } : {}),
      ...(gateText ? { gate: gateText } : {}),
      ...(fbText ? { feedback: fbText } : {}),
    }
    // 古い控えを掃いてから書く（書いたばかりのものを掃かないように）。
    await sweepStale(io, await io.now())
    await io.writeFile(path, `${JSON.stringify(report)}\n`)
  } catch {
    // 控えられなくても作業は止めない。
  }
  return ok()
}

/** PostToolUse(Agent): 終わったサブエージェントの控えがあれば、呼び出し元の context へ渡して消す。 */
export async function subagentReport(io: Io, payload: Dict): Promise<ScriptResult> {
  const response = payload.tool_response
  const agentId = isDict(response) ? jqStr(response.agentId) : ''
  if (agentId === '') return ok()
  const path = reportPath(io, jqStr(payload.session_id) || 'unknown', agentId)
  const report = await loadReport(io, path)
  await io.removeFiles([path])
  if (!report || (!report.gate && !report.feedback)) return ok()
  const agent = report.agentType ? `${report.agentType} (${agentId})` : agentId
  const body = [tr(io.lang)('subagentReport.header', { agent }), report.gate, report.feedback].filter((s) => s).join('\n')
  return ok(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: body } })}\n`)
}
