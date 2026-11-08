// スラッシュコマンド /hook-list: このプロジェクトで feedback-gate が何をいつ動かすかを一覧にする。
// gate.yaml（rules / consistency_checks / session_start のそれぞれが動くタイミングとコマンド）と、
// feedback ルール（有効・無効・読めないもの、注入のされ方、enforce の各要素が掛かるイベントと条件・コマンド）、
// プラグイン設定（agentLaunchGuard / autoCount）を、読むだけで並べる。ファイルには何も書かない。
// 整形は純粋関数（describeGate / describeFeedback）に分け、ファイルを読むのは hookListCommand だけ。

import type { PluginOptions } from 'claude-code'
import { configPaths, findGateYaml } from './config-dir.ts'
import { inactiveReason, listInactive } from './correct.ts'
import { type BrokenRule, logError, type Rule, resolveSeverity, scanRules } from './feedback-rules.ts'
import { type Lang, type Translate, tr } from './i18n.ts'
import type { Io } from './io.ts'
import { parseYaml } from './load-yaml.ts'
import { type Dict, isDict, truthy } from './pyutil.ts'

export type HookListArgs = { gate: boolean; feedback: boolean }

/** 引数を読む。`gate` / `feedback` でその節だけ。どちらも無ければ（不明なトークンだけでも）両方。 */
export function parseHookListArgs(args: string): HookListArgs {
  const tokens = new Set(args.split(/\s+/).filter((t) => t !== ''))
  const gate = tokens.has('gate')
  const feedback = tokens.has('feedback')
  return gate || feedback ? { gate, feedback } : { gate: true, feedback: true }
}

const INDENT = '    '
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : truthy(v) ? [String(v)] : [])
const quote = (v: unknown): string => `\`${String(v).replace(/\s*\n\s*/g, ' ⏎ ')}\``

/** run の要素 1 つを 1 行にする（`name: cmd (timeout 60s, share: false)`）。parallel はその中身を並べる。 */
function runLines(items: unknown, t: Translate, depth = 0): string[] {
  const pad = `${INDENT}  ${'  '.repeat(depth)}`
  const out: string[] = []
  for (const item of Array.isArray(items) ? items : []) {
    if (isDict(item) && Array.isArray(item.parallel)) {
      out.push(`${pad}${t('hookList.parallel')}`)
      out.push(...runLines(item.parallel, t, depth + 1))
      continue
    }
    const d: Dict = isDict(item) ? item : { cmd: item }
    if (!truthy(d.cmd)) continue
    const notes: string[] = []
    if (truthy(d.timeout)) notes.push(`timeout ${d.timeout}s`)
    if (d.share === false) notes.push('share: false')
    if (d.files === false) notes.push('files: false')
    const head = truthy(d.name) ? `${d.name}: ` : ''
    out.push(`${pad}- ${head}${quote(d.cmd)}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`)
  }
  return out
}

/** rule / check に付いている実行場所・timeout・policy を 1 行にまとめる（無ければ空）。 */
function optionLine(d: Dict): string[] {
  const notes: string[] = []
  if (truthy(d.dir)) notes.push(`dir: ${d.dir}`)
  if (truthy(d.per_file_dir)) notes.push(`per_file_dir: ${d.per_file_dir}`)
  if (truthy(d.timeout)) notes.push(`timeout: ${d.timeout}s`)
  if (d.policy === false) notes.push('policy: false')
  else if (truthy(d.policy)) notes.push(`policy: ${d.policy}`)
  return notes.length > 0 ? [`${INDENT}${notes.join(' / ')}`] : []
}

/**
 * gate.yaml の内容を、フェーズごとの「いつ動くか」と「何を動かすか」の行にする。
 * path が undefined なら gate.yaml が無い旨だけ、error があれば読めない旨だけを出す。
 */
