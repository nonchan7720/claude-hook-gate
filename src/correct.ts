// スラッシュコマンド /correct: feedback ルールと違反ログ（.violations.jsonl）を集計し、
// 「count を上げる」「enforce を足す」「期限切れを片付ける」の提案を出す。
// 集計・提案・整形は純粋関数に分け、ファイルに触れるのは readViolations / applyCountBumps / correctCommand だけ。

import { FRONTMATTER_RE, feedbackDir, isRuleActive, listRules, projectFeedbackDir, type Rule, violationsLogPath } from './feedback-rules.ts'
import type { Io } from './io.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const DEFAULT_WINDOW_MS = 30 * DAY_MS
const DEFAULT_MIN = 2

export type CorrectArgs = { window: number; apply: boolean; min: number }

export type ViolationEntry = {
  ts: string
  rule: string
  count: number
  severity: string
  event: string
  detail: string
}

/** bySeverity / byEvent / topDetail は窓内の違反だけから数える（提案が窓内の違反を根拠にするため）。total / lastTs は全期間。 */
export type RuleStats = {
  total: number
  inWindow: number
  bySeverity: Record<string, number>
  byEvent: Record<string, number>
  lastTs?: string
  topDetail?: string
}

export type ProposalOpts = { window: number; min: number; now: number }

export type Proposal =
  | { kind: 'bump'; rule: string; path: string; from: number; to: number; reason: string }
  | { kind: 'enforce'; rule: string; path: string; reason: string; template: string }
  | { kind: 'stale'; rule: string; path: string; reason: string }
  | { kind: 'expired'; rule: string; path: string; reason: string }

export type Applied = { path: string; from: number; to: number }

/** 引数文字列を読む。`--window 30d`（Nd / Nh）、`--min N`、`apply`。不明なトークンは無視する。 */
export function parseCorrectArgs(args: string): CorrectArgs {
  const out: CorrectArgs = { window: DEFAULT_WINDOW_MS, apply: false, min: DEFAULT_MIN }
  const tokens = args.split(/\s+/).filter((t) => t !== '')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    const eq = token.indexOf('=')
    const key = eq >= 0 ? token.slice(0, eq) : token
    if (key === 'apply' && eq < 0) {
      out.apply = true
    } else if (key === '--window' || key === '--min') {
      const inline = eq >= 0
      const value = inline ? token.slice(eq + 1) : (tokens[i + 1] ?? '')
      const parsed = key === '--window' ? parseWindow(value) : parseMin(value)
      if (parsed === undefined) continue
      if (key === '--window') out.window = parsed
      else out.min = parsed
      if (!inline) i++
    }
  }
  return out
}

function parseWindow(v: string): number | undefined {
  const m = /^(\d+)([dh])$/.exec(v)
  if (!m) return undefined
  const n = Number(m[1])
  return n > 0 ? n * (m[2] === 'd' ? DAY_MS : HOUR_MS) : undefined
}

function parseMin(v: string): number | undefined {
  if (!/^\d+$/.test(v)) return undefined
  const n = Number(v)
  return n > 0 ? n : undefined
}

/** ミリ秒の窓を `30d` / `12h` の表記に戻す。 */
function windowLabel(ms: number): string {
  return ms % DAY_MS === 0 ? `${ms / DAY_MS}d` : `${Math.round(ms / HOUR_MS)}h`
}

/** 違反ログを読む。壊れた行は飛ばし、ログが無ければ []。 */
export async function readViolations(io: Io): Promise<ViolationEntry[]> {
  const text = await io.readFile(violationsLogPath(io))
  if (text === undefined) return []
  const entries: ViolationEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let data: unknown
    try {
      data = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
    const d = data as Record<string, unknown>
    if (typeof d.rule !== 'string' || d.rule === '') continue
    entries.push({
      ts: typeof d.ts === 'string' ? d.ts : '',
      rule: d.rule,
      count: typeof d.count === 'number' ? d.count : 0,
      severity: typeof d.severity === 'string' ? d.severity : '',
      event: typeof d.event === 'string' ? d.event : '',
      detail: typeof d.detail === 'string' ? d.detail : '',
    })
  }
  return entries
}

const bump = (rec: Record<string, number>, key: string) => {
  if (key !== '') rec[key] = (rec[key] ?? 0) + 1
}

