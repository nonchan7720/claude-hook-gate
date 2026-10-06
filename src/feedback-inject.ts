// UserPromptSubmit hook: count >= 3 の確定 feedback ルールをコンテキストに注入する。
// rules.md 自体は別に出力しているので（register.ts の loadRules）、ここでは出力しない。
//
// count 降順・同数なら name 昇順で並べ、各ルールは「■ <name> (これまで N 回指摘されています)」
// + description + 本文の第1段落を出力する。
//
// hook 自身のバグで作業を止めないよう、例外は握りつぶして exit 0 にする。
import { listRules, loadBodyIntro, type Rule } from './feedback-rules.ts'
import { type Io, ok, type ScriptResult } from './io.ts'

const HEADER = '# 確定フィードバックルール（count >= 3）\nこれらは繰り返し指摘された確定ルール。違反すると hook がブロックする。\n\n'

async function formatFull(io: Io, rule: Rule): Promise<string> {
  const lines = [`■ ${rule.name} (これまで ${rule.count} 回指摘されています)`, rule.description]
  const intro = await loadBodyIntro(io, rule.path)
  if (intro) lines.push(intro)
  return lines.join('\n')
}

const byCountThenName = (a: Rule, b: Rule): number => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

export async function buildOutput(io: Io, rules: Rule[]): Promise<string> {
  const blocks: string[] = []
  for (const r of [...rules].sort(byCountThenName)) blocks.push(await formatFull(io, r))
  return HEADER + blocks.join('\n\n')
}

export async function feedbackInject(io: Io): Promise<ScriptResult> {
  try {
    const rules = (await listRules(io)).filter((r) => r.count >= 3)
    if (rules.length === 0) return ok()
    return ok(await buildOutput(io, rules))
  } catch (e) {
    // hook のバグで作業を止めない
    return ok('', `[feedback-inject] internal error (ignored): ${e instanceof Error ? e.message : String(e)}\n`)
  }
}
