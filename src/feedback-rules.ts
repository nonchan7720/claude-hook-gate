// feedback ルール共通モジュール。
//
// グローバル (~/.claude/feedback/*.md) とプロジェクト (<projectDir>/.claude/feedback/*.md) の
// 両ディレクトリから frontmatter を全件読み（同名はプロジェクト側が優先）、count に応じた強制力
// （severity: deny / ask（pre_*）・block（stop_check / post_edit） / warn）を解決する。
// PreToolUse hook (feedback-guard.ts) / PostToolUse hook (feedback-post-edit.ts) /
// Stop hook (feedback-stop-check.ts) / UserPromptSubmit hook (feedback-inject.ts) から使う
// 共通ロジックのみを持つ。
//
// enforce スキーマ（frontmatter に追記する形式）
//
// enforce:
//   - event: pre_bash          # PreToolUse(Bash) でコマンド文字列を検査
//     when: '正規表現'          # 必須。command にマッチしたら候補
//     unless: '正規表現'        # 任意。マッチすれば違反ではない
//     check: 'shell cmd'       # 任意。非0終了で違反確定（when と AND）
//     message: '違反時の指示文'
//     severity: deny           # 任意。省略時は count から自動決定
//
//   - event: pre_edit          # PreToolUse(Edit|Write|MultiEdit) で対象と内容を検査
//     path: 'glob'             # 必須。file_path にマッチ
//     exclude_path: 'glob'     # 任意。文字列または配列。path にマッチしても
//                              # これにマッチしたら検査対象外（テスト不要なファイルの除外）
//     when: '正規表現'          # 任意。new_string / content / new_source に対して
//     unless: '正規表現'        # 任意
//     absent_sibling: 'name'   # 任意。同ディレクトリにこの名前のファイルが無ければ違反
//                              # ({stem} はファイル名 (拡張子抜き) に置換される。
//                              # kebab-case/snake_case 両方の候補が展開される)
//                              # 対象ファイル自身がテストファイルの命名規則に一致する
//                              # 場合は自動的に対象外にする（tdd の自己参照を防ぐ）
//     absent_glob: 'glob'      # 任意。文字列または配列。project_dir 起点の glob で、
//                              # どれか1つでも存在すれば違反にしない（spec/ や tests/ など
//                              # 実装と別ツリーに置くテストを拾うため）。{stem} に加えて
//                              # {dir}（project_dir 相対ディレクトリ）も展開される。{stem} は
//                              # kebab-case/snake_case 両方の候補が展開される。
//                              # absent_sibling と併記した場合は OR で判定する
//
//   - event: post_edit         # PostToolUse(Edit|Write|MultiEdit) で、編集後のファイル全体を検査
//     path: 'glob'             # 必須。file_path（プロジェクト相対）にマッチ
//     exclude_path: 'glob'     # 任意。文字列または配列。マッチしたら検査対象外
//     when: '正規表現'          # 任意。編集後のファイル内容（ディスク上の全文）に対して（m フラグ）
//     unless: '正規表現'        # 任意。マッチすれば違反ではない
//     check: 'shell cmd'       # 任意。$FILE に絶対パス、cwd はそのファイルのルート。非0終了で違反
//                              # when と check の少なくとも一方が必要（どちらも無い要素は無視）。
//                              # 両方あれば AND（when がマッチし、かつ check が非0）
//     message: '...'
//     severity: block          # 任意。省略時は count から自動決定
//
//   - event: stop_check        # Stop 時、そのセッションの変更ファイルを検査
//     changed: 'glob'          # 必須。worktree 内のファイルは worktree ルート相対で判定する
//     check: 'shell cmd'       # 任意。$FILE に該当ファイルの絶対パスが入る。非0で違反。
//                              # cwd はそのファイルのルート（worktree 内なら worktree、それ以外は project_dir）
//     require_sibling: 'name'  # 任意。同ディレクトリにこのファイルが無ければ違反
//     message: '...'
//
// glob の解釈（* は / を跨がない、** は跨ぐ、{a,b} 展開）は gate と共通（glob.ts）。
//
// severity の自動決定（明示があればそれを優先）:
//   count >= 5   -> deny
//   count 3, 4   -> ask（pre_bash / pre_edit） / block（stop_check / post_edit）
//   count 1, 2   -> warn
//
// 有効期限と適用スコープ（frontmatter の任意キー。3つすべてを満たしたときだけルールが有効になる）
//
// expires: 2026-12-31        # 任意。この日付（YYYY-MM-DD ならその日の終わり。UTC）または ISO 8601 日時を
//                            # 過ぎたらルールは無効。パースできない値は無視（無期限扱い）
// projects: ['~/src/myorg/**']  # 任意。文字列または配列。プロジェクトディレクトリの絶対パスにマッチする glob。
//                            # 先頭の ~ は HOME に展開。1つでもマッチすれば適用。未指定・空なら制限なし
// when_exists: ['go.mod', '**/*.go']  # 任意。文字列または配列。プロジェクトルート相対の glob。
//                            # 1つでも存在すれば適用。未指定・空なら制限なし
//
// このフィルタは listRules を feedbackDirPath 省略で呼んだとき（グローバル＋プロジェクトのマージ後）にだけ
// かかる。ディレクトリを明示したときは無加工で返す。
import { asList, compileGlobs, expandBraces, globExists } from './glob.ts'
import type { Io } from './io.ts'
import { parseYaml } from './load-yaml.ts'
import { basename, dirname, isAbsolute, join, splitext } from './path.ts'
import { type Dict, isDict, pyRegExp, toCount, truthy } from './pyutil.ts'
import { splitRoot } from './roots.ts'

