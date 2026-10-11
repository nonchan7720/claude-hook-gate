// PostToolUse(Bash) hook: Bash が書き換えたファイル（src/bash-changes.ts が拾ったもの）を、Edit / Write と同じ
// feedback ルールの enforce で検査する。heredoc・python・sed -i などで書くと Edit / Write の hook が起動せず、
// post_edit / pre_edit の検査が抜けるのを塞ぐ。
//
// - post_edit: Edit / Write の PostToolUse（feedback-post-edit.ts）と同じく、書き換え後のファイル全体を評価する。
// - pre_edit: Bash では実行前に書かれる内容が分からないので PreToolUse では評価できない。代わりに実行後、
//   ファイルパスの条件（path / exclude_path / absent_sibling / absent_glob）と、このコマンドで書かれた内容
//   （when / unless）を同じ条件で評価する。書かれた内容は、git が追跡しているファイルなら HEAD との差分の追加行
//   （同じコマンドでコミット済みなら、開始以降のコミットの追加行）、追跡外のファイル（新規作成など）なら全文
//   （Write の content と同じ扱い）。既に書かれた後なので止められない: deny / ask は block（書いた内容を直させる）
//   にし、メッセージに「実行後に検知した」旨を添える。同じセッション・同じファイルで既に ask した（承認済みの）
//   ルールは、Edit と同じく warn に落とす。
//
// 複数ファイルの結果は 1 つにまとめる（block があれば全件を 1 つの reason に、warn は stderr に）。
// hook 自身のバグで作業を止めないよう、例外は必ず握りつぶして exit 0 にする（stderr に1行だけ出す）。
import { downgradeRepeatedAsks } from './feedback-guard.ts'
import { evalPostEdit, evalPreEdit, listRules, logViolation, type Rule, type Violation } from './feedback-rules.ts'
import { tr } from './i18n.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { basename, dirname, isAbsolute, join, relpath } from './path.ts'
import { type Dict, isDict, truthy } from './pyutil.ts'

const EVENTS = new Set(['post_edit', 'pre_edit'])

/** Bash の書き換えを追跡する価値のある（post_edit / pre_edit の enforce を持つ）ルールがあるか。 */
export const wantsBashEdits = (rules: Rule[]): boolean => rules.some((r) => r.enforce.some((e) => isDict(e) && EVENTS.has(String(e.event))))

const hasPreEditContent = (rules: Rule[]): boolean => rules.some((r) => r.enforce.some((e) => isDict(e) && e.event === 'pre_edit' && truthy(e.when)))

/** unified diff（-U0）から、hunk 内の追加行（先頭の + を除いたもの）だけを取り出す。 */
export function addedLines(diff: string): string[] {
  const out: string[] = []
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) inHunk = false
    else if (line.startsWith('@@')) inHunk = true
    else if (inHunk && line.startsWith('+')) out.push(line.slice(1))
  }
  return out
}

/**
 * このコマンドが file に書いた内容（pre_edit の when / unless の対象）。git が追跡していないファイル（新規作成、
 * git の外）は全文。追跡しているファイルは HEAD との差分の追加行、差分が無ければ threshold 以降のコミットの追加行。
 */
export async function writtenContent(io: Io, file: string, threshold: number): Promise<string> {
  const dir = dirname(file)
  const name = basename(file)
  const opts = { timeoutMs: 10_000 }
  const whole = async () => (await io.readFile(file)) ?? ''
  const tracked = await io.run(['git', '-C', dir, 'ls-files', '--error-unmatch', '--', name], opts)
  if (tracked.exitCode !== 0) return whole()
  const diff = await io.run(['git', '-C', dir, 'diff', '--no-color', '--no-ext-diff', '-U0', 'HEAD', '--', name], opts)
  if (diff.exitCode !== 0) return whole()
  let added = addedLines(diff.stdout)
  if (added.length === 0) {
    const since = `--since=@${Math.floor(threshold / 1000)}`
    const log = await io.run(['git', '-C', dir, 'log', since, '--no-merges', '-p', '--no-color', '--no-ext-diff', '-U0', '--format=', '--', name], opts)
    if (log.exitCode === 0) added = addedLines(log.stdout)
  }
  return added.join('\n')
}

/** 表示用のパス: projectDir 配下ならその相対パス。 */
const label = (projectDir: string, file: string): string => {
  if (!isAbsolute(file)) return file
  const rel = relpath(file, projectDir)
  return rel.startsWith('../') || rel === '..' ? file : rel
}

type Found = { file: string; v: Violation }

async function main(io: Io, payload: Dict, files: string[], threshold: number): Promise<ScriptResult> {
  const rules = await listRules(io)
  if (!wantsBashEdits(rules)) return ok()
  const projectDir = io.projectDir || io.cwd
  const needContent = hasPreEditContent(rules)

  const found: Found[] = []
  for (const file of [...files].sort()) {
    const abs = isAbsolute(file) ? file : join(projectDir, file)
    for (const v of await evalPostEdit(io, rules, abs)) found.push({ file: abs, v })
    const content = needContent ? await writtenContent(io, abs, threshold) : ''
    const pre = await evalPreEdit(io, rules, abs, content)
    if (pre.length === 0) continue
    await downgradeRepeatedAsks(io, pre, payload.session_id, { file_path: abs })
    for (const v of pre) found.push({ file: abs, v })
  }
  if (found.length === 0) return ok()

  for (const { v } of found) await logViolation(io, v.rule, v.count, v.severity, v.event, v.detail)

  const t = tr(io.lang)
  const tag = (v: Violation) => (v.event === 'pre_edit' ? '[feedback-guard]' : '[feedback-post-edit]')
  const after = (v: Violation) => (v.event === 'pre_edit' ? ` ${t('bashEdit.preEditAfter')}` : '')
  const warnings = found.filter(({ v }) => v.severity === 'warn')
  const blocking = found.filter(({ v }) => v.severity !== 'warn')

  let stderr = warnings.map(({ file, v }) => `${tag(v)} warn: ${v.rule} (count: ${v.count}): ${v.message} (${label(projectDir, file)})${after(v)}\n`).join('')
  if (blocking.length === 0) return ok('', stderr)

  const lines = blocking.map(({ file, v }) => `${tag(v)} ${v.rule} (count: ${v.count}): ${v.message} (${label(projectDir, file)}: ${v.detail})${after(v)}`)
  lines.unshift(t('bashEdit.header'))
  stderr += lines.map((l) => `${l}\n`).join('')
  return ok(`${JSON.stringify({ decision: 'block', reason: lines.join('\n') })}\n`, stderr)
}

/** Bash が書き換えた files を post_edit / pre_edit の enforce で検査する。threshold は書き換えを判定した mtime の下限。 */
export async function feedbackBashEdits(io: Io, payload: Dict, files: string[], threshold: number): Promise<ScriptResult> {
  try {
    return await main(io, payload, files, threshold)
  } catch (e) {
    // hook のバグで作業を止めない
    return ok('', `[feedback-bash-edit] internal error (ignored): ${e instanceof Error ? e.message : String(e)}\n`)
  }
}