export function describeGate(cfg: unknown, path: string | undefined, lang: Lang, error?: string): string[] {
  const t = tr(lang)
  const lines = [t('hookList.gateHeader')]
  if (path === undefined) return [...lines, `  ${t('hookList.gateMissing')}`]
  lines.push(`  ${path}`)
  if (error !== undefined) return [...lines, `  ${t('hookList.gateUnreadable', { reason: error })}`]
  const c: Dict = isDict(cfg) ? cfg : {}
  const rules = Array.isArray(c.rules) ? c.rules : []
  const checks = Array.isArray(c.consistency_checks) ? c.consistency_checks : []
  const starts = Array.isArray(c.session_start) ? c.session_start : []

  lines.push('', `  ${t('hookList.gateRules', { n: rules.length })}`, `  ${t('hookList.gateRulesWhen')}`)
  if (rules.length === 0) lines.push(`${INDENT}${t('hookList.none')}`)
  rules.forEach((raw, i) => {
    const r: Dict = isDict(raw) ? raw : {}
    lines.push(`  ${i + 1}. match: ${list(r.match).join(', ') || '-'}`)
    lines.push(...optionLine(r))
    lines.push(`${INDENT}run:`, ...runLines(r.run, t))
    const refs = list(r.run_checks)
    if (refs.length > 0) lines.push(`${INDENT}run_checks: ${refs.join(', ')} ${t('hookList.runChecksNote')}`)
  })

  lines.push('', `  ${t('hookList.gateChecks', { n: checks.length })}`, `  ${t('hookList.gateChecksWhen')}`)
  if (checks.length === 0) lines.push(`${INDENT}${t('hookList.none')}`)
  const referenced = new Set(rules.flatMap((r) => (isDict(r) ? list(r.run_checks) : [])))
  for (const raw of checks) {
    const ch: Dict = isDict(raw) ? raw : {}
    const name = truthy(ch.name) ? String(ch.name) : '?'
    lines.push(`  - ${name}${referenced.has(name) ? '' : ` ${t('hookList.unreferenced')}`}`)
    lines.push(...optionLine(ch))
    lines.push(`${INDENT}run:`, ...runLines(ch.run, t))
  }

  lines.push('', `  ${t('hookList.gateSessionStart', { n: starts.length })}`, `  ${t('hookList.gateSessionStartWhen')}`)
  if (starts.length === 0) lines.push(`${INDENT}${t('hookList.none')}`)
  for (const raw of starts) {
    const s: Dict = isDict(raw) ? raw : { cmd: raw }
    const notes: string[] = []
    const on = list(s.on)
    if (on.length > 0) notes.push(`on: ${on.join(', ')}`)
    if (s.background === true) notes.push('background')
    if (truthy(s.timeout)) notes.push(`timeout ${s.timeout}s`)
    const head = truthy(s.name) ? `${s.name}: ` : ''
    lines.push(`  - ${head}${quote(s.cmd ?? '')}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`)
  }

  const top: string[] = []
  if (c.max_parallel !== undefined) top.push(`max_parallel: ${c.max_parallel}`)
  if (c.report_success !== undefined) top.push(`report_success: ${c.report_success}`)
  if (c.policy !== undefined) top.push(`policy: ${c.policy}`)
  if (top.length > 0) lines.push('', `  ${top.join(' / ')}`)
  return lines
}

/** count からルールの段階（暫定 / 確定 / deny）を出す。 */
const levelOf = (count: number, t: Translate): string =>
  t(count >= 5 ? 'hookList.levelDeny' : count >= 3 ? 'hookList.levelConfirmed' : 'hookList.levelProvisional')

/** ルールがいつコンテキストに入るか。 */
function injectionOf(rule: Rule, t: Translate): string {
  if (rule.count < 3) return t('hookList.injectNone')
  if (rule.files.length === 0) return t('hookList.injectEveryPrompt')
  const exclude = rule.excludeFiles.length > 0 ? t('hookList.injectExclude', { globs: rule.excludeFiles.join(', ') }) : ''
  return t('hookList.injectFiles', { globs: rule.files.join(', '), exclude })
}

/** enforce の 1 要素を、イベントの説明と条件・コマンドの行にする。 */
function enforceLines(e: Dict, rule: Rule, t: Translate): string[] {
  const event = String(e.event ?? '')
  const key = `hookList.event.${event}`
  const when = t(key) === key ? '' : t(key)
  const severity = resolveSeverity(rule.count, e.severity, event)
  const pad = `${INDENT}    `
  const out = [`${INDENT}  - ${event} [${severity}]${when === '' ? '' : ` ${when}`}`]
  // pre_edit / post_edit で path を省いた要素は、読み込み時に files / exclude_files を引き継いでいる（feedback-rules.ts の inheritFiles）。
  const path = list(e.path)
  if (path.length > 0) out.push(`${pad}path: ${path.join(', ')}`)
  const excludePath = list(e.exclude_path)
  if (excludePath.length > 0) out.push(`${pad}exclude_path: ${excludePath.join(', ')}`)
  if (truthy(e.changed)) out.push(`${pad}changed: ${list(e.changed).join(', ')}`)
  for (const key of ['when', 'unless'] as const) if (truthy(e[key])) out.push(`${pad}${key}: ${quote(e[key])}`)
  if (truthy(e.check)) out.push(`${pad}check: ${quote(e.check)}`)
  for (const key of ['absent_sibling', 'absent_glob', 'require_sibling'] as const) {
    if (truthy(e[key])) out.push(`${pad}${key}: ${list(e[key]).join(', ')}`)
  }
  if (truthy(e.message)) out.push(`${pad}message: ${String(e.message).replace(/\s*\n\s*/g, ' ')}`)
  return out
}