export type Rule = {
  name: string
  description: string
  count: number
  enforce: Dict[]
  path: string
  /** 有効期限（ミリ秒）。これより後は無効。未指定なら無期限。 */
  expires?: number
  /** プロジェクトディレクトリの絶対パスにマッチする glob（~ 展開前）。空なら制限なし。 */
  projects: string[]
  /** プロジェクトルート相対の glob。空なら制限なし。 */
  whenExists: string[]
}

export type Violation = {
  rule: string
  count: number
  severity: string
  event: string
  message: string
  detail: string
}

/** ~/.claude/feedback を返す。CLAUDE_FEEDBACK_DIR でテスト時に差し替え可能。 */
export function feedbackDir(io: Io): string {
  const override = io.env.CLAUDE_FEEDBACK_DIR
  if (override) return override
  return join(io.env.HOME || '~', '.claude', 'feedback')
}

/** プロジェクト固有の feedback ディレクトリ（<projectDir>/.claude/feedback）を返す。 */
export function projectFeedbackDir(io: Io, projectDir?: string): string {
  return join(projectDir || io.projectDir || io.cwd, '.claude', 'feedback')
}

export const violationsLogPath = (io: Io): string => join(feedbackDir(io), '.violations.jsonl')

// ---- frontmatter 読み込み ----
export const FRONTMATTER_RE = /^---\s*\n([\s\S]*?\n)---\s*\n?/
const BODY_STOP_RE = /\*\*(Why|言い訳|How to apply)[:：]?\*\*/

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

/** 1つの feedback ファイルから frontmatter を読む。frontmatter が無ければ null（rules.md はこれで黙ってスキップされる）。 */
export async function loadRule(io: Io, path: string): Promise<Rule | null> {
  const content = await io.readFile(path)
  if (content === undefined) return null
  const m = FRONTMATTER_RE.exec(content)
  if (!m) return null
  const data = loadYamlText(m[1] ?? '')
  if (!isDict(data) || !truthy(data.name)) return null
  return {
    name: String(data.name),
    description: truthy(data.description) ? String(data.description) : '',
    count: toCount(data.count),
    enforce: (truthy(data.enforce) ? data.enforce : []) as Dict[],
    path,
    expires: parseExpires(data.expires),
    projects: stringList(data.projects),
    whenExists: stringList(data.when_exists),
  }
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

/** ルール本文のうち、**Why:** / **言い訳:** / **How to apply:** より前の第1段落（最初の空行まで）を返す。 */
export async function loadBodyIntro(io: Io, path: string): Promise<string> {
  const content = await io.readFile(path)
  if (content === undefined) return ''
  const m = FRONTMATTER_RE.exec(content)
  const body = m ? content.slice(m[0].length) : content
  const stop = BODY_STOP_RE.exec(body)
  const lead = (stop ? body.slice(0, stop.index) : body).trim()
  if (!lead) return ''
  return (lead.split('\n\n')[0] ?? '').trim()
}

/** 1つのディレクトリ直下の *.md を名前順に走査し、frontmatter を持つものだけ返す。 */
async function listRulesIn(io: Io, d: string): Promise<Rule[]> {
  const rules: Rule[] = []
  const names = (await io.list(d)).map((e) => e.name).sort()
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const rule = await loadRule(io, join(d, name))
    if (rule) rules.push(rule)
  }
  return rules
}

