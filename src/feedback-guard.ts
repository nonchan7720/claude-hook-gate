// PreToolUse hook: feedback ルールの enforce (pre_bash / pre_edit) を評価し、
// count に応じた強制力（deny / ask / warn）を適用する。
//
// - Bash: command を pre_bash の enforce と照合する。さらに、コマンドの文面から書き先と内容が分かる heredoc の書き込み
//   （`cat > path <<'EOF' ... EOF` など。bash-heredoc.ts）は、Write と同じく書き先と本文を pre_edit の enforce と照合する
//   （python / sed -i などの書き込みは実行前には分からないので、実行後に feedback-bash-edit.ts が検査する）。
//   同じコマンドで書く別のファイルが absent_sibling / absent_glob の候補なら（テストと実装を 1 つのコマンドで書く）、
//   実行後の検査と同じく違反にしない。
// - Edit / Write / MultiEdit: file_path と変更後の内容を pre_edit の enforce と照合する
//
// severity が deny/ask（block は防御的に deny 扱い）の違反があれば stdout に hookSpecificOutput を出して
// 該当ツール呼び出しを止める。warn のみなら stderr に書いて exit 0（ツールは実行させる）。違反が無ければ
// 何も出さず exit 0。
//
// hook 自身のバグで作業を止めないよう、例外は必ず握りつぶして exit 0 にする（stderr に1行だけ出し、~/.claude/feedback/.errors.jsonl に残す）。
import { heredocWrites } from './bash-heredoc.ts'
import {
  autoBumpCounts,
  countBumpNotes,
  errorText,
  evalPreBash,
  evalPreEdit,
  extractPreEditContent,
  feedbackDir,
  listRules,
  logError,
  logViolation,
  type Violation,
} from './feedback-rules.ts'
import { compileGlobs } from './glob.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { basename, dirname, join, relpath } from './path.ts'
import { type Dict, isDict, jqStr, truthy } from './pyutil.ts'
import { splitRoot } from './roots.ts'

const SEVERITY_ORDER: Record<string, number> = { warn: 0, ask: 1, block: 2, deny: 3 }

/** PreToolUse の permissionDecision は allow/deny/ask のみ。block は防御的に deny 扱い。 */
export const decisionFor = (severity: string): 'deny' | 'ask' => (severity === 'deny' || severity === 'block' ? 'deny' : 'ask')

/** 表示用のパス: projectDir 配下ならその相対パス。 */
const fileLabel = (projectDir: string, file: string): string => {
  const rel = relpath(file, projectDir)
  return rel.startsWith('../') || rel === '..' ? file : rel
}

/** 違反の 1 行。Bash の heredoc で複数ファイルを見るときは、どのファイルかが分かるようパスを添える。 */
export const reasonLine = (v: Violation, projectDir?: string): string =>
  `${v.rule} (count: ${v.count}): ${v.message}${v.file !== undefined && projectDir !== undefined ? ` (${fileLabel(projectDir, v.file)})` : ''}`

export const buildReason = (violations: Violation[], projectDir?: string): string => violations.map((v) => reasonLine(v, projectDir)).join('\n')

const MISSING_TEST = 'missing test file: '

/**
 * absent_sibling / absent_glob の違反のうち、同じコマンドで書く別のファイル（others）が候補に当たるものか。
 * 実行後の検査（feedback-bash-edit.ts）では「コマンドが終わった時点でテストがあればよい」ので、実行前の検査も同じ結果にする。
 */
export function coveredBySameCommand(v: Violation, file: string, others: string[], projectDir: string): boolean {
  if (!v.detail.startsWith(MISSING_TEST)) return false
  const [root] = splitRoot(projectDir, file)
  const candidates = v.detail.slice(MISSING_TEST.length).split(', ')
  const siblings = new Set(candidates.filter((c) => !c.includes('/')))
  const globs = compileGlobs(candidates)
  for (const other of others) {
    if (other === file) continue
    if (dirname(other) === dirname(file) && siblings.has(basename(other))) return true
    const [otherRoot, rel] = splitRoot(projectDir, other)
    if (otherRoot === root && globs.some((rx) => rx.test(rel))) return true
  }
  return false
}

