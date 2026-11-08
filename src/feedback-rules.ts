// feedback ルールの読み込み（/correct 用。src/correct.ts）。
//
// グローバル (~/.claude/feedback/*.md) とプロジェクト (<projectDir>/.claude/feedback/*.md) の
// 両ディレクトリから frontmatter を全件読み（同名はプロジェクト側が優先）、壊れたルール・enforce の不備を集める。
// enforce の評価と強制（hook の判定）は Go 版（internal/hookgate/feedback_rules.go ほか）にあり、ここには無い。
// frontmatter の形式は skills/feedback/reference.md を参照。

import { configPaths } from './config-dir.ts'
import { asList, compileGlobs, expandBraces, globExists } from './glob.ts'
import { tr } from './i18n.ts'
import type { Io } from './io.ts'
import { parseYaml } from './load-yaml.ts'
import { basename, dirname, join } from './path.ts'
import { type Dict, isDict, pyRegExp, toCount, truthy } from './pyutil.ts'

export type Rule = {
  name: string
  description: string
  count: number
  /** 検証済みの enforce（辞書で、when / unless が正規表現としてコンパイルできる要素だけ）。 */
  enforce: Dict[]
  path: string
  /** 捨てた enforce の要素の理由（ルール自体は有効）。 */
  problems?: string[]
  /** 有効期限（ミリ秒）。これより後は無効。未指定なら無期限。 */
  expires?: number
  /** プロジェクトディレクトリの絶対パスにマッチする glob（~ 展開前）。空なら制限なし。 */
  projects: string[]
  /** プロジェクトルート相対の glob。空なら制限なし。 */
  whenExists: string[]
  /** 対象ファイルの glob（プロジェクトルート相対）。空ならファイル種別のスコープ無し（毎プロンプトに注入）。 */
  files: string[]
  /** files にマッチしても対象外にする glob。 */
  excludeFiles: string[]
}

/** グローバルの feedback の状態ファイル（.violations.jsonl、.ask_state など）の置き場所: ~/<設定ディレクトリ>/feedback。CLAUDE_FEEDBACK_DIR で差し替え可能。 */
export function feedbackDir(io: Io): string {
  const override = io.env.CLAUDE_FEEDBACK_DIR
  if (override) return override
  return join(io.homeConfigDir, 'feedback')
}

/** グローバルのルールを読むディレクトリ（優先順）。CLAUDE_FEEDBACK_DIR があればそれだけ。 */
export function feedbackDirs(io: Io): string[] {
  const override = io.env.CLAUDE_FEEDBACK_DIR
  if (override) return [override]
  return configPaths(io, io.env.HOME || '~', 'feedback')
}

/** プロジェクトの feedback の置き場所（<projectDir>/<設定ディレクトリ>/feedback）。 */
export function projectFeedbackDir(io: Io, projectDir?: string): string {
  return projectDir ? join(projectDir, io.configDirNames[0] ?? '.claude', 'feedback') : join(io.projectConfigDir, 'feedback')
}

/** プロジェクトのルールを読むディレクトリ（優先順）。 */
export const projectFeedbackDirs = (io: Io, projectDir?: string): string[] => configPaths(io, projectDir || io.projectDir || io.cwd, 'feedback')

export const violationsLogPath = (io: Io): string => join(feedbackDir(io), '.violations.jsonl')

/** 壊れたルールと、hook が握りつぶした内部エラーを残すログ。 */
export const errorsLogPath = (io: Io): string => join(feedbackDir(io), '.errors.jsonl')

/** 読めなかったルールファイル、または捨てた enforce の要素。 */
export type BrokenRule = { path: string; reason: string }

// ---- frontmatter 読み込み ----
export const FRONTMATTER_RE = /^---\s*\n([\s\S]*?\n)---\s*\n?/
const _BODY_STOP_RE = /\*\*(Why|言い訳|Excuse|How to apply)[:：]?\*\*/

/** frontmatter のテキスト（YAML のサブセット）を読む。 */
export const loadYamlText = (text: string): unknown => parseYaml(text)

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

/**
 * expires の値をミリ秒にする。YYYY-MM-DD はその日の 23:59:59.999（UTC）、それ以外は Date.parse で解釈する。
 * パースできない値は undefined（無期限扱い）。YAML 1.1 では日付が Date に解決されるので、それも受ける
 * （UTC 0 時ちょうどの Date は日付のみの指定とみなして日の終わりにする）。
 */