/**
 * feedback ルールを全件読み、frontmatter を持つものだけ返す。
 * feedbackDirPath を明示したときはそのディレクトリだけを読む。省略時はグローバル (feedbackDir) と
 * プロジェクト (projectFeedbackDir) の両方を読んでマージし、同名 (name) のルールはプロジェクト側を優先する。
 * 返す順序はグローバル（上書きされたものを除く）→プロジェクト。
 * マージ後に isRuleActive で絞る（プロジェクト側の同名ルールが期限切れ・対象外のとき、グローバル側が復活しないように）。
 * feedbackDirPath を明示したときはフィルタせず無加工で返す。
 */
export async function listRules(io: Io, feedbackDirPath?: string): Promise<Rule[]> {
  if (feedbackDirPath) return listRulesIn(io, feedbackDirPath)
  const globalDir = feedbackDir(io)
  const projectDir = projectFeedbackDir(io)
  const globalRules = await listRulesIn(io, globalDir)
  // 両方が同じパスを指す場合は一度しか読まない
  let merged = globalRules
  if (projectDir !== globalDir) {
    const projectRules = await listRulesIn(io, projectDir)
    const overridden = new Set(projectRules.map((r) => r.name))
    merged = [...globalRules.filter((r) => !overridden.has(r.name)), ...projectRules]
  }
  const active: Rule[] = []
  for (const r of merged) if (await isRuleActive(io, r)) active.push(r)
  return active
}

// ---- severity 解決 ----
/** ルールに severity の明示があればそれを使い、無ければ count から決める。 */
export function resolveSeverity(count: unknown, explicit?: unknown, event?: string): string {
  if (truthy(explicit)) return String(explicit)
  const n = toCount(count)
  if (n >= 5) return 'deny'
  if (n >= 3) return event === 'stop_check' || event === 'post_edit' ? 'block' : 'ask'
  return 'warn'
}

// ---- 違反ログ ----
let logQueue: Promise<void> = Promise.resolve()

/**
 * ~/.claude/feedback/.violations.jsonl に1行 JSON を追記する。count 自体は絶対に書き換えない
 * （ログに残すのみ）。ログ失敗で hook を止めないよう例外は握りつぶす。
 */
export function logViolation(io: Io, rule: string, count: number, severity: string, event: string, detail: string): Promise<void> {
  const task = logQueue.then(async () => {
    try {
      const ts = new Date(await io.now()).toISOString().replace('Z', '+00:00')
      const entry = { ts, rule, count, severity, event, detail }
      const path = violationsLogPath(io)
      const existing = (await io.readFile(path)) ?? ''
      await io.writeFile(path, `${existing}${JSON.stringify(entry)}\n`)
    } catch {
      // ログ失敗で hook を止めない
    }
  })
  logQueue = task
  return task
}

// ---- pre_edit: テストファイル自身の自己参照を防ぐ ----
export function looksLikeTestFile(name: string): boolean {
  if (/_test\.go$/.test(name)) return true
  if (/\.(test|spec)\.tsx?$/.test(name)) return true
  if (/_(spec|test)\.rb$/.test(name)) return true
  if (/^test_.*\.py$/.test(name) || /_test\.py$/.test(name)) return true
  return false
}

/** kebab-case / snake_case の表記ゆれを吸収するため、stem 自身に加えて '-' <-> '_' を入れ替えた候補を返す。 */
export function stemVariants(stem: string): string[] {
  const variants = [stem]
  if (stem.includes('-')) {
    const alt = stem.replaceAll('-', '_')
    if (!variants.includes(alt)) variants.push(alt)
  }
  if (stem.includes('_')) {
    const alt = stem.replaceAll('_', '-')
    if (!variants.includes(alt)) variants.push(alt)
  }
  return variants
}

function stemBrace(stem: string): string {
  const variants = stemVariants(stem)
  return variants.length === 1 ? (variants[0] as string) : `{${variants.join(',')}}`
}

