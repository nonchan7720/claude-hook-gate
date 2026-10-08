// 自セッション（メインとそのサブエージェント）の「実行中のコマンド」一覧。ステータス行（$.ui.status）は
// 1 行しか描けないので、実行中はプロンプトの上の帯（ui.render の AbovePrompt）に複数行で出す。各 Gate は
// 自分の一覧を .gate-status/running/<owner>.json に公開し、帯は同じセッションの分をまとめて描く。
// 同じプロジェクトを開いた別セッションの分は混ぜない。hook がどのプロセスで動くかに依存しないよう、
// 共有はファイルで行う。
import type { RenderElement } from 'claude-code'
import type { Io } from './io.ts'
import { join } from './path.ts'
import { isDict } from './pyutil.ts'

export type RunningEntry = {
  name?: string
  /** コマンド（複数行でもよい。表示時に 1 行へ畳む）。 */
  cmd: string
  started: number
  result?: 'ok' | 'fail'
  /** 完了時刻。完了項目の所要時間をここで固定する。 */
  ended?: number
  /** 同じ実行を別のエージェントが走らせていて、その完了を待っている。 */
  waiting?: boolean
}

const MAX_RUN_MS = 600_000 // コマンド 1 本の最大実行時間（gate.ts の MAX_TIMEOUT_MS と同じ）
const STALE_MS = MAX_RUN_MS + 60_000 // これより古い開始時刻だけの一覧は、落ちたプロセスの残骸とみなす

/** 状態ファイルとログの置き場所（gate.yaml は動かさない）。 */
export const gateStatusDir = (io: Io): string => join(io.projectDir || io.cwd, '.claude', '.gate-status')

const runningDir = (io: Io): string => join(gateStatusDir(io), 'running')
const ownerFile = (io: Io, owner: string): string => join(runningDir(io), `${owner}.json`)

/** この owner の実行中一覧を丸ごと書き換える。 */
export const publishRunning = (io: Io, owner: string, entries: readonly RunningEntry[]): Promise<void> =>
  io.writeFile(ownerFile(io, owner), JSON.stringify(entries))

export const withdrawRunning = (io: Io, owner: string): Promise<void> => io.removeFiles([ownerFile(io, owner)])

/** 各 owner のファイルの中身から、渡された全 owner の一覧を開始時刻順（owner 内の順序は保つ）に並べて返す。古すぎる owner と壊れたファイルは無視する。 */
export function mergeRunning(texts: readonly string[], now: number): RunningEntry[] {
  const groups: RunningEntry[][] = []
  for (const text of texts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const entries = (Array.isArray(parsed) ? parsed : []).filter(isDict) as unknown as RunningEntry[]
    if (entries.length === 0 || Math.max(...entries.map((e) => e.started)) < now - STALE_MS) continue
    groups.push(entries)
  }
  groups.sort((a, b) => (a[0] as RunningEntry).started - (b[0] as RunningEntry).started)
  return groups.flat()
}

/** owner 名は `<sessionId>.<乱数>` か `<sessionId>--<agentId>.<乱数>`。別の id の接頭辞になっているだけのものは含めない。 */
const ownedBySession = (name: string, sessionId: string): boolean => name.startsWith(`${sessionId}.`) || name.startsWith(`${sessionId}--`)

/** このセッション（メインとそのサブエージェント）の実行中一覧。 */
export async function listRunning(io: Io, sessionId: string): Promise<RunningEntry[]> {
  const now = await io.now()
  const texts: string[] = []
  for (const f of await io.list(runningDir(io))) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || !ownedBySession(f.name, sessionId)) continue
    const text = await io.readFile(join(runningDir(io), f.name))
    if (text !== undefined) texts.push(text)
  }
  return mergeRunning(texts, now)
}

/** 帯の 1 項目（インデント込み）の最大長。超える分は cmd を ` ...` で切る。 */
const BAND_LINE_MAX = 80
const INDENT = '  '
const ELLIPSIS = ' ...'

