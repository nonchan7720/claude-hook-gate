// UserPromptSubmit hook: count >= 3 の確定 feedback ルールをコンテキストに注入する。
// rules.md 自体は別に出力しているので（register.ts の loadRules）、ここでは出力しない。
//
// count 降順・同数なら name 昇順で並べ、各ルールは「■ <name> (これまで N 回指摘されています)」
// + description + 本文の第1段落を出力する。
//
// 読めないルールファイル・捨てた enforce の要素があれば、その一覧（ファイルと理由）を先頭に出す（壊れたルールは
// 黙って無効になるので、LLM とユーザーが気づけるように）。
//
// hook 自身のバグで作業を止めないよう、例外は握りつぶして exit 0 にする（.errors.jsonl に残す）。
import { type BrokenRule, errorText, loadBodyIntro, logError, type Rule, scanRules } from './feedback-rules.ts'
import { tr } from './i18n.ts'
import { type Io, ok, type ScriptResult } from './io.ts'

async function formatFull(io: Io, rule: Rule): Promise<string> {
  const lines = [tr(io.lang)('inject.ruleTitle', { name: rule.name, count: rule.count }), rule.description]
  const intro = await loadBodyIntro(io, rule.path)
  if (intro) lines.push(intro)
  return lines.join('\n')
}

const byCountThenName = (a: Rule, b: Rule): number => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

export async function buildOutput(io: Io, rules: Rule[]): Promise<string> {
  const blocks: string[] = []
  for (const r of [...rules].sort(byCountThenName)) blocks.push(await formatFull(io, r))
  return tr(io.lang)('inject.header') + blocks.join('\n\n')
}

/** 読めないルールの一覧（無ければ空文字）。 */
export function brokenRulesText(io: Io, broken: BrokenRule[]): string {
  if (broken.length === 0) return ''
  return [tr(io.lang)('inject.brokenRules'), ...broken.map((b) => `- ${b.path}: ${b.reason}`)].join('\n')
}

export async function feedbackInject(io: Io): Promise<ScriptResult> {
  try {
    const { rules: all, broken } = await scanRules(io)
    for (const b of broken) await logError(io, 'rules', b.reason, b.path)
    const rules = all.filter((r) => r.count >= 3)
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