/** {stem} を kebab-case/snake_case 双方の候補に展開し、全候補の文字列を返す。 */
export function expandStem(pattern: string, path: string): string[] {
  const stem = splitext(basename(path))[0]
  return expandBraces(pattern.replaceAll('{stem}', stemBrace(stem)))
}

/** absent_glob の {stem} と {dir}（プロジェクト相対ディレクトリ）を展開する。呼び出し側で expandBraces にかける前提。 */
export function expandTestPattern(pattern: string, relPath: string): string {
  const stem = splitext(basename(relPath))[0]
  return pattern.replaceAll('{stem}', stemBrace(stem)).replaceAll('{dir}', dirname(relPath) || '.')
}

/** Edit/Write/MultiEdit の tool_input から検査対象の文字列を取り出す。 */
export function extractPreEditContent(toolName: string, toolInput: Dict): string {
  const s = (v: unknown): string => (truthy(v) ? String(v) : '')
  if (toolName === 'Write') return s(toolInput.content)
  if (toolName === 'Edit') return s(toolInput.new_string)
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : []
    return edits
      .filter(isDict)
      .map((e) => s(e.new_string))
      .join('\n')
  }
  return ''
}

const SHELL = ['sh', '-c']

// ---- enforce 評価: pre_bash ----
export async function evalPreBash(io: Io, rules: Rule[], command: string, projectDir?: string): Promise<Violation[]> {
  const dir = projectDir || io.projectDir || io.cwd
  const violations: Violation[] = []
  if (!command) return violations
  for (const rule of rules) {
    for (const entry of rule.enforce) {
      if (entry.event !== 'pre_bash') continue
      const when = entry.when
      if (!truthy(when) || !pyRegExp(String(when)).test(command)) continue
      const unless = entry.unless
      if (truthy(unless) && pyRegExp(String(unless)).test(command)) continue
      const checkCmd = entry.check
      if (truthy(checkCmd)) {
        io.progress?.(`[feedback-guard] 評価中: ${rule.name}`)
        const r = await io.run([...SHELL, String(checkCmd)], { cwd: dir, env: { CLAUDE_PROJECT_DIR: dir }, timeoutMs: 10_000 })
        // 非0終了で違反確定。0終了なら違反ではない。check 自体が動かせない場合は when 一致のみで違反扱いにする。
        if (r.exitCode === 0 && !r.timedOut && r.error === undefined) continue
      }
      violations.push({
        rule: rule.name,
        count: rule.count,
        severity: resolveSeverity(rule.count, entry.severity, 'pre_bash'),
        event: 'pre_bash',
        message: truthy(entry.message) ? String(entry.message) : '',
        detail: `command matched: ${String(when)}`,
      })
    }
  }
  return violations
}

// ---- enforce 評価: pre_edit ----
export async function evalPreEdit(io: Io, rules: Rule[], filePath: string, content: string, projectDir?: string): Promise<Violation[]> {
  const dir = projectDir || io.projectDir || io.cwd
  const [root, rel] = splitRoot(dir, filePath)
  const name = basename(filePath)
  const text = content || ''
  const violations: Violation[] = []
  for (const rule of rules) {
    for (const entry of rule.enforce) {
      if (entry.event !== 'pre_edit') continue
      const patterns = asList(entry.path)
      if (patterns.length === 0) continue
      if (!compileGlobs(patterns).some((rx) => rx.test(rel))) continue

      const exclPatterns = asList(entry.exclude_path)
      if (exclPatterns.length > 0 && compileGlobs(exclPatterns).some((rx) => rx.test(rel))) continue

      const absentSibling = entry.absent_sibling
      const absentGlobs = asList(entry.absent_glob)
      let detail: string
      if (truthy(absentSibling) || absentGlobs.length > 0) {
        if (looksLikeTestFile(name)) continue // テストファイル自身は対象外
        const candidates: string[] = []
        let found = false
        if (truthy(absentSibling)) {
          const sibNames = expandStem(String(absentSibling), filePath)
          candidates.push(...sibNames)
          for (const sib of sibNames) {
            if (await io.exists(join(dirname(filePath), sib))) {
              found = true
              break
            }
          }
        }
        for (const pat of absentGlobs) {
          if (found) break
          for (const expanded of expandBraces(expandTestPattern(pat, rel))) {
            candidates.push(expanded)
            if (await globExists(io, join(root, expanded))) {
              found = true
              break
            }
          }
        }
        if (found) continue
        detail = `missing test file: ${candidates.join(', ')}`
      } else {
        const when = entry.when
        if (!truthy(when) || !pyRegExp(String(when), 'm').test(text)) continue
        const unless = entry.unless
        if (truthy(unless) && pyRegExp(String(unless), 'm').test(text)) continue
        detail = `content matched: ${String(when)}`
      }
      violations.push({
        rule: rule.name,
        count: rule.count,
        severity: resolveSeverity(rule.count, entry.severity, 'pre_edit'),
        event: 'pre_edit',
        message: truthy(entry.message) ? String(entry.message) : '',
        detail,
      })
    }
  }
  return violations
}

