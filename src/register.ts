import type { Engine, HookEvent, HookResult, PluginOptions, Register } from 'claude-code'
import { agentLaunchGuard } from './agent-launch-guard.ts'
import { allStop } from './all-stop.ts'
import { bashChangeSteps, bashStarted } from './bash-changes.ts'
import { correctCommand } from './correct.ts'
import { createIo } from './engine-io.ts'
import { feedbackGuard } from './feedback-guard.ts'
import { feedbackInject } from './feedback-inject.ts'
import { feedbackPostEdit } from './feedback-post-edit.ts'
import { feedbackDir } from './feedback-rules.ts'
import { feedbackStopCheck } from './feedback-stop-check.ts'
import { tr } from './i18n.ts'
import type { Io, ScriptResult } from './io.ts'
import { notification } from './notification.ts'
import { merge, type Outcome, toOutcome } from './outcome.ts'
import { join } from './path.ts'
import { type Dict, isDict } from './pyutil.ts'
import { recordChanges } from './record-changes.ts'
import { resetGate } from './reset-gate.ts'
import { loadRules } from './rules-file.ts'
import { listRunning, loadSummary, runningBand } from './running-registry.ts'
import { stopTestGate } from './stop-test-gate.ts'
import { saveSubagentReport, subagentReport } from './subagent-report.ts'

// settings.json の command hook をプラグイン同梱の TypeScript 関数（src/）として載せ替えた mod。
// 各関数は classic コマンド hook のスクリプトと同じ { exitCode, stdout, stderr } を返し、
// それを classic の規約どおりに戻り値（Outcome）へ変換する。
//
// 同じ処理を、classic.* の代わりにネイティブイベントにも登録している（session.start / session.end / prompt.submit /
// tool.call / tool.check / turn.complete）。Team / Enterprise ログインや managed settings のあるマシンでは組織管理の
// ガード（sec-default@builtin）が最初に走り、classic.* で next.to(e, 'append') して、ユーザーがインストールした mod を
// 全部飛ばす。そこでは classic 側の hook が一つも走らないので、ネイティブ側が担う。classic が走る環境では二重に動かさない:
// classic.* のどれかが走ったら「classic が走った」印（classicSeen）を立て、ネイティブ側は印があれば next(e) で素通りする。
//   - 印は $.state（mod のリロードをまたいで保持される。types/index.d.ts の PluginState、manifest の types）に置き、同じ register の
//     中ではメモリ上の印（Memory）も見る。$.state が読み書きできない環境でもメモリ側で動く（リロードで消えるだけ）。
//   - 印はセッション ID ごとのマーカーファイル（<feedbackDir>/.classic_seen/<session>）にも書く。settings hook の
//     scripts/notification.sh は mod の外で動くので、これを見て classic.Notification と二重に通知しないようにする。

type Step = (io: Io) => Promise<ScriptResult>

/** 評価中表示（progress）を出し始めるまでの待ち時間。これより早く終わる評価では何も出さない。 */
const PROGRESS_DELAY_MS = 3000

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

async function runSteps($: Engine, options: PluginOptions, event: string, steps: Step[]): Promise<Outcome> {
  let acc: Outcome = {}
  const base = await createIo($, options)
  const sessionId = await $.session.id()
  // 処理中の 1 行（progress）を出した hook だけ、終わりに片付ける（毎回のちらつきを避ける）。gate の結果（result）は
  // 次のコマンドが走り始めるまで残すので、消さずに完了サマリへ戻す。
  // ただし最初の progress から PROGRESS_DELAY_MS 経っても終わっていないときだけ出す（すぐ終わる評価でステータス行を触らない）。
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
      if (ran) acc = merge(acc, toOutcome(event, ran))
    }
  } finally {
    cancelDelay?.()
    // 出していたなら、残っている gate の完了サマリがあればそれに戻し、無ければ消す。
    if (shown) base.progress?.(await loadSummary(base, sessionId))
  }
  return acc
}

