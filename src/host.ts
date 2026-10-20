// ホスト（Claude Code / Codex）と中核（src/hooks.ts）の境界。
// 中核は classic コマンド hook の JSON を受けて Outcome を返す。ホストごとの違いは Host の実装が吸収し、中核には手を入れない。
import type { PluginOptions } from 'claude-code'
import type { HookRun } from './hooks.ts'
import * as hooks from './hooks.ts'
import type { Io, ScriptResult } from './io.ts'
import { makeNodeIo } from './node-io.ts'
import type { Outcome } from './outcome.ts'
import { type Dict, isDict } from './pyutil.ts'

export const CORE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'] as const
export type CoreEvent = (typeof CORE_EVENTS)[number]

/** 中核への 1 回の呼び出し。payloads が複数なのは 1 回で複数ファイルを編集するツールをファイルごとに分けたとき。 */
export type CoreCall = { event: CoreEvent; payloads: Dict[] } | undefined

export interface Host {
  /** 通知の見出しに使うアプリ名。 */
  readonly appName: string
  /** command hook が受けるイベント名。 */
  readonly events: readonly string[]
  /** 設定ディレクトリ名の候補（優先順）。 */
  readonly configDirNames: readonly string[]
  /** 環境変数からのプラグイン設定。 */
  options(env: NodeJS.ProcessEnv): PluginOptions
  /** ホストのイベントと stdin の JSON を中核の呼び出しに直す。 */
  normalize(event: string, payload: Dict, io: Io): CoreCall
  /** 中核の結果（Outcome と warn の stderr）をホストの出力にする。 */
  render(event: string, outcome: Outcome, stderr: string, io: Io): ScriptResult
}

const none: HookRun = { outcome: {}, stderr: '' }

export async function runCore(io: Io, call: CoreCall, sessionId: string, options: PluginOptions): Promise<HookRun> {
  if (!call) return none
  const [first] = call.payloads
  if (!first) return none
  const many = call.payloads.length > 1
  switch (call.event) {
    case 'SessionStart':
      return hooks.sessionStart(io, sessionId, first)
    case 'UserPromptSubmit':
      return hooks.userPromptSubmit(io, sessionId, options)
    case 'PreToolUse':
      return many ? hooks.preToolUseEdits(io, sessionId, options, call.payloads) : hooks.preToolUse(io, sessionId, options, first)
    case 'PostToolUse':
      return many ? hooks.postToolUseEdits(io, sessionId, call.payloads) : hooks.postToolUse(io, sessionId, first)
    case 'Notification':
      return hooks.notification(io, sessionId, first)
    case 'Stop':
      return hooks.stop(io, sessionId, first)
    case 'SubagentStop':
      return hooks.subagentStop(io, sessionId, first)
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export async function runHostHook(host: Host, event: string, payload: Dict, env: NodeJS.ProcessEnv): Promise<ScriptResult> {
  const options = host.options(env)
  const io = makeNodeIo({
    env,
    payloadCwd: str(payload.cwd),
    language: str(options.language),
    autoCount: options.autoCount !== false,
    appName: host.appName,
    configDirNames: host.configDirNames,
  })
  const sessionId = str(payload.session_id) || 'unknown'
  const { outcome, stderr } = await runCore(io, host.normalize(event, payload, io), sessionId, options)
  return host.render(event, outcome, stderr, io)
}

/** command hook の入口: `node cli.js <Event>`、stdin の JSON → stdout / stderr / 終了コード。 */
export async function cliMain(host: Host): Promise<void> {
  const event = host.events.find((e) => e === process.argv[2])
  if (!event) {
    process.stderr.write(`usage: cli.js <${host.events.join('|')}>\n`)
    process.exit(1)
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  let payload: Dict = {}
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (isDict(v)) payload = v
  } catch {
    // 壊れた JSON で作業を止めない。
  }
  try {
    const out = await runHostHook(host, event, payload, process.env)
    process.stdout.write(out.stdout)
    process.stderr.write(out.stderr)
    process.exitCode = out.exitCode
  } catch {
    // hook の内部エラーで作業を止めない。
    process.exitCode = 0
  }
}