/** ルール名ごとに違反を集計する。窓は now - windowMs 以降の ts（ts が読めない行は窓外）。 */
export function aggregateViolations(entries: ViolationEntry[], now: number, windowMs: number): Map<string, RuleStats> {
  const stats = new Map<string, RuleStats>()
  const details = new Map<string, Map<string, number>>()
  const since = now - windowMs
  for (const e of entries) {
    let s = stats.get(e.rule)
    if (!s) {
      s = { total: 0, inWindow: 0, bySeverity: {}, byEvent: {} }
      stats.set(e.rule, s)
    }
    s.total++
    const t = Date.parse(e.ts)
    if (e.ts !== '' && (s.lastTs === undefined || t > Date.parse(s.lastTs))) s.lastTs = e.ts
    if (Number.isNaN(t) || t < since) continue
    s.inWindow++
    bump(s.bySeverity, e.severity)
    bump(s.byEvent, e.event)
    if (e.detail !== '') {
      const d = details.get(e.rule) ?? new Map<string, number>()
      d.set(e.detail, (d.get(e.detail) ?? 0) + 1)
      details.set(e.rule, d)
    }
  }
  for (const [rule, d] of details) {
    let top: string | undefined
    let best = 0
    for (const [detail, n] of d) {
      if (n > best) {
        best = n
        top = detail
      }
    }
    const s = stats.get(rule)
    if (s && top !== undefined) s.topDetail = top
  }
  return stats
}

/** rules/feedback_rules.md の enforce 節と同じ 4 イベントの雛形。 */
export const ENFORCE_TEMPLATE = `enforce:
  - event: pre_bash
    when: '正規表現'
    unless: '正規表現'
    message: '違反時に出す指示文'
  - event: pre_edit
    path: 'glob'
    when: '正規表現'
    message: '違反時に出す指示文'
  - event: post_edit
    path: 'glob'
    when: '正規表現'
    message: '違反時に出す指示文'
  - event: stop_check
    changed: 'glob'
    check: 'shell cmd'
    message: '違反時に出す指示文'`

const oneLine = (s: string, max = 60): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const countsText = (rec: Record<string, number>): string =>
  Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')

function inactiveReason(rule: Rule, now: number): string {
  if (rule.expires !== undefined && now > rule.expires) return `expires（${new Date(rule.expires).toISOString().slice(0, 10)}）を過ぎている`
  const parts: string[] = []
  if (rule.projects.length > 0) parts.push('projects')
  if (rule.whenExists.length > 0) parts.push('when_exists')
  return `${parts.join(' / ') || '条件'} がこのプロジェクトに一致せず無効`
}

/** 提案を作る。並びは bump（to 降順、違反数降順）→ enforce → stale → expired。 */
export function buildProposals(rules: Rule[], inactive: Rule[], stats: Map<string, RuleStats>, opts: ProposalOpts): Proposal[] {
  const bumps: Array<Extract<Proposal, { kind: 'bump' }> & { n: number }> = []
  const enforces: Proposal[] = []
  const stales: Proposal[] = []
  const expireds: Proposal[] = []
  const label = windowLabel(opts.window)

  for (const rule of rules) {
    const s = stats.get(rule.name)
    const n = s?.inWindow ?? 0
    if (n >= opts.min && s) {
      if (rule.count < 3) {
        bumps.push({
          kind: 'bump',
          rule: rule.name,
          path: rule.path,
          from: rule.count,
          to: 3,
          n,
          reason: `直近 ${label} で ${n} 回違反（${countsText(s.bySeverity)}）。確定ルールへ昇格${s.topDetail ? `。最多: ${oneLine(s.topDetail)}` : ''}`,
        })
      } else if (rule.count < 5) {
        const strong = (s.bySeverity.ask ?? 0) + (s.bySeverity.block ?? 0)
        if (strong >= opts.min) {
          bumps.push({
            kind: 'bump',
            rule: rule.name,
            path: rule.path,
            from: rule.count,
            to: 5,
            n,
            reason: `直近 ${label} で ask / block が ${strong} 回（${countsText(s.bySeverity)}）。deny へ引き上げ${s.topDetail ? `。最多: ${oneLine(s.topDetail)}` : ''}`,
          })
        }
      }
    }
    if (rule.count >= 3 && rule.enforce.length === 0) {
      enforces.push({
        kind: 'enforce',
        rule: rule.name,
        path: rule.path,
        reason: `count ${rule.count} の確定ルールだが enforce が無く、hook が検知できない（違反ログにも出ない）`,
        template: ENFORCE_TEMPLATE,
      })
    }
    if (rule.count >= 3 && rule.enforce.length > 0 && n === 0 && (s?.total ?? 0) === 0) {
      stales.push({
        kind: 'stale',
        rule: rule.name,
        path: rule.path,
        reason: `enforce ありで違反ログに一度も出ていない。enforce が効いているか、ルールが古くなっていないか確認`,
      })
    }
  }
  for (const rule of inactive) {
    expireds.push({ kind: 'expired', rule: rule.name, path: rule.path, reason: `${inactiveReason(rule, opts.now)}。削除または更新を検討` })
  }

  bumps.sort((a, b) => b.to - a.to || b.n - a.n)
  return [...bumps.map(({ n: _n, ...p }) => p), ...enforces, ...stales, ...expireds]
}