/** ルールの置き場所（global / project）。プロジェクトの feedback ディレクトリの下ならプロジェクト。 */
const scopeOf = (rule: Rule, projectDirs: string[]): 'project' | 'global' => (projectDirs.some((d) => rule.path.startsWith(`${d}/`)) ? 'project' : 'global')

/** feedback ルールを、有効なもの（enforce の詳細付き）・無効なもの・読めないものの順に行にする。 */
export function describeFeedback(rules: Rule[], inactive: Rule[], broken: BrokenRule[], opts: { lang: Lang; now: number; projectDirs: string[] }): string[] {
  const t = tr(opts.lang)
  const lines = [t('hookList.feedbackHeader', { active: rules.length, inactive: inactive.length, broken: broken.length })]
  if (rules.length === 0) lines.push(`  ${t('hookList.none')}`)
  for (const rule of rules) {
    const scope = t(`hookList.scope.${scopeOf(rule, opts.projectDirs)}`)
    lines.push(`  - ${rule.name} [${scope}] count ${rule.count} (${levelOf(rule.count, t)})`)
    if (rule.description !== '') lines.push(`${INDENT}${rule.description}`)
    lines.push(`${INDENT}${t('hookList.inject')}: ${injectionOf(rule, t)}`)
    if (rule.enforce.length === 0) lines.push(`${INDENT}enforce: ${t('hookList.noEnforce')}`)
    else {
      lines.push(`${INDENT}enforce:`)
      for (const e of rule.enforce) lines.push(...enforceLines(e, rule, t))
    }
    lines.push(`${INDENT}${rule.path}`)
  }
  if (inactive.length > 0) {
    lines.push('', `  ${t('hookList.inactiveHeader')}`)
    for (const rule of inactive) lines.push(`  - ${rule.name}: ${inactiveReason(rule, opts.now, opts.lang)}`, `${INDENT}${rule.path}`)
  }
  if (broken.length > 0) {
    lines.push('', `  ${t('hookList.brokenHeader')}`)
    for (const b of broken) lines.push(`  - ${b.path}`, `${INDENT}${b.reason}`)
  }
  return lines
}

/** プラグイン設定のうち、hook の動き方を変えるもの。 */
export function describeOptions(options: PluginOptions, io: Io): string[] {
  const t = tr(io.lang)
  const onOff = (v: boolean) => t(v ? 'hookList.on' : 'hookList.off')
  return [
    t('hookList.optionsHeader'),
    `  agentLaunchGuard: ${onOff(options.agentLaunchGuard === true)} — ${t('hookList.agentLaunchGuard')}`,
    `  autoCount: ${onOff(io.autoCount !== false)} — ${t('hookList.autoCount')}`,
    `  language: ${io.lang}`,
  ]
}

/** gate.yaml を読む。無ければ path も undefined、YAML として読めなければ error に理由。 */
async function readGate(io: Io): Promise<{ path?: string; cfg?: unknown; error?: string }> {
  const path = await findGateYaml(io)
  if (path === undefined) return {}
  const text = await io.readFile(path)
  if (text === undefined) return { path, error: 'read failed' }
  try {
    return { path, cfg: parseYaml(text) }
  } catch (e) {
    return { path, error: (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '' }
  }
}

/** /hook-list 本体。例外は握りつぶして text に出す（hook のバグでコマンドが落ちないように）。 */
export async function hookListCommand(io: Io, args: string, options: PluginOptions = {}): Promise<{ text: string; context: string[] }> {
  try {
    const parsed = parseHookListArgs(args)
    const t = tr(io.lang)
    const project = io.projectDir || io.cwd
    const sections: string[][] = [[t('hookList.header', { project })]]
    if (parsed.gate) {
      const g = await readGate(io)
      sections.push(describeGate(g.cfg, g.path, io.lang, g.error))
    }
    if (parsed.feedback) {
      const { rules, broken } = await scanRules(io)
      const inactive = await listInactive(io, rules)
      const projectDirs = configPaths(io, project, 'feedback')
      sections.push(describeFeedback(rules, inactive, broken, { lang: io.lang, now: await io.now(), projectDirs }))
    }
    if (parsed.gate && parsed.feedback) sections.push(describeOptions(options, io))
    return { text: sections.map((s) => s.join('\n')).join('\n\n'), context: [] }
  } catch (e) {
    await logError(io, 'hook-list', e instanceof Error ? e.message : String(e))
    return { text: `[hook-list] internal error: ${e instanceof Error ? e.message : String(e)}`, context: [] }
  }
}