// 次の hook の結果へ自分の結果を重ねる。decided 済みの Outcome は先のものが勝つ。
async function withNext(next: (e: HookEvent) => Promise<HookResult>, e: HookEvent, mine: Outcome): Promise<HookResult> {
  const rest = (await next(e)) as Outcome
  return merge(mine, rest) as HookResult
}

// classic.PreToolUse のイベントを、classic コマンド hook が stdin で受け取っていた JSON の形に組み立てる。
// ディレクトリの検査はフックの中でイベントを分割代入すると読めない（判定をユーザーに残していると確かめられない）ので、
// イベントはこの関数に丸ごと渡し、分割はここで行う。ネイティブの tool.call の入力も同じ形なので、後処理の payload の元にも使う。
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

// ---- classic.* が走ったかの検出 ----

// $.state の参照。plugin / key は文字列リテラルで書く必要がある（claude plugin validate が読む。types/index.d.ts の PluginState と対応）。
const CLASSIC_SEEN = { plugin: 'feedback-gate', key: 'classicSeen' } as const

/**
 * register の呼び出しごとに作る、この mod のメモリ上の状態（モジュール変数ではなく register の中に置くので、mod のリロードで
 * register が再実行されると消える。$.state はリロードをまたいで残る）。
 *   classicSeen: $.state の印のメモリ側。ネイティブの hook の中から、その next(e) の先で classic.* が立てた印を読むときに、
 *     $.state の読み出しが古い値を返すことがあった（エンジン上のテストで確認）ので、同じ register の中ではこちらを先に見る。
 *     $.state が使えないエンジンでも、これで動く。
 *   stopContinued: Stop を block して投げ直した直後か（turnComplete を参照）。
 */
type Memory = { classicSeen: boolean; stopContinued: boolean }

/**
 * classic.* の hook がこのセッションで一度でも走ったか。走っていれば、ネイティブ側は何もしない。
 * $.state の値は印を立てたセッションの ID。$.state がセッションをまたいで残る場合に、前のセッションの印で今のセッションの
 * ネイティブ側を黙らせないよう、今のセッション ID と同じときだけ印とみなす。
 */
async function classicSeen($: Engine, memory: Memory): Promise<boolean> {
  if (memory.classicSeen) return true
  try {
    const seen = (await $.state.get(CLASSIC_SEEN)).value
    memory.classicSeen = typeof seen === 'string' && seen !== '' && seen === (await $.session.id())
  } catch {
    // $.state が読めなければ、印は立っていないものとして扱う。
  }
  return memory.classicSeen
}

/**
 * classic.* の hook の先頭で呼ぶ。印を立て、セッション別のマーカー（<feedbackDir>/.classic_seen/<session>）を書く。
 * マーカーは mod の外の settings hook（scripts/notification.sh）が見る。refresh は、長いセッションで reset-gate の 24h 掃除に
 * 消されないよう、classic.Notification のたびに書き直すため。
 */
async function markClassic($: Engine, options: PluginOptions, memory: Memory, refresh = false): Promise<void> {
  if (!(await classicSeen($, memory))) {
    memory.classicSeen = true
    try {
      await $.state.set(CLASSIC_SEEN, await $.session.id())
    } catch {
      // $.state の無いエンジンではモジュール変数だけで続ける。
    }
  }
  try {
    const sessionId = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '')
    if (sessionId === '') return
    const io = await createIo($, options)
    const marker = join(feedbackDir(io), '.classic_seen', sessionId)
    if (refresh || !(await io.exists(marker))) await io.writeFile(marker, '1\n')
  } catch {
    // マーカーを書けなくても作業は止めない（通知が二重に出うるだけ）。
  }
}

// ---- classic とネイティブで共有する、hook ごとの処理の組み立て ----