function parseExpires(v: unknown): number | undefined {
  if (v instanceof Date) {
    const t = v.getTime()
    if (Number.isNaN(t)) return undefined
    return t % DAY_MS === 0 ? t + DAY_MS - 1 : t
  }
  if (typeof v !== 'string') return undefined
  const text = v.trim()
  const t = Date.parse(text)
  if (Number.isNaN(t)) return undefined
  return DATE_ONLY_RE.test(text) ? t + DAY_MS - 1 : t
}

/** 文字列または配列を文字列だけのリストにそろえる。 */
const stringList = (v: unknown): string[] => asList(v).filter((x): x is string => typeof x === 'string')

const typeName = (v: unknown): string => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'list' : isDict(v) ? 'mapping' : typeof v)

/** when / unless を評価するイベントと、そのときのフラグ（evalPreBash / evalPreEdit / evalPostEdit と同じ）。 */
const REGEX_FLAGS: Record<string, string> = { pre_bash: '', pre_edit: 'm', post_edit: 'm' }

/**
 * frontmatter の enforce を「辞書のリスト」にそろえる。リストでなければ空、辞書でない要素と
 * when / unless が使えない正規表現の要素は捨て、その理由を problems に入れる。
 */
export function normalizeEnforce(io: Io, raw: unknown): { enforce: Dict[]; problems: string[] } {
  const t = tr(io.lang)
  const problems: string[] = []
  if (!truthy(raw)) return { enforce: [], problems }
  if (!Array.isArray(raw)) return { enforce: [], problems: [t('rules.enforceNotList', { type: typeName(raw) })] }
  const enforce: Dict[] = []
  raw.forEach((entry: unknown, index: number) => {
    if (!isDict(entry)) {
      problems.push(t('rules.enforceItemNotMapping', { index, type: typeName(entry) }))
      return
    }
    const flags = typeof entry.event === 'string' ? REGEX_FLAGS[entry.event] : undefined
    if (flags !== undefined) {
      for (const key of ['when', 'unless']) {
        const v = entry[key]
        if (!truthy(v)) continue
        try {
          pyRegExp(String(v), flags)
        } catch (e) {
          problems.push(t('rules.badRegex', { index, key, error: errorText(e) }))
          return
        }
      }
    }
    enforce.push(entry)
  })
  return { enforce, problems }
}

/** 例外を 1 行の文字列にする（YAML のエラーはコードフレーム付きの複数行なので先頭行だけ）。 */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]?.trim() ?? ''

/**
 * 1つの feedback ファイルから frontmatter を読む。frontmatter が無ければ null（rules.md はこれで黙ってスキップされる）。
 * frontmatter が YAML として読めなければ例外を投げる（listRules はそのファイルだけを飛ばす）。
 */
export async function loadRule(io: Io, path: string): Promise<Rule | null> {
  const content = await io.readFile(path)
  if (content === undefined) return null
  const m = FRONTMATTER_RE.exec(content)
  if (!m) return null
  const data = loadYamlText(m[1] ?? '')
  if (!isDict(data) || !truthy(data.name)) return null
  const files = stringList(data.files)
  const excludeFiles = stringList(data.exclude_files)
  const { enforce, problems } = normalizeEnforce(io, data.enforce)
  return {
    name: String(data.name),
    description: truthy(data.description) ? String(data.description) : '',
    count: toCount(data.count),
    enforce: inheritFiles(enforce, files, excludeFiles),
    ...(problems.length > 0 ? { problems } : {}),
    path,
    expires: parseExpires(data.expires),
    projects: stringList(data.projects),
    whenExists: stringList(data.when_exists),
    files,
    excludeFiles,
  }
}

/** path を見る enforce のイベント（pre_edit / post_edit）。 */
const PATH_EVENTS = new Set(['pre_edit', 'post_edit'])

/**
 * pre_edit / post_edit の enforce で path が無い要素に、ルールの files / exclude_files を補う（同じ glob を二度書かなくてよいように）。
 * files が無ければ何もしない（path の無い要素は従来どおりどのファイルにもマッチしない）。
 */
