// 新しい feedback ルールファイルを作る前に、既存のルールを確認させる（PreToolUse。feedback-guard.ts から呼ぶ）。
//
// Write（と Bash の heredoc）で feedback のディレクトリ（グローバル ~/.claude/feedback/ とプロジェクトの .claude/feedback/）の
// 直下にまだ無い *.md を書こうとしたとき、既存のルールが 1 つでもあれば、セッション・ファイルごとに最初の 1 回だけ止めて
// 既存ルールの全件の一覧（ディレクトリごと。name / description が似ているものを先に、★ 付きで）を返す。同じ指摘のルールがあれば新しいファイルを作らず、
// そのルールの count を上げて本文を更新させるため（同じ内容のルールが別名で増えるのを防ぐ）。
// 該当するものが無ければ、同じ書き込みをもう一度すれば通す（2 回目は止めない）。
//
// セッション ID が無いとき（2 回目を通す判定ができない）、既存のルールが無いとき、状態ファイル（. 始まり）のときは何もしない。
import {
  FRONTMATTER_RE,
  feedbackDirs,
  loadNameSet,
  loadRule,
  loadYamlText,
  projectFeedbackDirs,
  type Rule,
  saveNameSet,
  sessionStatePath,
} from './feedback-rules.ts'
import { tr } from './i18n.ts'
import type { Io } from './io.ts'
import { basename, dirname, expandUser, join, normpath, splitext } from './path.ts'
import { isDict, truthy } from './pyutil.ts'

/** これ以上の similarityScore を「似ている」とする。 */
export const SIMILAR_MIN_SCORE = 2

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'when', 'not', 'use', 'feedback', 'rule', 'rules'])
const ASCII = /^[a-z0-9]+$/

/**
 * 似ているかを測るための語の集合。英数字の語は小文字の先頭 4 文字（tests / testing を test に寄せる簡単な語幹）、
 * それ以外の文字（日本語など）を含む語は 2 文字ずつの組（bigram）。3 文字未満の英数字の語とストップワードは捨てる。
 */
export function similarityTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (ASCII.test(word)) {
      if (word.length >= 3 && !STOPWORDS.has(word)) out.add(word.slice(0, 4))
      continue
    }
    const chars = [...word]
    if (chars.length === 1) out.add(word)
    for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`)
  }
  return out
}

/** 共通の語の数（英数字の語は 2、bigram は 1 として数える）。 */
export const similarityScore = (a: Set<string>, b: Set<string>): number => [...a].reduce((n, t) => n + (b.has(t) ? (ASCII.test(t) ? 2 : 1) : 0), 0)

/** 書こうとしている内容の frontmatter の name / description（読めなければ空）。 */
function draftText(content: string): string {
  try {
    const data = loadYamlText(FRONTMATTER_RE.exec(content)?.[1] ?? '')
    return isDict(data) ? [data.name, data.description].filter(truthy).map(String).join(' ') : ''
  } catch {
    return ''
  }
}

const stemOf = (path: string): string => splitext(basename(path))[0]

/** 一覧の 1 行（ディレクトリの見出しの下）。name がファイル名と違うときだけ name も出す。 */
function listLine(rule: Rule, similar: boolean): string {
  const fileName = basename(rule.path)
  const nameNote = rule.name === stemOf(rule.path) ? '' : `name: ${rule.name}, `
  return `  ${similar ? '★' : '-'} ${fileName} (${nameNote}count: ${rule.count})${rule.description ? `: ${rule.description}` : ''}`
}

export const newRuleStatePath = (io: Io, sessionId: string): string => sessionStatePath(io, '.new_rule_state', sessionId)

/**
 * filePath が feedback のディレクトリ直下の新しいルールファイルで、このセッションでまだ確認させていなければ、
 * 既存ルールの一覧と「既存ルールの更新を優先する」指示を返す（呼び出し側が deny する）。それ以外は undefined。
 */
export async function newRuleNotice(io: Io, filePath: string, content: string, sessionId: unknown): Promise<string | undefined> {
  if (!truthy(sessionId) || !filePath) return undefined
  const home = io.env.HOME
  const file = normpath(expandUser(filePath, home))
  const name = basename(file)
  if (!name.endsWith('.md') || name.startsWith('.')) return undefined
  const dirs = [...new Set([...feedbackDirs(io), ...projectFeedbackDirs(io)].map((d) => normpath(expandUser(d, home))))]
  if (!dirs.includes(dirname(file)) || (await io.exists(file))) return undefined
  // 期限切れ・対象外のルールも含める（同じ内容のルールを別名で作らせないため）。壊れたルールは feedback-inject / /correct が報告する。
  const rules: Rule[] = []
  for (const d of dirs) {
    for (const n of (await io.list(d)).map((e) => e.name).sort()) {
      if (!n.endsWith('.md') || n.startsWith('.')) continue
      const rule = await loadRule(io, join(d, n)).catch(() => null)
      if (rule) rules.push(rule)
    }
  }
  if (rules.length === 0) return undefined

  const statePath = newRuleStatePath(io, String(sessionId))
  const confirmed = await loadNameSet(io, statePath, 'confirmed')
  if (confirmed.has(file)) return undefined
  await saveNameSet(io, statePath, 'confirmed', confirmed.add(file))

  const draft = similarityTokens(`${stemOf(file)} ${draftText(content)}`)
  const scored = rules.map((rule, index) => ({
    rule,
    index,
    score: similarityScore(draft, similarityTokens(`${stemOf(rule.path)} ${rule.name} ${rule.description}`)),
  }))
  const t = tr(io.lang)
  const similar = scored.filter((s) => s.score >= SIMILAR_MIN_SCORE).length
  // 全件をディレクトリごとにまとめて出す（パスは見出しにして 1 行を短くする）。各ディレクトリの中は似ているものが先。
  const lines: string[] = []
  for (const d of dirs) {
    const inDir = scored.filter((s) => dirname(s.rule.path) === d).sort((a, b) => b.score - a.score || a.index - b.index)
    if (inDir.length === 0) continue
    lines.push(`${d}/`)
    // 語が 1 つも重ならない（明らかに似ていない）ものはファイル名だけを 1 行にまとめる（context を食わないように）。
    for (const { rule, score } of inDir) if (score > 0) lines.push(listLine(rule, score >= SIMILAR_MIN_SCORE))
    const unrelated = inDir.filter((s) => s.score === 0).map((s) => stemOf(s.rule.path))
    if (unrelated.length > 0) lines.push(`  ${t('newRule.unrelated', { n: unrelated.length })}${unrelated.join(', ')}`)
  }
  return [t('newRule.header', { file, n: similar }), ...lines, t('newRule.instruction')].join('\n')
}