/** Bash / Edit / Write / MultiEdit（と、agentLaunchGuard が有効なら Agent / SendMessage）は PreToolUse の判定の対象。 */
const guardsTool = (options: PluginOptions, tool: string): boolean =>
  (options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool)) || /^(Bash|Edit|Write|MultiEdit)$/.test(tool)

/**
 * PreToolUse の判定の各段。settings では `|| true` 付きなので、deny 以外（exit 2 以外）は無視していた。
 * trackStart: Bash は、開始時刻を控えてから guard を評価する（終了後の変更ファイル追跡用）。ネイティブ側は tool.call で
 * 開始時刻を控え、判定は tool.check で行うので、そこでは false を渡す。
 */
function preGuardSteps(options: PluginOptions, tool: string, payload: Dict, trackStart: boolean): Step[] {
  const guardsAgents = options.agentLaunchGuard === true && /^(Agent|SendMessage)$/.test(tool)
  const step: Step = guardsAgents ? async (io) => agentLaunchGuard(payload, io.lang) : (io) => feedbackGuard(io, payload)
  return trackStart && tool === 'Bash' ? [(io) => bashStarted(io, payload), step] : [step]
}

/** PostToolUse の各段。対象外のツールは undefined。payload は classic.PostToolUse の stdin JSON の形。 */
function postToolSteps(tool: string, payload: Dict): Step[] | undefined {
  // 終わったサブエージェントの SubagentStop で走った hook の結果を、呼び出し元の context へ渡す（gate のログを読ませない）。
  if (/^(Agent|Task)$/.test(tool)) return [(io) => subagentReport(io, payload)]
  // Bash が実際に書き換えたファイルを拾い、Edit / Write と同じく feedback の post_edit（と、実行後に判定できる
  // pre_edit）で検査してから、メモに記録できたときだけ rules フェーズを走らせる。gate.yaml が無くても feedback の検査は動く。
  if (tool === 'Bash') return bashChangeSteps(payload)
  if (!/^(Write|Edit|MultiEdit)$/.test(tool)) return undefined
  // gate の実行より先に、軽い feedback の post_edit 検査を済ませる。
  return [(io) => recordChanges(io, payload), (io) => feedbackPostEdit(io, payload), (io) => stopTestGate(io, 'rules', payload)]
}

/** SubagentStop の各段。結果は呼び出し元の PostToolUse(Agent) へ渡すために控える（src/subagent-report.ts）。 */
function subagentStopSteps(payload: Dict): Step[] {
  let gate: ScriptResult | undefined
  let feedback: ScriptResult | undefined
  return [
    async (io) => (gate = await stopTestGate(io, 'checks', payload)),
    async (io) => (feedback = await feedbackStopCheck(io, payload)),
    (io) => saveSubagentReport(io, payload, gate, feedback),
  ]
}

/** UserPromptSubmit が Claude の context に足すもの: rules ファイルと、確定した feedback ルール。 */
async function promptOutcome($: Engine, options: PluginOptions): Promise<Outcome> {
  const mine: Outcome = {}
  const text = await createIo($, options).then((io) => loadRules(io, options.rulesFile))
  if (text !== '') mine.additionalContext = [text]
  const inject = await runSteps($, options, 'UserPromptSubmit', [(io) => feedbackInject(io)])
  return merge(mine, inject)
}

// ---- ネイティブイベント側の処理 ----

/** 発言の 1 行目だけ（表示用）。 */
const firstLine = (text: string): string => (text.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 200)

/**
 * classic の PostToolUse では block の理由や additionalContext が Claude に届いていた。tool.call の後にはそれを返す口が無いので、
 * 会話に user 行として足す（$.session.append）。足せないエンジンでは、利用者にだけ toast で知らせる。
 */
async function tellClaude($: Engine, outcome: Outcome): Promise<void> {
  const notes = [...(outcome.block ? [outcome.block] : []), ...(outcome.additionalContext ?? [])].filter((n) => n.trim() !== '')
  if (notes.length === 0) return
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: notes.join('\n\n') }] } })
  } catch {
    try {
      $.ui.toast(firstLine(notes[0] ?? ''))
    } catch {
      // 知らせる手段が無ければ黙る。
    }
  }
}