export function inheritFiles(enforce: Dict[], files: string[], excludeFiles: string[]): Dict[] {
  if (files.length === 0) return enforce
  return enforce.map((entry) => {
    if (typeof entry.event !== 'string' || !PATH_EVENTS.has(entry.event) || truthy(entry.path)) return entry
    const out: Dict = { ...entry, path: [...files] }
    if (!truthy(entry.exclude_path) && excludeFiles.length > 0) out.exclude_path = [...excludeFiles]
    return out
  })
}

/** 先頭の ~ を HOME に展開する（HOME が無ければそのまま）。 */
function expandTilde(io: Io, pattern: string): string {
  const home = io.env.HOME
  if (!home || (pattern !== '~' && !pattern.startsWith('~/'))) return pattern
  return join(home, pattern.slice(2))
}

/**
 * ルールが今のプロジェクトで有効か。expires / projects / when_exists の3つすべてを満たしたときだけ true。
 * projectDir 省略時は io.projectDir（無ければ cwd）。
 */
export async function isRuleActive(io: Io, rule: Rule, projectDir?: string): Promise<boolean> {
  if (rule.expires !== undefined && (await io.now()) > rule.expires) return false
  const dir = projectDir || io.projectDir || io.cwd
  if (rule.projects.length > 0) {
    const rxs = compileGlobs(rule.projects.map((p) => expandTilde(io, p)))
    if (!rxs.some((rx) => rx.test(dir))) return false
  }
  if (rule.whenExists.length > 0) {
    let found = false
    for (const pattern of rule.whenExists) {
      for (const expanded of expandBraces(pattern)) {
        if (await globExists(io, join(dir, expanded))) {
          found = true
          break
        }
      }
      if (found) break
    }
    if (!found) return false
  }
  return true
}

/** 1つのディレクトリ直下の *.md を名前順に走査し、frontmatter を持つものだけ返す。読めないファイルは broken に入れて飛ばす。 */
/** 候補ディレクトリを優先順に読み、同名のルールは先の候補を採る（.claude と .agents が同じ実体を指すときに二重に読まないため）。 */
async function listRulesInAll(io: Io, dirs: readonly string[], broken: BrokenRule[]): Promise<Rule[]> {
  const out: Rule[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    for (const rule of await listRulesIn(io, dir, broken)) {
      if (seen.has(rule.name)) continue
      seen.add(rule.name)
      out.push(rule)
    }
  }
  return out
}

async function listRulesIn(io: Io, d: string, broken: BrokenRule[]): Promise<Rule[]> {
  const rules: Rule[] = []
  const names = (await io.list(d)).map((e) => e.name).sort()
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const path = join(d, name)
    try {
      const rule = await loadRule(io, path)
      if (rule) rules.push(rule)
    } catch (e) {
      broken.push({ path, reason: tr(io.lang)('rules.unreadable', { error: errorText(e) }) })
    }
  }
  return rules
}

const problemsOf = (rules: Rule[]): BrokenRule[] => rules.flatMap((r) => (r.problems ?? []).map((reason) => ({ path: r.path, reason })))

/**
 * feedback ルールを全件読み、frontmatter を持つものだけ返す。
 * feedbackDirPath を明示したときはそのディレクトリだけを読む。省略時はグローバル (feedbackDir) と
 * プロジェクト (projectFeedbackDir) の両方を読んでマージし、同名 (name) のルールはプロジェクト側を優先する。
 * 返す順序はグローバル（上書きされたものを除く）→プロジェクト。
 * マージ後に isRuleActive で絞る（プロジェクト側の同名ルールが期限切れ・対象外のとき、グローバル側が復活しないように）。
 * feedbackDirPath を明示したときはフィルタせず無加工で返す。
 */
export async function listRules(io: Io, feedbackDirPath?: string): Promise<Rule[]> {
  const { rules, broken } = await scanRules(io, feedbackDirPath)
  for (const b of broken) await logError(io, 'rules', b.reason, b.path)
  return rules
}

/**
 * listRules と同じ読み方で、ルールと壊れたルール（読めなかったファイルと、捨てた enforce の要素）を返す。ログには書かない。
 * 壊れたルールのうち enforce の要素の不備は、返すルール（マージ・フィルタ後）のものだけを含める。
 */