/** ユーザー向けの日本語レポート。applied を渡すと、書き換えたファイルの一覧を出す。 */
export function formatReport(
  proposals: Proposal[],
  stats: Map<string, RuleStats>,
  opts: { window: number; apply?: boolean },
  rulesCount: number,
  applied?: Applied[],
): string {
  let violations = 0
  for (const s of stats.values()) violations += s.inWindow
  const lines = [`[correct] 直近 ${windowLabel(opts.window)}: ルール ${rulesCount} 件 / 違反 ${violations} 件`]
  if (proposals.length === 0) {
    lines.push('提案はありません。')
  } else {
    for (const p of proposals) {
      const head = p.kind === 'bump' ? `${p.rule}: count ${p.from} → ${p.to}` : p.rule
      lines.push(`- [${p.kind}] ${head}`, `    ${p.reason}`, `    ${p.path}`)
    }
  }
  if (opts.apply) {
    lines.push(!applied || applied.length === 0 ? 'apply: 書き換えたファイルはありません。' : 'apply: count を書き換えました。')
    for (const a of applied ?? []) lines.push(`  - ${a.path} (count ${a.from} → ${a.to})`)
  } else {
    lines.push('`/correct apply` で bump の count 引き上げをファイルに書き込みます（enforce は提案のみ）。')
  }
  return lines.join('\n')
}

/**
 * bump 提案のファイルの frontmatter 内にある `count:` 行だけを書き換える。他は触らない。
 * frontmatter の count が提案時の from と違う（その後に変わった）ファイルは書き換えない。
 */
export async function applyCountBumps(io: Io, proposals: Proposal[]): Promise<Applied[]> {
  const applied: Applied[] = []
  for (const p of proposals) {
    if (p.kind !== 'bump') continue
    const content = await io.readFile(p.path)
    if (content === undefined) continue
    const fm = FRONTMATTER_RE.exec(content)
    if (!fm) continue
    const head = fm[0]
    const re = /^count:[ \t]*(\d+)[ \t]*(?=\r?$)/m
    const m = re.exec(head)
    if (!m || Number(m[1]) !== p.from) continue
    const next = head.replace(re, `count: ${p.to}`)
    await io.writeFile(p.path, next + content.slice(head.length))
    applied.push({ path: p.path, from: p.from, to: p.to })
  }
  return applied
}

/** モデル向けの hidden message。提案が無ければ空。 */
export function buildContext(proposals: Proposal[], applied: Applied[]): string[] {
  if (proposals.length === 0) return []
  const lines = [
    '/correct の結果です。ユーザーに上記の提案を提示してください。',
    '- enforce の追加は、対象ルールの本文から正規表現 / glob を起こして具体案を提案する（雛形は rules/feedback_rules.md の enforce 節）。',
    '- ファイルを書き換える前に、必ずユーザーに確認する（rules/feedback_rules.md のルールどおり）。',
    '- stale / expired は、ルールを残すか更新・削除するかをユーザーに尋ねる。',
  ]
  if (applied.length > 0) {
    lines.push(
      `- apply により次のファイルの count をすでに書き換えた。その事実をユーザーに伝えること: ${applied.map((a) => `${a.path} (${a.from} → ${a.to})`).join(', ')}`,
    )
  }
  return [lines.join('\n')]
}

/** グローバル / プロジェクトの feedback ディレクトリを無加工で読み、isRuleActive が false のものを返す。 */
async function listInactive(io: Io, active: Rule[]): Promise<Rule[]> {
  const dirs = [...new Set([feedbackDir(io), projectFeedbackDir(io)])]
  const activeNames = new Set(active.map((r) => r.name))
  const seen = new Set<string>()
  const out: Rule[] = []
  for (const dir of dirs) {
    for (const rule of await listRules(io, dir)) {
      if (seen.has(rule.path)) continue
      seen.add(rule.path)
      // 同名の有効なルールに上書きされている側は、片付ける対象ではない。
      if (activeNames.has(rule.name)) continue
      if (!(await isRuleActive(io, rule))) out.push(rule)
    }
  }
  return out
}

/** /correct 本体。例外は握りつぶして text に出す（hook のバグでコマンドが落ちないように）。 */
export async function correctCommand(io: Io, args: string): Promise<{ text: string; context: string[] }> {
  try {
    const parsed = parseCorrectArgs(args)
    const now = await io.now()
    const rules = await listRules(io)
    const inactive = await listInactive(io, rules)
    const stats = aggregateViolations(await readViolations(io), now, parsed.window)
    const opts = { window: parsed.window, min: parsed.min, now }
    const proposals = buildProposals(rules, inactive, stats, opts)
    const applied = parsed.apply ? await applyCountBumps(io, proposals) : undefined
    return {
      text: formatReport(proposals, stats, { window: parsed.window, apply: parsed.apply }, rules.length, applied),
      context: buildContext(proposals, applied ?? []),
    }
  } catch (e) {
    return { text: `[correct] internal error: ${e instanceof Error ? e.message : String(e)}`, context: [] }
  }
}