// ---- enforce 評価: post_edit ----
/** 編集後のファイル（ディスク上の全文）を検査する。読めないファイルは対象外（違反なし）。 */
export async function evalPostEdit(io: Io, rules: Rule[], filePath: string, projectDir?: string): Promise<Violation[]> {
  const dir = projectDir || io.projectDir || io.cwd
  const [root, rel] = splitRoot(dir, filePath)
  const absPath = isAbsolute(filePath) ? filePath : join(dir, filePath)
  const violations: Violation[] = []
  let text: string | undefined
  for (const rule of rules) {
    for (const entry of rule.enforce) {
      if (entry.event !== 'post_edit') continue
      const patterns = asList(entry.path)
      if (patterns.length === 0) continue
      if (!compileGlobs(patterns).some((rx) => rx.test(rel))) continue

      const exclPatterns = asList(entry.exclude_path)
      if (exclPatterns.length > 0 && compileGlobs(exclPatterns).some((rx) => rx.test(rel))) continue

      // when / check のどちらも無い要素は無視する
      const when = entry.when
      const checkCmd = entry.check
      if (!truthy(when) && !truthy(checkCmd)) continue

      if (text === undefined) {
        text = await io.readFile(absPath)
        if (text === undefined) return violations
      }
      const details: string[] = []
      if (truthy(when)) {
        if (!pyRegExp(String(when), 'm').test(text)) continue
        const unless = entry.unless
        if (truthy(unless) && pyRegExp(String(unless), 'm').test(text)) continue
        details.push(`content matched: ${String(when)}`)
      }
      if (truthy(checkCmd)) {
        io.progress?.(`[feedback-post-edit] 検査中: ${rule.name} (${absPath})`)
        const r = await io.run([...SHELL, String(checkCmd)], { cwd: root, env: { CLAUDE_PROJECT_DIR: dir, FILE: absPath }, timeoutMs: 15_000 })
        // 非0終了（タイムアウト・実行不能を含む）で違反確定。0終了なら違反ではない。
        if (r.exitCode === 0 && !r.timedOut && r.error === undefined) continue
        details.push(`check failed: ${String(checkCmd)}`)
      }
      violations.push({
        rule: rule.name,
        count: rule.count,
        severity: resolveSeverity(rule.count, entry.severity, 'post_edit'),
        event: 'post_edit',
        message: truthy(entry.message) ? String(entry.message) : '',
        detail: details.join(', '),
      })
    }
  }
  return violations
}