// tool.call の入力は classic.PreToolUse と同じ形（preToolUsePayload が分ける）。判定は tool.check の e.input から同じ形に組む。
async function checkOutcome($: Engine, options: PluginOptions, event: HookEvent): Promise<Outcome> {
  const tool = str(event.tool)
  if (!guardsTool(options, tool)) return {}
  const input = isDict(event.input) ? event.input : {}
  const payload = preToolUsePayload({ ...input, tool, agentId: event.agentId }, tool, await $.session.id(), await $.session.cwd())
  return runSteps($, options, 'PreToolUse', preGuardSteps(options, tool, payload, false))
}

/** tool.call の前: Bash の開始時刻を控える（終了後の変更ファイル追跡用。classic.PreToolUse の bashStarted と同じ）。 */
async function toolCallStarted($: Engine, options: PluginOptions, event: HookEvent): Promise<void> {
  try {
    const payload = preToolUsePayload(event, 'Bash', await $.session.id(), await $.session.cwd())
    await runSteps($, options, 'PreToolUse', [(io) => bashStarted(io, payload)])
  } catch {
    // 追跡の失敗で作業を止めない。
  }
}

/**
 * tool.call の後: classic.PostToolUse 相当の処理を、tool.call の入力と結果から組んだ payload で走らせる。
 * 拒否された・失敗した呼び出しは、classic でも PostToolUse が来ない（失敗は PostToolUseFailure）ので何もしない。
 */
async function toolCallDone($: Engine, options: PluginOptions, event: HookEvent, ran: HookResult): Promise<void> {
  try {
    if (ran.deny !== undefined || ran.isError === true) return
    const tool = str(event.tool)
    const base = preToolUsePayload(event, tool, await $.session.id(), await $.session.cwd())
    // tool_response の形は classic と完全には同じと限らない。サブエージェントの結果は agentId を持つレコードを期待する。
    const result = ran.result
    const payload: Dict = { ...base, hook_event_name: 'PostToolUse', tool_response: isDict(result) ? result : { result } }
    const steps = postToolSteps(tool, payload)
    if (steps) await tellClaude($, await runSteps($, options, 'PostToolUse', steps))
  } catch {
    // 後処理の失敗でツールの結果を壊さない。
  }
}

// Stop を block した後、gate の試行回数の数え方（stop_hook_active）を classic に合わせるための印。
// turn.complete は止めずに続けさせる手段を持たないので、block は $.prompt.submit で投げ直す。その続きの turn.complete が
// classic でいう「stop_hook_active な Stop」に当たる。リロードで消えても、試行回数の数え直しになるだけ。

/** classic.Stop が block で止めていたときの代わり: 理由を Claude へのプロンプトとして投げ直す。 */
function continueWork($: Engine, reason: string): void {
  const fallback = () => {
    try {
      $.ui.toast(firstLine(reason))
    } catch {
      // 知らせる手段が無ければ黙る。
    }
  }
  try {
    // 待たない: 投げ直した先のターンの終わりまで待つと、この hook の制限時間を超えうる。
    $.prompt.submit({ text: reason }).catch(fallback)
  } catch {
    fallback()
  }
}

