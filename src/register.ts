import type { Engine, HookEvent, HookResult, PluginOptions, Register } from 'claude-code'
import { correctCommand } from './correct.ts'
import { createIo } from './engine-io.ts'
import { feedbackDir } from './feedback-rules.ts'
import * as hooks from './hooks.ts'
import { tr } from './i18n.ts'
import type { Io } from './io.ts'
import { merge, type Outcome } from './outcome.ts'
import { join } from './path.ts'
import type { Dict } from './pyutil.ts'
import { listRunning, runningBand } from './running-registry.ts'

// settings.json の command hook をプラグイン同梱の TypeScript 関数（src/）として載せ替えた mod。
// イベントごとの処理は src/hooks.ts にあり、ここは classic.* のイベントをエンジンの $ から作った Io で
// そこへ渡し、結果（Outcome）を次の hook の結果に重ねて返すだけ。同じ検査を settings hook
// （hooks/hooks.json）が Go 版のバイナリ（internal/hookgate、`feedback-gate claude <Event>`）でも走らせる。

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

// エンジンの $ から、src/hooks.ts に渡す Io とセッション ID を作る（ディレクトリの検査は、$ を渡す先がこのファイルの
// トップレベルの関数であることを求めるので、register の中の閉包にはしない）。
async function engineContext($: Engine, options: PluginOptions): Promise<{ io: Io; sessionId: string }> {
  return { io: await createIo($, options), sessionId: await $.session.id() }
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
    } catch {
      // コマンド API の無いエンジンでもセッション開始は止めない。
    }
    return next(e)
  })

  on('command.run', { command: 'correct' }, async ($, e) => correctCommand(await createIo($, options), String(e.args ?? '')))

  on('classic.SessionStart', async ($, e, next) => {
    await markClassic($, options)
    const { io, sessionId } = await engineContext($, options)
    return withNext(next, e, (await hooks.sessionStart(io, sessionId, e)).outcome)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await markClassic($, options)
    const { io, sessionId } = await engineContext($, options)
    return withNext(next, e, (await hooks.userPromptSubmit(io, sessionId, options)).outcome)
  })

  on('classic.PreToolUse', async ($guard, guardEvent, guardNext) => {
    await markClassic($guard, options)
    const tool = str(guardEvent.tool)
    if (!hooks.guardsTool(options, tool)) return guardNext(guardEvent)
    const { io, sessionId } = await engineContext($guard, options)
    const payload = preToolUsePayload(guardEvent, tool, sessionId, await $guard.session.cwd())
    const mine = (await hooks.preToolUse(io, sessionId, options, payload)).outcome
    // 返す判定は deny / ask だけ（allow は返さず、ユーザーの判断に委ねる）。他の出力（warn）は stderr なので返す値に載らない。
    // ディレクトリの検査が判定の種類を読み取れるよう、返り値は固定のキーで書き、判定しないときはイベントをそのまま次へ渡す。
    // 検査はファイル全体（バンドル）で引数と同じ名前の変数があると next に渡るイベントを確定できないので、引数名はこのフック専用にしている。
    if (mine.deny !== undefined) return { deny: mine.deny }
    if (mine.ask !== undefined) return { ask: mine.ask }
    return guardNext(guardEvent)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    await markClassic($, options)
    const { io, sessionId } = await engineContext($, options)
    return withNext(next, e, (await hooks.postToolUse(io, sessionId, e)).outcome)
  })

  // 確認待ちの通知。マーカーは毎回書き直す（長いセッションで 24h 掃除に消されないように）。
  on('classic.Notification', async ($, e, next) => {
    await markClassic($, options, true)
    const { io, sessionId } = await engineContext($, options)
    await hooks.notification(io, sessionId, e)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await markClassic($, options)
    const { io, sessionId } = await engineContext($, options)
    return withNext(next, e, (await hooks.stop(io, sessionId, e)).outcome)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await markClassic($, options)
    const { io, sessionId } = await engineContext($, options)
    return withNext(next, e, (await hooks.subagentStop(io, sessionId, e)).outcome)
  })

  // gate が実行中のコマンドを、プロンプトの上の帯に複数行で出す。自セッションの実行が終わるか、
  // アンケートが帯を使っている間は、エンジンの帯に譲る。描き直しは gate が $.ui.invalidate で促す。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const io = await createIo($, options)
    return runningBand(await listRunning(io, await $.session.id()), await io.now(), io.lang) ?? next(e)
  })
}