// ---- enforce 評価: stop_check ----
async function readLines(io: Io, path: string): Promise<string[] | undefined> {
  const text = await io.readFile(path)
  if (text === undefined) return undefined
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

async function gitFallbackFiles(io: Io, cwd: string): Promise<string[]> {
  const files = new Set<string>()
  for (const args of [
    ['git', 'diff', '--name-only', 'HEAD'],
    ['git', 'ls-files', '--others', '--exclude-standard'],
  ]) {
    const r = await io.run(args, { cwd, timeoutMs: 10_000 })
    if (r.exitCode === 0 && !r.timedOut && r.error === undefined) {
      for (const l of r.stdout.split(/\r?\n/)) if (l.trim() !== '') files.add(l.trim())
    }
  }
  return [...files].sort()
}

/**
 * record-changes が書く changed_files.<state_id>.txt を優先して読む。このファイルは gate.yaml を持つ
 * プロジェクトでしか作られないため、無ければ git でフォールバックする。gate 側が成功時にメモを消費する
 * ため、フォールバック経路は必須。
 *
 * agentId 指定時（サブエージェントの Stop）は changed_files.<session>--<agent>.txt だけを読む。メモが
 * 無ければ、そのエージェントの worktree（.claude/worktrees/agent-<agentId>）があればそこを cwd に git
 * フォールバックし、worktree ルートを付けた絶対パスで返す。worktree が無ければ projectDir で git
 * フォールバックする。
 *
 * agentId 未指定（メインの Stop）は changed_files.<session>.txt に加え changed_files.<session>--*.txt を
 * 全部読んで順序を保ってマージ・重複排除する。メモが1つも無いときだけ projectDir で git フォールバックする。
 */
export async function getChangedFiles(io: Io, projectDir: string, sessionId: string, agentId?: string | null): Promise<string[]> {
  const claudeDir = join(projectDir, '.claude')
  const stateDir = join(claudeDir, '.gate-status')

  if (agentId) {
    const lines = await readLines(io, join(stateDir, `changed_files.${sessionId}--${agentId}.txt`))
    if (lines !== undefined) return lines
    const worktree = join(claudeDir, 'worktrees', `agent-${agentId}`)
    if ((await io.stat(worktree))?.kind === 'dir') {
      return (await gitFallbackFiles(io, worktree)).map((f) => join(worktree, f))
    }
    return gitFallbackFiles(io, projectDir)
  }

  const seen = new Set<string>()
  const merged: string[] = []
  let foundAny = false
  const add = (lines: string[]): void => {
    for (const l of lines) {
      if (!seen.has(l)) {
        seen.add(l)
        merged.push(l)
      }
    }
  }
  const plain = await readLines(io, join(stateDir, `changed_files.${sessionId}.txt`))
  if (plain !== undefined) {
    foundAny = true
    add(plain)
  }
  const prefix = `changed_files.${sessionId}--`
  const agentMemos = (await io.list(stateDir))
    .map((e) => e.name)
    .filter((n) => n.startsWith(prefix) && n.endsWith('.txt') && n.length >= prefix.length + 4)
    .sort()
  for (const name of agentMemos) {
    foundAny = true
    add((await readLines(io, join(stateDir, name))) ?? [])
  }
  if (foundAny) return merged
  return gitFallbackFiles(io, projectDir)
}

export async function evalStopCheck(io: Io, rules: Rule[], projectDir: string, changedFiles: string[]): Promise<Violation[]> {
  const keyed = changedFiles.map((f) => splitRoot(projectDir, f))
  const violations: Violation[] = []
  for (const rule of rules) {
    for (const entry of rule.enforce) {
      if (entry.event !== 'stop_check') continue
      const patterns = asList(entry.changed)
      if (patterns.length === 0) continue
      const rxs = compileGlobs(patterns)
      const matchedKeys = new Set<string>()
      for (const [root, rel] of keyed) if (rxs.some((rx) => rx.test(rel))) matchedKeys.add(`${root}\0${rel}`)
      const matched = [...matchedKeys].sort().map((k) => k.split('\0') as [string, string])
      if (matched.length === 0) continue

      const checkCmd = entry.check
      const requireSibling = entry.require_sibling
      const badFiles: string[] = []
      for (const [root, rel] of matched) {
        const absPath = join(root, rel)
        let bad = false
        if (truthy(requireSibling)) {
          const sibNames = expandStem(String(requireSibling), absPath)
          let any = false
          for (const sib of sibNames) {
            if (await io.exists(join(dirname(absPath), sib))) {
              any = true
              break
            }
          }
          if (!any) bad = true
        }
        if (truthy(checkCmd)) {
          io.progress?.(`[feedback-stop-check] 検査中: ${rule.name} (${absPath})`)
          const r = await io.run([...SHELL, String(checkCmd)], { cwd: root, env: { CLAUDE_PROJECT_DIR: projectDir, FILE: absPath }, timeoutMs: 15_000 })
          if (r.exitCode !== 0 || r.timedOut || r.error !== undefined) bad = true
        }
        if (bad) badFiles.push(root === projectDir ? rel : `${basename(root)}/${rel}`)
      }

      if (badFiles.length > 0) {
        violations.push({
          rule: rule.name,
          count: rule.count,
          severity: resolveSeverity(rule.count, entry.severity, 'stop_check'),
          event: 'stop_check',
          message: truthy(entry.message) ? String(entry.message) : '',
          detail: `changed files violating: ${badFiles.join(', ')}`,
        })
      }
    }
  }
  return violations
}
