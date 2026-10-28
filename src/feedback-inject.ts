// UserPromptSubmit hook: count >= 3 の確定 feedback ルールをコンテキストに注入する。
// rules.md 自体は別に出力しているので（register.ts の loadRules）、ここでは出力しない。
//
// count 降順・同数なら name 昇順で並べ、各ルールは「■ <name> (これまで N 回指摘されています)」
// + description + 本文の第1段落を出力する。
//
// files を持つルール（ファイル種別にスコープされたルール）はここでは出さない。毎プロンプトに載せる代わりに、
// マッチするファイルを Read / Edit / Write した直後（PostToolUse）に feedback-file-inject.ts が注入する。
// その「このターンに注入済み」の状態はプロンプトごとに消す（長いターンや compaction の後でも次のプロンプトで
// 必ず届くように。1 ターンに同じルールは 1 回しか出ない）。
//
// 読めないルールファイル・捨てた enforce の要素があれば、その一覧（ファイルと理由）を先頭に出す（壊れたルールは
// 黙って無効になるので、LLM とユーザーが気づけるように）。
//
// hook 自身のバグで作業を止めないよう、例外は握りつぶして exit 0 にする（.errors.jsonl に残す）。
import { type BrokenRule, clearInjected, errorText, isFileScoped, loadBodyIntro, logError, type Rule, scanRules } from './feedback-rules.ts'
import { tr } from './i18n.ts'
import { type Io, ok, type ScriptResult } from './io.ts'

/** 1 ルール分の注入テキスト: タイトル + description + 本文の第 1 段落。 */
export async function formatFull(io: Io, rule: Rule): Promise<string> {
  const lines = [tr(io.lang)('inject.ruleTitle', { name: rule.name, count: rule.count }), rule.description]
  const intro = await loadBodyIntro(io, rule.path)
  if (intro) lines.push(intro)
  return lines.join('\n')
}

const byCountThenName = (a: Rule, b: Rule): number => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** count 降順・同数なら name 昇順で並べたルールのブロック（ヘッダ無し）。 */
export async function formatRules(io: Io, rules: Rule[]): Promise<string> {
  const blocks: string[] = []
  for (const r of [...rules].sort(byCountThenName)) blocks.push(await formatFull(io, r))
  return blocks.join('\n\n')
}

export async function buildOutput(io: Io, rules: Rule[]): Promise<string> {
  return tr(io.lang)('inject.header') + (await formatRules(io, rules))
}

/** 読めないルールの一覧（無ければ空文字）。 */
export function brokenRulesText(io: Io, broken: BrokenRule[]): string {
  if (broken.length === 0) return ''
  return [tr(io.lang)('inject.brokenRules'), ...broken.map((b) => `- ${b.path}: ${b.reason}`)].join('\n')
}

export async function feedbackInject(io: Io, sessionId?: string): Promise<ScriptResult> {
  try {
    // 新しいプロンプト: files 付きルールの「このターンに注入済み」を忘れる（次に触れたときにまた出す）。
    if (sessionId) await clearInjected(io, sessionId)
    const { rules: all, broken } = await scanRules(io)
    for (const b of broken) await logError(io, 'rules', b.reason, b.path)
    const rules = all.filter((r) => r.count >= 3 && !isFileScoped(r))
    const parts = [brokenRulesText(io, broken)]
    if (rules.length > 0) parts.push(await buildOutput(io, rules))
    const text = parts.filter((p) => p !== '').join('\n\n')
    return text === '' ? ok() : ok(text)
  } catch (e) {
    // hook のバグで作業を止めない
    await logError(io, 'feedback-inject', errorText(e))
    return ok('', `[feedback-inject] internal error (ignored): ${errorText(e)}\n`)
  }
}
