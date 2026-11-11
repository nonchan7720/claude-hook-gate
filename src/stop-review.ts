// Stop / SubagentStop hook: gate.yaml の stop_review。止まる前に、今回変更したファイルを同じモデル自身に見直させる。
//
// gate の checks フェーズと feedback の stop_check が通ったあとに呼ばれる（src/all-stop.ts、src/hooks.ts の subagentStop）。
// 前回の見直し以降に変更されたファイル（review_pending.<state_id>.txt。record-changes / bash-changes が notePendingReview で
// 足す）があれば、停止を 1 回ブロックして見直しの手順を reason として返す。hook の出力ではセッションの effort を変えられない
// ので、reason の先頭で同梱スキル feedback-gate:effort-<level>（frontmatter の effort がそのターンの残りに効く）を
// 呼ばせて effort を切り替える。
//
// 見直しの途中の修正も review_pending に足されるので、次の Stop でまた見直しになる。それを max_rounds（既定 1）回で
// 打ち切る: 回数は review_rounds.<state_id>.txt に持ち、見直すものが無い Stop と、打ち切った Stop で消す。
import { findGateYaml } from './config-dir.ts'
import { asList, compileGlobs } from './glob.ts'
import { tr } from './i18n.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { parseYaml } from './load-yaml.ts'
import { join } from './path.ts'
import { type Dict, isDict, jqStr } from './pyutil.ts'
import { rootLabel, splitRoot } from './roots.ts'
import { gateStatusDir } from './running-registry.ts'

export const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const DEFAULT_EFFORT = 'xhigh'
export const DEFAULT_MAX_ROUNDS = 1
/** reason に並べる変更ファイルの上限。超えた分は件数だけ出す。 */
export const MAX_LISTED_FILES = 30

export type StopReview = {
  /** 切り替える effort。null は切り替えない（見直しだけ行う）。 */
  effort: string | null
  /** 対象にする変更ファイルの glob（ルート相対）。空ならすべて。 */
  match: string[]
  maxRounds: number
  /** reason の末尾に足すプロジェクト固有の指示。 */
  prompt: string
  /** SubagentStop でも行うか。 */
  subagents: boolean
}

/** gate.yaml の stop_review（true またはマッピング）を正規化する。それ以外（未指定・false など）は undefined（無効）。 */
export function parseStopReview(raw: unknown): StopReview | undefined {
  if (raw !== true && !isDict(raw)) return undefined
  const d: Dict = isDict(raw) ? raw : {}
  if (d.enabled === false) return undefined
  const rounds = Number(d.max_rounds)
  return {
    effort: d.effort === false ? null : typeof d.effort === 'string' && EFFORT_LEVELS.includes(d.effort) ? d.effort : DEFAULT_EFFORT,
    match: asList(d.match).map(String),
    maxRounds: Number.isInteger(rounds) && rounds >= 1 ? rounds : DEFAULT_MAX_ROUNDS,
    prompt: typeof d.prompt === 'string' ? d.prompt.trim() : '',
    subagents: d.subagents !== false,
  }
}

const stateIdOf = (payload: Dict): string => {
  const sessionId = jqStr(payload.session_id) || 'unknown'
  const agentId = jqStr(payload.agent_id)
  return agentId ? `${sessionId}--${agentId}` : sessionId
}

export const pendingPath = (io: Io, stateId: string): string => join(gateStatusDir(io), `review_pending.${stateId}.txt`)
export const roundsPath = (io: Io, stateId: string): string => join(gateStatusDir(io), `review_rounds.${stateId}.txt`)

/** 変更ファイル（絶対パス）を「まだ見直していない」一覧へ足す。changed_files と違い、gate が通っても消えない。 */
export async function notePendingReview(io: Io, stateId: string, paths: readonly string[]): Promise<void> {
  const memo = pendingPath(io, stateId)
  const existing = (await io.readFile(memo)) ?? ''
  const have = new Set(existing.split('\n'))
  const added = paths.filter((p) => p !== '' && !have.has(p))
  if (added.length > 0) await io.writeFile(memo, `${existing}${[...new Set(added)].map((p) => `${p}\n`).join('')}`)
}

async function loadConfig(io: Io, path: string): Promise<StopReview | undefined> {
  const text = await io.readFile(path)
  if (text === undefined) return undefined
  try {
    const cfg = parseYaml(text)
    return isDict(cfg) ? parseStopReview(cfg.stop_review) : undefined
  } catch {
    // 壊れた gate.yaml は gate 本体が知らせる
    return undefined
  }
}

async function main(io: Io, payload: Dict): Promise<ScriptResult> {
  const yaml = await findGateYaml(io)
  if (!yaml) return ok()
  const stateId = stateIdOf(payload)
  const pending = pendingPath(io, stateId)
  const roundsFile = roundsPath(io, stateId)
  const clear = () => io.removeFiles([pending, roundsFile])

  const cfg = await loadConfig(io, yaml)
  if (!cfg || (jqStr(payload.agent_id) !== '' && !cfg.subagents)) {
    await clear()
    return ok()
  }

  const projectDir = io.projectDir || io.cwd
  const globs = compileGlobs(cfg.match)
  const labels: string[] = []
  for (const line of ((await io.readFile(pending)) ?? '').split('\n')) {
    if (line === '') continue
    const [root, rel] = splitRoot(projectDir, line)
    if (globs.length > 0 && !globs.some((rx) => rx.test(rel))) continue
    const label = rootLabel(root, projectDir, rel)
    if (!labels.includes(label)) labels.push(label)
  }

  const done = Number.parseInt(((await io.readFile(roundsFile)) ?? '').trim(), 10) || 0
  if (labels.length === 0 || done >= cfg.maxRounds) {
    await clear()
    // 見直しでブロックした後の Stop は stop_hook_active なので、完了通知を出させるために印を返す（all-stop.ts）。
    return done > 0 ? { ...ok(), reportConsumed: true } : ok()
  }

  await io.writeFile(roundsFile, String(done + 1))
  await io.removeFiles([pending])

  const t = tr(io.lang)
  const lines = [t('stopReview.header', { round: done + 1, max: cfg.maxRounds })]
  if (cfg.effort) lines.push(t('stopReview.effort', { effort: cfg.effort }))
  lines.push(t('stopReview.steps'))
  lines.push(t('stopReview.files'))
  for (const label of labels.slice(0, MAX_LISTED_FILES)) lines.push(`- ${label}`)
  if (labels.length > MAX_LISTED_FILES) lines.push(t('stopReview.more', { count: labels.length - MAX_LISTED_FILES }))
  if (cfg.prompt) lines.push(cfg.prompt)
  const reason = lines.join('\n')
  return { exitCode: 2, stdout: `${JSON.stringify({ decision: 'block', reason })}\n`, stderr: `${reason}\n` }
}

export async function stopReview(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await main(io, payload)
  } catch (e) {
    // hook のバグで作業を止めない
    return ok('', `[stop-review] internal error (ignored): ${e instanceof Error ? e.message : String(e)}\n`)
  }
}