/** turn.complete: classic.Stop（メインのターン）/ classic.SubagentStop（サブエージェントのターン）相当。回答の下に出す 1 行を返す。 */
async function turnComplete($: Engine, options: PluginOptions, event: HookEvent, memory: Memory): Promise<string | undefined> {
  const agentId = str(event.agentId)
  const base: Dict = { session_id: await $.session.id(), cwd: await $.session.cwd(), last_assistant_message: str(event.answer) }
  if (agentId !== '') {
    // サブエージェントのターンは、投げ直して続けさせることができない（$.prompt.submit は会話本体へ送られる）。結果は呼び出し元の
    // PostToolUse(Agent) へ渡すために控えられる（saveSubagentReport）ので、ここでは block の理由を見せるだけにする。
    const agentType = str(event.agentType)
    const payload: Dict = { ...base, hook_event_name: 'SubagentStop', agent_id: agentId, ...(agentType !== '' ? { agent_type: agentType } : {}) }
    const mine = await runSteps($, options, 'SubagentStop', subagentStopSteps(payload))
    return mine.block === undefined ? undefined : tr((await createIo($, options)).lang)('nativeStop.subagentBlocked', { reason: firstLine(mine.block) })
  }
  const active = memory.stopContinued
  memory.stopContinued = false
  const payload: Dict = { ...base, hook_event_name: 'Stop', stop_hook_active: active }
  const mine = await runSteps($, options, 'Stop', [(io) => allStop(io, payload)])
  if (mine.block === undefined) return undefined
  memory.stopContinued = true
  continueWork($, mine.block)
  return tr((await createIo($, options)).lang)('nativeStop.continued')
}