export async function scanRules(io: Io, feedbackDirPath?: string): Promise<{ rules: Rule[]; broken: BrokenRule[] }> {
  const broken: BrokenRule[] = []
  if (feedbackDirPath) {
    const rules = await listRulesIn(io, feedbackDirPath, broken)
    return { rules, broken: [...broken, ...problemsOf(rules)] }
  }
  const globalDirs = feedbackDirs(io)
  // グローバルと同じディレクトリをプロジェクト側でも読まない（CLAUDE_FEEDBACK_DIR をプロジェクトに向けるテスト）。
  const projectDirs = projectFeedbackDirs(io).filter((d) => !globalDirs.includes(d))
  const globalRules = await listRulesInAll(io, globalDirs, broken)
  const projectRules = await listRulesInAll(io, projectDirs, broken)
  const overridden = new Set(projectRules.map((r) => r.name))
  const merged = [...globalRules.filter((r) => !overridden.has(r.name)), ...projectRules]
  const active: Rule[] = []
  for (const r of merged) if (await isRuleActive(io, r)) active.push(r)
  return { rules: active, broken: [...broken, ...problemsOf(active)] }
}

// ---- 違反ログ ----
let logQueue: Promise<void> = Promise.resolve()

/**
 * ~/.claude/feedback/.errors.jsonl に1行 JSON を追記する（壊れたルールと、hook が握りつぶした内部エラー）。
 * hook は呼び出しのたびにルールを読み直すので、同じ (source, file, error) がすでにあれば書かない。
 * ログ失敗で hook を止めないよう例外は握りつぶす。
 */
export function logError(io: Io, source: string, error: string, file?: string): Promise<void> {
  const task = logQueue.then(async () => {
    try {
      const path = errorsLogPath(io)
      const existing = (await io.readFile(path)) ?? ''
      const same = (line: string): boolean => {
        try {
          const d: unknown = JSON.parse(line)
          return isDict(d) && d.source === source && d.error === error && (d.file ?? undefined) === file
        } catch {
          return false
        }
      }
      if (existing.split('\n').some(same)) return
      const ts = new Date(await io.now()).toISOString().replace('Z', '+00:00')
      const entry = { ts, source, ...(file !== undefined ? { file } : {}), error }
      await io.writeFile(path, `${existing}${JSON.stringify(entry)}\n`)
    } catch {
      // ログ失敗で hook を止めない
    }
  })
  logQueue = task
  return task
}

// ---- count 行の読み書き（/correct apply）----
/** frontmatter 内の `count: N` 行（数値リテラルのみ）。引用符付きや式は対象外。 */
const COUNT_LINE_RE = /^count:[ \t]*(\d+)[ \t]*(?=\r?$)/m

/** frontmatter の `count:` 行の値を返す。frontmatter や数値の count 行が無ければ undefined。 */
export function readCountLine(content: string): number | undefined {
  const fm = FRONTMATTER_RE.exec(content)
  if (!fm) return undefined
  const m = COUNT_LINE_RE.exec(fm[0])
  return m ? Number(m[1]) : undefined
}

/** frontmatter の `count:` 行だけを `count: to` に置き換えた全文を返す。置き換えられなければ undefined。 */
export function replaceCountLine(content: string, to: number): string | undefined {
  const fm = FRONTMATTER_RE.exec(content)
  if (!fm) return undefined
  const head = fm[0]
  if (!COUNT_LINE_RE.test(head)) return undefined
  return head.replace(COUNT_LINE_RE, `count: ${to}`) + content.slice(head.length)
}

/**
 * 同じディレクトリの一時ファイルに書いてから mv で置き換える（読み手が書きかけのファイルを見ないように）。
 * 一時ファイルは .md で終わらないので listRules には拾われない。mv が使えなければ直接書く。
 */
export async function writeFileAtomic(io: Io, path: string, text: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${Math.floor(await io.now())}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    await io.writeFile(tmp, text)
    const r = await io.run(['mv', '-f', '--', tmp, path], { timeoutMs: 5_000 })
    if (r.exitCode === 0 && !r.timedOut && r.error === undefined) return
  } catch {
    // 下で直接書く
  }
  await io.removeFiles([tmp]).catch(() => undefined)
  await io.writeFile(path, text)
}
