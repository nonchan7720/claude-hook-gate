// ホスト（Claude Code / Codex）と中核の検査ロジックの境界。
//
// 中核（src/hooks.ts と、そこから呼ぶ src/feedback-*.ts・src/gate.ts など）は、Claude Code の classic コマンド hook が
// stdin で受け取る JSON の形（session_id / cwd / tool_name / tool_input / ...）を入力に、Outcome（deny / ask / block /
// additionalContext ...）と warn の stderr を出力する。ホストごとの違い（イベント名、ツール名と引数の形、返せる判定の
// 種類、出力の JSON の形）はこの Host インターフェースの実装（src/host-claude.ts / src/host-codex.ts）が吸収し、
// 中核には手を入れない。
//
//   stdin の JSON ──host.normalize──▶ CoreCall（中核のイベント + 正規化した payload）──runCore──▶ HookRun（Outcome + stderr）
//                                                                                                 ──host.render──▶ stdout / stderr / exit code
//
// 新しいホストを足すときは、この 3 つ（normalize / render / options）と appName・events を実装し、cliMain(host) を入口にする。
import type { PluginOptions } from 'claude-code'
import type { HookRun } from './hooks.ts'
import * as hooks from './hooks.ts'
import type { Io, ScriptResult } from './io.ts'
import { makeNodeIo } from './node-io.ts'
import type { Outcome } from './outcome.ts'
import { type Dict, isDict } from './pyutil.ts'

/** 中核が扱うイベント（classic コマンド hook のイベント名）。 */
export const CORE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'] as const
export type CoreEvent = (typeof CORE_EVENTS)[number]

/**
 * ホストのイベントを中核の呼び出しに直したもの。payloads は classic の形の payload。
 * PreToolUse / PostToolUse で複数なのは、1 回で複数ファイルを編集するツール（Codex の apply_patch）をファイルごとの
 * Edit / Write に分けたとき。undefined は中核に渡すものが無い（何もしない）。
 */
export type CoreCall = { event: CoreEvent; payloads: Dict[] } | undefined

export interface Host {
  /** 通知の見出しなどに使うアプリ名。 */
  readonly appName: string
  /** このホストの command hook が受けるイベント名（CLI の引数として受け付けるもの）。 */
  readonly events: readonly string[]
  /** 環境変数からプラグイン設定を作る（ホストごとに渡し方が違う）。 */
  options(env: NodeJS.ProcessEnv): PluginOptions
  /** ホストのイベントと stdin の payload を、中核の呼び出しに直す。 */
  normalize(event: string, payload: Dict, io: Io): CoreCall
  /** 中核の結果（Outcome と warn の stderr）を、ホストの command hook の出力（exit code / stdout / stderr）にする。 */
  render(event: string, outcome: Outcome, stderr: string, io: Io): ScriptResult
}

const none: HookRun = { outcome: {}, stderr: '' }

/** 中核の呼び出し。複数 payload の PreToolUse / PostToolUse は、複数ファイル編集向けの入口（src/hooks.ts）に渡す。 */
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

/** 1 イベント分: Io を作り、normalize → runCore → render。 */
export async function runHostHook(host: Host, event: string, payload: Dict, env: NodeJS.ProcessEnv): Promise<ScriptResult> {
  const options = host.options(env)
  const io = makeNodeIo({ env, payloadCwd: str(payload.cwd), language: str(options.language), autoCount: options.autoCount !== false, appName: host.appName })
  const sessionId = str(payload.session_id) || 'unknown'
  const { outcome, stderr } = await runCore(io, host.normalize(event, payload, io), sessionId, options)
  return host.render(event, outcome, stderr, io)
}

/** command hook の入口: `node cli.js <Event>`。stdin の JSON を読み、結果を stdout / stderr / 終了コードで返す。 */
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
    // 壊れた JSON は空として扱う（hook の内部エラーで作業を止めない）。
  }
  try {
    const out = await runHostHook(host, event, payload, process.env)
    process.stdout.write(out.stdout)
    process.stderr.write(out.stderr)
    process.exitCode = out.exitCode
  } catch {
    process.exitCode = 0
  }
}