export const register: Register = (on, options) => {
  const memory: Memory = { classicSeen: false, stopContinued: false }

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
    // classic.SessionStart 相当（classic が走らない環境だけ）。session.start には source が無い（mod のリロードでも再発火する）
    // ので、start / clear の削除はせず、24h 超の古い状態の掃除だけを行う。clear の削除は session.end で行う。
    if (!(await classicSeen($, memory))) {
      const payload: Dict = { session_id: await $.session.id(), cwd: str(e.cwd) }
      await runSteps($, options, 'SessionStart', [(io) => resetGate(io, payload)])
    }
    return next(e)
  })

  // classic.SessionStart の source: 'clear' 相当。/clear で捨てる会話の状態を消す（resume / branch は reason が resume なので残す）。
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && !(await classicSeen($, memory))) {
      const payload: Dict = { session_id: await $.session.id(), source: 'clear' }
      await runSteps($, options, 'SessionStart', [(io) => resetGate(io, payload)])
    }
    return next(e)
  })

  on('command.run', { command: 'correct' }, async ($, e) => correctCommand(await createIo($, options), String(e.args ?? '')))

  on('classic.SessionStart', async ($, e, next) => {
    await markClassic($, options, memory)
    const mine = await runSteps($, options, 'SessionStart', [(io) => resetGate(io, e)])
    return withNext(next, e, mine)
  })

  // classic.UserPromptSubmit 相当。additionalContext の代わりに context に足す（Claude だけが読む）。
  on('prompt.submit', async ($, e, next) => {
    if (await classicSeen($, memory)) return next(e)
    const mine = await promptOutcome($, options)
    if (mine.block !== undefined) return { drop: mine.block }
    const added = mine.additionalContext ?? []
    if (added.length === 0) return next(e)
    return next({ ...e, context: [...(Array.isArray(e.context) ? e.context : []), ...added] })
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await markClassic($, options, memory)
    return withNext(next, e, await promptOutcome($, options))
  })

  on('classic.PreToolUse', async ($guard, guardEvent, guardNext) => {
    await markClassic($guard, options, memory)
    const tool = str(guardEvent.tool)
    if (!guardsTool(options, tool)) return guardNext(guardEvent)
    const payload = preToolUsePayload(guardEvent, tool, await $guard.session.id(), await $guard.session.cwd())
    const mine = await runSteps($guard, options, 'PreToolUse', preGuardSteps(options, tool, payload, true))
    // 返す判定は deny / ask だけ（allow は返さず、ユーザーの判断に委ねる）。他の出力（warn）は stderr なので返す値に載らない。
    // ディレクトリの検査が判定の種類を読み取れるよう、返り値は固定のキーで書き、判定しないときはイベントをそのまま次へ渡す。
    // 検査はファイル全体（バンドル）で引数と同じ名前の変数があると next に渡るイベントを確定できないので、引数名はこのフック専用にしている。
    if (mine.deny !== undefined) return { deny: mine.deny }
    if (mine.ask !== undefined) return { ask: mine.ask }
    return guardNext(guardEvent)
  })

  // classic.PreToolUse の判定（deny / ask）のネイティブ版。tool.check は tool.call と PreToolUse hook の後に発火し、next(e) が
  // ルール・権限モード・hook の決定に解決する。tool.call は ask を返せないので、deny も ask もここでまとめて返す。
  // classic.PreToolUse はこの前に走るので、classic が動く環境では最初の呼び出しからここは素通りになる。
  // 引数名は classic.PreToolUse と同じ理由でこのフック専用。判定しないときは、イベントをそのまま次へ渡す。
  on('tool.check', async ($check, checkEvent, checkNext) => {
    if (await classicSeen($check, memory)) return checkNext(checkEvent)
    const mine = await checkOutcome($check, options, checkEvent)
    if (mine.deny !== undefined) return { decision: 'deny', reason: mine.deny }
    const decided = await checkNext(checkEvent)
    // 厳しくする方向だけ: すでに deny ならそのまま、allow / ask なら ask にする。
    if (mine.ask !== undefined && decided.decision !== 'deny') return { decision: 'ask', reason: mine.ask }
    return decided
  })

  // classic.PreToolUse の bashStarted / classic.PostToolUse のネイティブ版。next(e) の先で classic.PreToolUse / PostToolUse が
  // 発火する（settings hook はチェーンの最後）ので、classic が動く環境では、next の後に印を見て後処理を飛ばす。
  // 呼び出しごとの記録がなくても、最初の呼び出しの後処理が二重に走ることはない。
  on('tool.call', async ($call, callEvent, callNext) => {
    if (await classicSeen($call, memory)) return callNext(callEvent)
    if (str(callEvent.tool) === 'Bash') await toolCallStarted($call, options, callEvent)
    const ran = await callNext(callEvent)
    if (await classicSeen($call, memory)) return ran
    await toolCallDone($call, options, callEvent, ran)
    return ran
  })

  on('classic.PostToolUse', async ($, e, next) => {
    await markClassic($, options, memory)
    const steps = postToolSteps(str(e.tool_name), e)
    if (!steps) return next(e)
    return withNext(next, e, await runSteps($, options, 'PostToolUse', steps))
  })

  // 確認待ちの通知。ネイティブのイベントは無いので、classic が走らない環境では hooks.json の settings hook
  // （scripts/notification.sh）が代わりに通知する。両方走る環境では、あちらが markClassic のマーカーを見て黙る。
  on('classic.Notification', async ($, e, next) => {
    await markClassic($, options, memory, true)
    await runSteps($, options, 'Notification', [(io) => notification(io, 'notify', e)])
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await markClassic($, options, memory)
    const mine = await runSteps($, options, 'Stop', [(io) => allStop(io, e)])
    return withNext(next, e, mine)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await markClassic($, options, memory)
    const mine = await runSteps($, options, 'SubagentStop', subagentStopSteps(e))
    return withNext(next, e, mine)
  })

  // classic.Stop / classic.SubagentStop 相当。Stop は block で続けさせられたが、turn.complete は block できないので、
  // メインのターンの block は投げ直し（continueWork）、サブエージェントのターンは理由を 1 行見せるだけになる。
  on('turn.complete', async ($, e, next) => {
    if (e.isAborted === true || (await classicSeen($, memory))) return next(e)
    const text = await turnComplete($, options, e, memory)
    return text === undefined ? next(e) : { text }
  })

  // gate が実行中のコマンドを、プロンプトの上の帯に複数行で出す。自セッションの実行が終わるか、
  // アンケートが帯を使っている間は、エンジンの帯に譲る。描き直しは gate が $.ui.invalidate で促す。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const io = await createIo($, options)
    return runningBand(await listRunning(io, await $.session.id()), await io.now(), io.lang) ?? next(e)
  })
}
