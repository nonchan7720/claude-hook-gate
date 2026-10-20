// settings hook（hooks/hooks.json の command hook）の入口: `node hooks/cli.js <Event>`。
// 組織管理のガード（cc-plugin-sec-default）が classic.* をユーザーの mod に対して飛ばす環境でも、settings hook は飛ばされない。
// classic コマンド hook と同じく stdin の JSON を受け取り、mod（src/register.ts）と同じイベントの処理（src/hooks.ts）を
// 走らせて、classic の規約（stdout の JSON・stderr・終了コード）で返す。プラグイン設定は環境変数 CLAUDE_PLUGIN_OPTION_<KEY> で渡される。
import type { PluginOptions } from 'claude-code'
import * as hooks from './hooks.ts'
import type { ScriptResult } from './io.ts'
import { makeNodeIo } from './node-io.ts'
import { outcomeToClassic } from './outcome.ts'
import { type Dict, isDict } from './pyutil.ts'

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'] as const
type HookName = (typeof EVENTS)[number]

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

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

/** イベントの処理（src/hooks.ts）を走らせ、classic の出力にして返す。 */
export async function runHook(event: HookName, payload: Dict, env: NodeJS.ProcessEnv): Promise<ScriptResult> {
  const options = optionsFromEnv(env)
  const io = makeNodeIo({ env, payloadCwd: str(payload.cwd), language: str(options.language), autoCount: options.autoCount !== false })
  const sessionId = str(payload.session_id) || 'unknown'
  const run = {
    SessionStart: () => hooks.sessionStart(io, sessionId, payload),
    UserPromptSubmit: () => hooks.userPromptSubmit(io, sessionId, options),
    PreToolUse: () => hooks.preToolUse(io, sessionId, options, payload),
    PostToolUse: () => hooks.postToolUse(io, sessionId, payload),
    Notification: () => hooks.notification(io, sessionId, payload),
    Stop: () => hooks.stop(io, sessionId, payload),
    SubagentStop: () => hooks.subagentStop(io, sessionId, payload),
  }[event]
  const { outcome, stderr } = await run()
  return outcomeToClassic(event, outcome, stderr)
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