export const askStatePath = (io: Io, sessionId: string): string => join(feedbackDir(io), '.ask_state', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.json`)

export async function loadAskedKeys(io: Io, sessionId: string): Promise<Set<string>> {
  try {
    const text = await io.readFile(askStatePath(io, sessionId))
    if (text === undefined) return new Set()
    const data: unknown = JSON.parse(text)
    if (isDict(data) && Array.isArray(data.asked)) return new Set(data.asked.map(String))
  } catch {
    // 壊れた状態ファイルは空扱い
  }
  return new Set()
}

export async function saveAskedKeys(io: Io, sessionId: string, askedKeys: Set<string>): Promise<void> {
  try {
    await io.writeFile(askStatePath(io, sessionId), JSON.stringify({ asked: [...askedKeys].sort() }))
  } catch {
    // 状態の保存失敗で hook を止めない
  }
}

export function askKey(v: Violation, toolInput: Dict): string {
  const target = v.event === 'pre_edit' ? (truthy(toolInput.file_path) ? String(toolInput.file_path) : '') : ''
  return `${v.rule}|${v.event}|${target}`
}

/** 同一セッション・同一対象で 2 回目以降の ask は warn に落とす。deny/block は対象外。 */
export async function downgradeRepeatedAsks(io: Io, violations: Violation[], sessionId: unknown, toolInput: Dict): Promise<void> {
  if (!truthy(sessionId)) return
  const sid = String(sessionId)
  const asked = await loadAskedKeys(io, sid)
  const newlyAsked = new Set<string>()
  for (const v of violations) {
    if (v.severity !== 'ask') continue
    const key = askKey(v, toolInput)
    if (asked.has(key)) v.severity = 'warn'
    else newlyAsked.add(key)
  }
  if (newlyAsked.size > 0) await saveAskedKeys(io, sid, new Set([...asked, ...newlyAsked]))
}

async function main(io: Io, payload: Dict): Promise<ScriptResult> {
  const toolName = truthy(payload.tool_name) ? String(payload.tool_name) : ''
  const toolInput = isDict(payload.tool_input) ? payload.tool_input : {}

  const rules = await listRules(io)
  const projectDir = io.projectDir || io.cwd
  let violations: Violation[]
  if (toolName === 'Bash') {
    const command = truthy(toolInput.command) ? String(toolInput.command) : ''
    violations = await evalPreBash(io, rules, command)
    await downgradeRepeatedAsks(io, violations, payload.session_id, toolInput)
    // heredoc の書き込みは Write と同じ pre_edit の検査を実行前に掛ける（ask の重複判定は Edit / Write と同じくファイルごと）
    const writes = heredocWrites(command, jqStr(payload.cwd) || io.cwd, io.env.HOME)
    const files = writes.map((w) => w.file)
    for (const w of writes) {
      const pre = (await evalPreEdit(io, rules, w.file, w.content)).filter((v) => !coveredBySameCommand(v, w.file, files, projectDir))
      for (const v of pre) v.file = w.file
      await downgradeRepeatedAsks(io, pre, payload.session_id, { file_path: w.file })
      violations.push(...pre)
    }
  } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    const filePath = truthy(toolInput.file_path) ? String(toolInput.file_path) : ''
    if (!filePath) return ok()
    violations = await evalPreEdit(io, rules, filePath, extractPreEditContent(toolName, toolInput))
    await downgradeRepeatedAsks(io, violations, payload.session_id, toolInput)
  } else {
    return ok()
  }

  if (violations.length === 0) return ok()

  for (const v of violations) await logViolation(io, v.rule, v.count, v.severity, v.event, v.detail)
  // 今回の判定は上げる前の count で行い、次回以降の強制力を上げる。
  const notes = countBumpNotes(io.lang, await autoBumpCounts(io, rules, violations, payload.session_id))

  const blocking = violations.filter((v) => v.severity !== 'warn')
  const warnings = violations.filter((v) => v.severity === 'warn')

  let stdout = ''
  if (blocking.length > 0) {
    const top = blocking.reduce((a, b) => ((SEVERITY_ORDER[b.severity] ?? 0) > (SEVERITY_ORDER[a.severity] ?? 0) ? b : a))
    stdout = `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decisionFor(top.severity),
        permissionDecisionReason: [buildReason(blocking, projectDir), ...notes].join('\n'),
      },
    })}\n`
  }
  const stderr = [...warnings.map((v) => `[feedback-guard] warn: ${reasonLine(v, projectDir)}`), ...notes].map((l) => `${l}\n`).join('')
  return ok(stdout, stderr)
}

export async function feedbackGuard(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await main(io, payload)
  } catch (e) {
    // hook のバグで作業を止めない（黙って全ルールが無効にならないよう .errors.jsonl に残す）
    await logError(io, 'feedback-guard', errorText(e))
    return ok('', `[feedback-guard] internal error (ignored): ${errorText(e)}\n`)
  }
}
