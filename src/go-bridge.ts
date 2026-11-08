// mod の classic.* の hook から、判定を Go 版のバイナリ（feedback-gate claude <Event>）に任せる。
//
// scripts/hook.sh（バイナリの取得とキャッシュ。scripts/install-binary.sh）を $.process.spawn で起動し、classic コマンド hook と
// 同じ JSON を stdin で渡して、stdout の JSON（OutcomeToClassic）を Outcome に戻す。settings hook（hooks/hooks.json）と
// 同じバイナリ・同じ判定なので、mod と settings hook で結果は変わらない。
//
// - 処理中の表示: FEEDBACK_GATE_EVENTS=stderr を付けると、Go は Progress / Result / Redraw を EVENT_LINE_PREFIX 付きの
//   1 行の JSON で stderr に逐次流す。届いたものから $.ui.status / $.ui.invalidate に渡す（tee）。
// - 中断（ESC）: エンジンが hook を中断すると、spawn したプロセスの木に SIGTERM を送り、猶予のあと強制終了する。Go は
//   SIGTERM を受けると走っている子のプロセスグループを SIGKILL してから終わる（internal/hookgate/osio_unix.go）。
// - バイナリが使えない（取得失敗など）、起動できない、中断されたときは何も返さない（作業を止めない）。
import type { Engine, PluginOptions, ProcessSpawnChunk } from 'claude-code'
import { type Outcome, toOutcome } from './outcome.ts'
import { join } from './path.ts'
import { type Dict, isDict } from './pyutil.ts'

/** Go が画面の更新を流す行の先頭（internal/hookgate/osio.go の EventLinePrefix）。 */
export const EVENT_LINE_PREFIX = '@@feedback-gate '

/** 画面の更新を受け取る先（エンジンの $.ui）。 */
export type Screen = { status(text: string | undefined): void; redraw(): void }

/** プラグイン設定を Go が読む環境変数（CLAUDE_PLUGIN_OPTION_<key>。internal/hookgate/host_claude.go）にする。 */
export function optionEnv(options: PluginOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') env[`CLAUDE_PLUGIN_OPTION_${key}`] = String(value)
  }
  return env
}

/** stderr の 1 行が画面の更新なら画面に渡して true。 */
function applyEventLine(line: string, screen: Screen): boolean {
  if (!line.startsWith(EVENT_LINE_PREFIX)) return false
  try {
    const ev: unknown = JSON.parse(line.slice(EVENT_LINE_PREFIX.length))
    if (isDict(ev)) {
      for (const key of ['progress', 'result'] as const) {
        if (typeof ev[key] === 'string') screen.status(ev[key] === '' ? undefined : ev[key])
      }
      if (ev.redraw === true) screen.redraw()
    }
  } catch {
    // 壊れた行は無視する
  }
  return true
}

/**
 * spawn の出力を読み、stdout と（画面の更新の行を除いた）stderr を返す。stderr の画面の更新は届いた行から screen に渡す。
 * 行の途中で塊が切れても、改行が来るまで持ち越す。
 */
export async function collect(chunks: AsyncIterable<ProcessSpawnChunk>, screen: Screen): Promise<{ stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  let partial = ''
  for await (const chunk of chunks) {
    if (chunk.stream === 'stdout') {
      stdout += chunk.text
      continue
    }
    const lines = (partial + chunk.text).split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) if (!applyEventLine(line, screen)) stderr += `${line}\n`
  }
  if (partial !== '' && !applyEventLine(partial, screen)) stderr += partial
  return { stdout, stderr }
}

/** classic の payload に、Go が読む session_id / cwd / hook_event_name を（無ければ）補う。 */
export function classicPayload(event: string, payload: Dict, sessionId: string, cwd: string): Dict {
  return { session_id: sessionId, cwd, hook_event_name: event, ...payload }
}

/** Go 版で 1 イベントを処理し、その Outcome を返す。 */
export async function runGo($: Engine, options: PluginOptions, event: string, payload: Dict): Promise<Outcome> {
  try {
    const [sessionId, root, cwd] = await Promise.all([$.session.id(), $.session.root(), $.session.cwd()])
    const screen: Screen = { status: (text) => $.ui.status(text), redraw: () => $.ui.invalidate('ui.render') }
    const chunks = $.process.spawn({
      argv: ['bash', join($.plugin.root, 'scripts', 'hook.sh'), event],
      cwd,
      env: {
        ...optionEnv(options),
        CLAUDE_PLUGIN_ROOT: $.plugin.root,
        CLAUDE_PROJECT_DIR: root,
        FEEDBACK_GATE_FROM_MOD: '1',
        FEEDBACK_GATE_EVENTS: 'stderr',
      },
      input: JSON.stringify(classicPayload(event, payload, sessionId, cwd)),
    })
    // hook.sh と Go は、判定を exit 0 + stdout の JSON で返す（内部エラーやバイナリが無いときも exit 0）。
    const { stdout, stderr } = await collect(chunks, screen)
    return toOutcome(event, { exitCode: 0, stdout, stderr })
  } catch {
    // 起動できない・中断された（ESC）ときは何も返さない。
    return {}
  }
}