/** 複数行の cmd は先頭の行だけにして ` ...` を付ける。 */
function foldCmd(cmd: string): string {
  const lines = cmd
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
  return `${lines[0] ?? ''}${lines.length > 1 ? ELLIPSIS : ''}`
}

/** room に収まらなければ、できるだけ語の切れ目で切って ` ...` を付ける。 */
function cutCmd(text: string, room: number): string {
  if (text.length <= room) return text
  const limit = Math.max(0, room - ELLIPSIS.length)
  let head = text.slice(0, limit)
  if (text[limit] !== ' ') {
    const space = head.lastIndexOf(' ')
    if (space > 0) head = head.slice(0, space)
  }
  return `${head.trimEnd()}${ELLIPSIS}`
}

const markOf = (e: RunningEntry): string => (e.result === 'ok' ? '✓' : '✗')
const doneText = (e: RunningEntry, now: number): string => `${e.name ?? foldCmd(e.cmd)} ${markOf(e)} (${(((e.ended ?? now) - e.started) / 1000).toFixed(1)}s)`

function runningLine(e: RunningEntry, now: number): string {
  if (e.result) return `${INDENT}${doneText(e, now)}`
  const seconds = Math.max(0, Math.floor((now - e.started) / 1000))
  const head = e.name ? `${INDENT}${e.name} $ ` : INDENT
  const tail = `${e.waiting ? ' 待機中' : ''} (${seconds}s)`
  return `${head}${cutCmd(foldCmd(e.cmd), BAND_LINE_MAX - head.length - tail.length)}${tail}`
}

/** 帯に描く行: 見出し 1 行 + 1 項目 1 行。完了項目は所要時間を固定し、実行中の項目は now からの経過秒を出す。 */
export function runningLines(entries: readonly RunningEntry[], now: number): string[] {
  return ['[gate] 実行中:', ...entries.map((e) => runningLine(e, now))]
}

/** 実行中・完了待ちの項目が 1 つでもある間だけ帯の木を返す。全部終わっていれば undefined（帯を譲る）。 */
export function runningBand(entries: readonly RunningEntry[], now: number): RenderElement | undefined {
  if (!entries.some((e) => !e.result)) return undefined
  return {
    type: 'Box',
    props: { flexDirection: 'column' },
    children: runningLines(entries, now).map((line) => ({ type: 'Text', children: [line] })),
  }
}

/**
 * セッション内の全員の実行が終わったときの 1 行サマリ（ステータス行用）。チェック名は出さず件数だけにして、長さを一定に保つ。
 * 所要秒は最初の開始から最後の完了まで（並列なので各項目の合計ではない）。未完了があるか、何も無ければ undefined。
 */
export function finishedSummary(entries: readonly RunningEntry[]): string | undefined {
  if (entries.length === 0 || entries.some((e) => !e.result)) return undefined
  const passed = entries.filter((e) => e.result === 'ok').length
  const failed = entries.length - passed
  const counts = [passed > 0 ? `✓ ${passed}` : '', failed > 0 ? `✗ ${failed}` : ''].filter((s) => s !== '').join(' / ')
  const first = Math.min(...entries.map((e) => e.started))
  const last = Math.max(...entries.map((e) => e.ended ?? e.started))
  return `[gate] 完了: ${counts} (${((last - first) / 1000).toFixed(1)}s)`
}

// 完了サマリは gate が終わると一覧（running/）から消えるので、次の gate コマンドが走り始めるまで残すために
// セッションごとのファイルへ置く。feedback の表示など他の hook がステータス行を使ったあとに戻すのに使う。
const summaryFile = (io: Io, sessionId: string): string => join(gateStatusDir(io), `summary.${sessionId}.txt`)

export const saveSummary = (io: Io, sessionId: string, text: string): Promise<void> => io.writeFile(summaryFile(io, sessionId), text)

export const clearSummary = (io: Io, sessionId: string): Promise<void> => io.removeFiles([summaryFile(io, sessionId)])

export async function loadSummary(io: Io, sessionId: string): Promise<string | undefined> {
  const text = await io.readFile(summaryFile(io, sessionId))
  return text === undefined || text === '' ? undefined : text
}
