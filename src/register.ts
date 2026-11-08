import type { Engine, HookEvent, HookResult, PluginOptions, Register } from 'claude-code'
import { correctCommand } from './correct.ts'
import { createIo } from './engine-io.ts'
import { feedbackDir } from './feedback-rules.ts'
import { runGo } from './go-bridge.ts'
import { hookListCommand } from './hook-list.ts'
import { tr } from './i18n.ts'
import { merge, type Outcome } from './outcome.ts'
import { join } from './path.ts'
import type { Dict } from './pyutil.ts'
import { listRunning, runningBand } from './running-registry.ts'

// mod。classic.* のイベントの判定は Go 版のバイナリ（internal/hookgate、`feedback-gate claude <Event>`）に任せ
// （src/go-bridge.ts が scripts/hook.sh 経由で起動する）、その結果（Outcome）を次の hook の結果に重ねて返すだけ。
// settings hook（hooks/hooks.json）も同じバイナリを呼ぶので、判定の実装は Go の 1 つだけ。
// TypeScript に残るのは、Go を呼ぶ部分と、/correct（src/correct.ts）と、/hook-list（src/hook-list.ts。これも Go を呼ぶ）と、
// プロンプト上の実行中の帯（ui.render）だけ。

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// 次の hook の結果へ自分の結果を重ねる。decided 済みの Outcome は先のものが勝つ。
async function withNext(next: (e: HookEvent) => Promise<HookResult>, e: HookEvent, mine: Outcome): Promise<HookResult> {
  const rest = (await next(e)) as Outcome
  return merge(mine, rest) as HookResult
}

// classic.* の hook の先頭で呼ぶ。セッション別のマーカー <feedbackDir>/.classic_seen/<session> を書く。組織管理のガード
// （cc-plugin-sec-default）が classic.* をユーザーの mod に対して飛ばす環境ではこれが書かれず、hooks/hooks.json の
// settings hook（scripts/hook.sh → feedback-gate バイナリ。scripts/install-binary.sh が取得する）が同じ処理を代わりに走らせる。こちらが走る環境では、あちらがマーカーを
// 見て黙る。無ければ書き、refresh（classic.Notification）では毎回書き直す（reset-gate の 24h 掃除に消されないように）。
async function markClassic($: Engine, options: PluginOptions, refresh = false): Promise<void> {
  try {
    const sessionId = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '')
    if (sessionId === '') return
    const io = await createIo($, options)
    const marker = join(feedbackDir(io), '.classic_seen', sessionId)
    if (refresh || !(await io.exists(marker))) await io.writeFile(marker, '1\n')
  } catch {
    // マーカーを書けなくても作業は止めない（settings hook が二重に動きうるだけ）。
  }
}

// classic.PreToolUse のイベントを、classic コマンド hook が stdin で受け取っていた JSON の形に組み立てる。
// ディレクトリの検査はフックの中でイベントを分割代入すると読めない（判定をユーザーに残していると確かめられない）ので、
// イベントはこの関数に丸ごと渡し、分割はここで行う。
function preToolUsePayload(event: Dict, tool: string, sessionId: string, cwd: string): Dict {
  const { tool: _tool, tool_use_id, agentId, ...toolInput } = event
  const payload: Dict = {
    session_id: sessionId,
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id,
  }
  // エンジンは classic.PreToolUse のイベントにエージェント ID を入れない（tool.call の入力から agentId を落として
  // tool / tool_use_id を足した形）。入っていたときだけ揃えておく。bash_started は tool_use_id で引くので、
  // サブエージェントの中でもここに agent_id が無いことは問題にならない（src/bash-changes.ts）。
  if (typeof agentId === 'string' && agentId !== '') payload.agent_id = agentId
  return payload
}

/** PreToolUse で Go に渡すツール（settings hook の matcher と同じ）。Agent / SendMessage は agentLaunchGuard が有効なときだけ。 */
const guardsTool = (options: PluginOptions, tool: string): boolean =>
  (options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool)) || /^(Bash|Edit|Write|MultiEdit)$/.test(tool)

/** PostToolUse で Go に渡すツール（settings hook の matcher と同じ）。 */
const POST_TOOLS = /^(Read|Bash|Edit|Write|MultiEdit|Agent|Task)$/

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
      await $.command.register({ name: 'hook-list', description: tr(io.lang)('hookList.description'), argumentHint: '[--no-open]' })
    } catch {
      // コマンド API の無いエンジンでもセッション開始は止めない。
    }
    return next(e)
  })

  on('command.run', { command: 'correct' }, async ($, e) => correctCommand(await createIo($, options), String(e.args ?? '')))

  // /hook-list: gate.yaml と feedback ルールが、いつ・何を動かすかをブラウザで一覧にする（Go のバイナリを scripts/hook-list.sh で呼ぶだけ）。
  on('command.run', { command: 'hook-list' }, async ($, e) => hookListCommand(await createIo($, options), String(e.args ?? ''), options))

  on('classic.SessionStart', async ($, e, next) => {
    await markClassic($, options)
    return withNext(next, e, await runGo($, options, 'SessionStart', e))
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await markClassic($, options)
    return withNext(next, e, await runGo($, options, 'UserPromptSubmit', e))
  })

  on('classic.PreToolUse', async ($guard, guardEvent, guardNext) => {
    await markClassic($guard, options)
    const tool = str(guardEvent.tool)
    if (!guardsTool(options, tool)) return guardNext(guardEvent)
    const payload = preToolUsePayload(guardEvent, tool, await $guard.session.id(), await $guard.session.cwd())
    const mine = await runGo($guard, options, 'PreToolUse', payload)
    // 返す判定は deny / ask だけ（allow は返さず、ユーザーの判断に委ねる）。
    // ディレクトリの検査が判定の種類を読み取れるよう、返り値は固定のキーで書き、判定しないときはイベントをそのまま次へ渡す。
    // 検査はファイル全体（バンドル）で引数と同じ名前の変数があると next に渡るイベントを確定できないので、引数名はこのフック専用にしている。
    if (mine.deny !== undefined) return { deny: mine.deny }
    if (mine.ask !== undefined) return { ask: mine.ask }
    return guardNext(guardEvent)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    await markClassic($, options)
    // settings hook の matcher（hooks/hooks.json）と同じツールだけ Go に渡す（他のツールでプロセスを起動しない）。
    if (!POST_TOOLS.test(str(e.tool_name))) return next(e)
    return withNext(next, e, await runGo($, options, 'PostToolUse', e))
  })

  // 確認待ちの通知。マーカーは毎回書き直す（長いセッションで 24h 掃除に消されないように）。
  on('classic.Notification', async ($, e, next) => {
    await markClassic($, options, true)
    await runGo($, options, 'Notification', e)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await markClassic($, options)
    return withNext(next, e, await runGo($, options, 'Stop', e))
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await markClassic($, options)
    return withNext(next, e, await runGo($, options, 'SubagentStop', e))
  })

  // gate が実行中のコマンドを、プロンプトの上の帯に複数行で出す。自セッションの実行が終わるか、
  // アンケートが帯を使っている間は、エンジンの帯に譲る。描き直しは Go が画面の更新の行（redraw）で促す。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const io = await createIo($, options)
    return runningBand(await listRunning(io, await $.session.id()), await io.now(), io.lang) ?? next(e)
  })
}
