// settings hook（hooks/hooks.json の command hook）の入口: `node hooks/cli.js <Event>`。
// 組織管理のガード（cc-plugin-sec-default）が classic.* をユーザーの mod に対して飛ばす環境でも、settings hook は飛ばされない。
// classic コマンド hook と同じく stdin の JSON を受け取り、mod（src/register.ts）と同じ関数を同じ順で走らせて、
// classic の規約（stdout の JSON・stderr・終了コード）で返す。プラグイン設定は環境変数 CLAUDE_PLUGIN_OPTION_<KEY> で渡される。
import type { PluginOptions } from 'claude-code'
import { agentLaunchGuard } from './agent-launch-guard.ts'
import { allStop } from './all-stop.ts'
import { bashChangeSteps, bashStarted } from './bash-changes.ts'
import { feedbackGuard } from './feedback-guard.ts'
import { feedbackInject } from './feedback-inject.ts'
import { feedbackPostEdit } from './feedback-post-edit.ts'
import { feedbackStopCheck } from './feedback-stop-check.ts'
import type { Io, ScriptResult } from './io.ts'
import { makeNodeIo } from './node-io.ts'
import { notification } from './notification.ts'
import { merge, type Outcome, outcomeToClassic, toOutcome } from './outcome.ts'
import { type Dict, isDict } from './pyutil.ts'
import { recordChanges } from './record-changes.ts'
import { resetGate } from './reset-gate.ts'
import { loadRules } from './rules-file.ts'
import { stopTestGate } from './stop-test-gate.ts'
import { saveSubagentReport, subagentReport } from './subagent-report.ts'

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'] as const
type HookName = (typeof EVENTS)[number]
type Step = (io: Io) => Promise<ScriptResult>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const nothing: ScriptResult = { exitCode: 0, stdout: '', stderr: '' }

/** プラグイン設定（CLAUDE_PLUGIN_OPTION_<KEY>。boolean は "true" / "false" の文字列）を register の options と同じ形にする。 */
export function optionsFromEnv(env: NodeJS.ProcessEnv): PluginOptions {
  const opt = (key: string): string | undefined => env[`CLAUDE_PLUGIN_OPTION_${key}`]
  return {
    language: opt('language'),
    agentLaunchGuard: opt('agentLaunchGuard') === 'true',
    autoCount: opt('autoCount') !== 'false',
    rulesFile: opt('rulesFile'),
  }
}

/** 各段を順に走らせ（register.ts の runSteps と同じ規約。画面表示は無い）、classic の出力に戻す。 */
async function runSteps(io: Io, event: string, steps: Step[], first: Outcome = {}): Promise<ScriptResult> {
  let acc = first
  let stderr = ''
  for (const step of steps) {
    // スクリプトの内部エラーで作業を止めない。
    const ran = await step(io).catch(() => undefined)
    if (!ran) continue
    acc = merge(acc, toOutcome(event, ran))
    // 正常終了した段の stderr（warn など）はそのまま出す。block の理由（exit 2）は Outcome に入る。
    if (ran.exitCode === 0) stderr += ran.stderr
  }
  return outcomeToClassic(event, acc, stderr)
}

/** イベントごとの処理（src/register.ts の各 classic.* フックと同じ段）を走らせ、classic の出力にして返す。 */
export async function runHook(event: HookName, payload: Dict, env: NodeJS.ProcessEnv): Promise<ScriptResult> {
  const options = optionsFromEnv(env)
  const io = makeNodeIo({ env, payloadCwd: str(payload.cwd), language: str(options.language), autoCount: options.autoCount !== false })
  const tool = str(payload.tool_name)
  switch (event) {
    case 'SessionStart':
      return runSteps(io, event, [(i) => resetGate(i, payload)])
    case 'UserPromptSubmit': {
      const text = await loadRules(io, options.rulesFile)
      return runSteps(io, event, [(i) => feedbackInject(i)], text === '' ? {} : { additionalContext: [text] })
    }
    case 'PreToolUse': {
      const guardsAgents = options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool)
      if (!guardsAgents && !/^(Bash|Edit|Write|MultiEdit)$/.test(tool)) return nothing
      const step: Step = guardsAgents ? async (i) => agentLaunchGuard(payload, i.lang) : (i) => feedbackGuard(i, payload)
      return runSteps(io, event, tool === 'Bash' ? [(i) => bashStarted(i, payload), step] : [step])
    }
    case 'PostToolUse':
      if (/^(Agent|Task)$/.test(tool)) return runSteps(io, event, [(i) => subagentReport(i, payload)])
      if (tool === 'Bash') return runSteps(io, event, bashChangeSteps(payload))
      if (!/^(Write|Edit|MultiEdit)$/.test(tool)) return nothing
      return runSteps(io, event, [(i) => recordChanges(i, payload), (i) => feedbackPostEdit(i, payload), (i) => stopTestGate(i, 'rules', payload)])
    case 'Notification':
      await notification(io, 'notify', payload).catch(() => undefined)
      return nothing
    case 'Stop':
      return runSteps(io, event, [(i) => allStop(i, payload)])
    case 'SubagentStop': {
      let gate: ScriptResult | undefined
      let feedback: ScriptResult | undefined
      return runSteps(io, event, [
        async (i) => (gate = await stopTestGate(i, 'checks', payload)),
        async (i) => (feedback = await feedbackStopCheck(i, payload)),
        (i) => saveSubagentReport(i, payload, gate, feedback),
      ])
    }
  }
}

async function main(): Promise<void> {
  const event = EVENTS.find((e) => e === process.argv[2])
  if (!event) {
    process.stderr.write(`usage: cli.js <${EVENTS.join('|')}>\n`)
    process.exit(1)
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  let payload: Dict = {}
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (isDict(v)) payload = v
  } catch {
    // 壊れた JSON は空として扱う（hook の内部エラーで作業を止めない）。
  }
  try {
    const out = await runHook(event, payload, process.env)
    process.stdout.write(out.stdout)
    process.stderr.write(out.stderr)
    process.exitCode = out.exitCode
  } catch {
    process.exitCode = 0
  }
}

await main()
