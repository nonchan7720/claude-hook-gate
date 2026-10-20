// settings hook（hooks/hooks.json の command hook）の入口: `node hooks/cli.js <Event>`。
// 組織管理のガードが classic.* を飛ばす環境でも、settings hook は飛ばされない。classic コマンド hook と同じく stdin の JSON を
// 受け取り、mod（src/register.ts）と同じ処理（src/hooks.ts）を走らせて、classic の規約（stdout の JSON・stderr・終了コード）で返す。
// プラグイン設定は環境変数 CLAUDE_PLUGIN_OPTION_<KEY> で渡される。
import type { PluginOptions } from 'claude-code'
import { allStop } from './all-stop.ts'
import { guardsTool, postToolSteps, preGuardSteps, promptStepsResult, runStepsCollect, type Step, type StepsResult, subagentStopSteps } from './hooks.ts'
import { makeNodeIo } from './node-io.ts'
import { notification } from './notification.ts'
import { outcomeToClassic } from './outcome.ts'
import { type Dict, isDict } from './pyutil.ts'
import { resetGate } from './reset-gate.ts'

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'] as const
type HookName = (typeof EVENTS)[number]

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** プラグイン設定（CLAUDE_PLUGIN_OPTION_<KEY>。boolean は "true" / "false" の文字列）を register の options と同じ形にする。 */
export function optionsFromEnv(env: NodeJS.ProcessEnv): PluginOptions {
  const opt = (key: string): string | undefined => env[`CLAUDE_PLUGIN_OPTION_${key}`]
  return {
    language: opt('language'),
    // register の options と同じ判定: agentLaunchGuard は true のときだけ有効、autoCount は false でなければ有効。
    agentLaunchGuard: opt('agentLaunchGuard') === 'true',
    autoCount: opt('autoCount') !== 'false',
    rulesFile: opt('rulesFile'),
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function parsePayload(text: string): Dict {
  try {
    const v: unknown = JSON.parse(text)
    return isDict(v) ? v : {}
  } catch {
    return {}
  }
}

/** イベントごとの処理を走らせ、classic の出力（終了コード・stdout・stderr）にして返す。 */
export async function runHook(event: HookName, payload: Dict, env: NodeJS.ProcessEnv) {
  const options = optionsFromEnv(env)
  const io = makeNodeIo({ env, payloadCwd: str(payload.cwd), language: str(options.language), autoCount: options.autoCount !== false })
  const sessionId = str(payload.session_id) || 'unknown'
  const run = (steps: Step[]): Promise<StepsResult> => runStepsCollect(io, sessionId, event, steps)
  let result: StepsResult = { outcome: {}, stderr: '' }
  switch (event) {
    case 'SessionStart':
      result = await run([(i) => resetGate(i, payload)])
      break
    case 'UserPromptSubmit':
      result = await promptStepsResult(io, sessionId, options)
      break
    case 'PreToolUse': {
      const tool = str(payload.tool_name)
      if (guardsTool(options, tool)) result = await run(preGuardSteps(options, tool, payload))
      break
    }
    case 'PostToolUse': {
      const steps = postToolSteps(str(payload.tool_name), payload)
      if (steps) result = await run(steps)
      break
    }
    case 'Notification':
      // 通知は何も返さない（結果は捨てる）。
      await run([(i) => notification(i, 'notify', payload)])
      break
    case 'Stop':
      result = await run([(i) => allStop(i, payload)])
      break
    case 'SubagentStop':
      result = await run(subagentStopSteps(payload))
      break
  }
  return outcomeToClassic(event, result.outcome, result.stderr)
}

async function main(): Promise<void> {
  const event = EVENTS.find((e) => e === process.argv[2])
  if (!event) {
    process.stderr.write(`usage: cli.js <${EVENTS.join('|')}>\n`)
    process.exit(1)
  }
  const payload = parsePayload(await readStdin())
  try {
    const out = await runHook(event, payload, process.env)
    process.stdout.write(out.stdout)
    process.stderr.write(out.stderr)
    process.exitCode = out.exitCode
  } catch {
    // hook の内部エラーで作業を止めない。
    process.exitCode = 0
  }
}

await main()
