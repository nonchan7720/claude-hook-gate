// Bash 経由で書き換えられたファイルを、変更ファイルのメモ（changed_files.<stateId>.txt）へ記録する。
// PreToolUse(Bash) で開始時刻を控え（bashStarted）、PostToolUse(Bash) で git が見ている変更・未追跡ファイルのうち
// mtime がコマンド開始以降のものだけを拾う（recordBashChanges）。git の履歴・作業ツリー操作（rebase / checkout など）で
// 動いたファイルは「変更」ではないので、そのコマンドは最初から記録対象外にする。
// PJ が .claude/gate.yaml を持つ場合のみ動く（オプトイン）。
//
// 開始時刻のファイル（bash_started.<session>--<tool_use_id>.json）は tool_use_id で引く。エンジンが classic.PreToolUse
// に渡すイベントにはエージェント ID が入らない（tool.call の入力に tool / tool_use_id を足した形で、agentId は落とされる）
// 一方、classic.PostToolUse は stdin JSON そのままで agent_id を持つ。状態 ID（<session>[--<agent>]）で引くと
// サブエージェントの中では両者が食い違って開始時刻が見つからず、Bash の変更が一切記録されなかった。tool_use_id は
// 両方のイベントに同じ値で入るので、これを鍵にする。変更の記録先（changed_files）は PostToolUse 側の状態 ID で決める。
import { type Io, ok, type ScriptResult } from './io.ts'
import { join } from './path.ts'
import { type Dict, isDict, jqStr } from './pyutil.ts'
import { stopTestGate } from './stop-test-gate.ts'

/** 記録しない git コマンド（履歴・作業ツリーを動かす操作）。 */
export const SKIP_COMMAND_RE = /\bgit\b[^|;&\n]*\b(rebase|checkout|switch|merge|pull|stash|reset|cherry-pick|revert|restore|clean|am|apply|worktree)\b/

// HFS+ の 1 秒粒度と時計ずれの余裕。
const MTIME_SLACK_MS = 2000

// コマンドが失敗すると PostToolUse は来ない（PostToolUseFailure になる）ので、開始時刻のファイルが残る。
// 次の Bash の開始時に、同じセッションの古いものを掃く。Bash ツールの最長（バックグラウンド 2h）より古ければ実行中ではない。
const STALE_STARTED_MS = 2 * 60 * 60 * 1000

const STATE_DIR = '.gate-status'

const stateIdOf = (payload: Dict): string => {
  const sessionId = jqStr(payload.session_id) || 'unknown'
  const agentId = jqStr(payload.agent_id)
  return agentId ? `${sessionId}--${agentId}` : sessionId
}

/** 開始時刻ファイルの鍵。tool_use_id があれば <session>--<tool_use_id>、無ければ従来どおり状態 ID。 */
const startedKey = (payload: Dict): string => {
  const toolUseId = jqStr(payload.tool_use_id).replace(/[^A-Za-z0-9_.-]/g, '_')
  if (toolUseId === '') return stateIdOf(payload)
  const sessionId = jqStr(payload.session_id) || 'unknown'
  return `${sessionId}--${toolUseId}`
}

const startedPath = (projectDir: string, payload: Dict): string => join(projectDir, '.claude', STATE_DIR, `bash_started.${startedKey(payload)}.json`)

/** PreToolUse(Bash): コマンド開始時刻を控える。常に ok() を返す。 */
export async function bashStarted(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    const projectDir = io.projectDir || io.cwd
    if (!(await io.exists(join(projectDir, '.claude', 'gate.yaml')))) return ok()
    const started = await io.now()
    await io.writeFile(startedPath(projectDir, payload), `${JSON.stringify({ tool_use_id: jqStr(payload.tool_use_id), started })}\n`)
    await sweepStale(io, projectDir, jqStr(payload.session_id) || 'unknown', started)
  } catch {
    // 追跡の失敗で作業を止めない。
  }
  return ok()
}

/** 同じセッションの bash_started.<session>--*.json のうち、STALE_STARTED_MS より古いものを消す。 */
async function sweepStale(io: Io, projectDir: string, sessionId: string, now: number): Promise<void> {
  const stateDir = join(projectDir, '.claude', STATE_DIR)
  const prefix = `bash_started.${sessionId}--`
  const stale = (await io.list(stateDir))
    .filter((e) => e.kind === 'file' && e.name.startsWith(prefix) && e.name.endsWith('.json') && e.mtimeMs < now - STALE_STARTED_MS)
    .map((e) => join(stateDir, e.name))
  if (stale.length > 0) await io.removeFiles(stale)
}

/** PostToolUse(Bash): このコマンドが書き換えたファイルを記録し、新たに記録した絶対パスを返す。 */
export async function recordBashChanges(io: Io, payload: Dict): Promise<string[]> {
  try {
    const projectDir = io.projectDir || io.cwd
    if (!(await io.exists(join(projectDir, '.claude', 'gate.yaml')))) return []

    const stateId = stateIdOf(payload)
    const startedFile = startedPath(projectDir, payload)
    const raw = await io.readFile(startedFile)
    if (raw === undefined) return []
    try {
      return await record(io, projectDir, stateId, raw, payload)
    } finally {
      await io.removeFiles([startedFile])
    }
  } catch {
    return []
  }
}

async function record(io: Io, projectDir: string, stateId: string, raw: string, payload: Dict): Promise<string[]> {
  let saved: unknown
  try {
    saved = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isDict(saved) || typeof saved.started !== 'number') return []
  // tool_use_id が食い違う開始時刻は、別のコマンドのものなので使わない。
  if (jqStr(saved.tool_use_id) !== jqStr(payload.tool_use_id)) return []

  const command = jqStr(isDict(payload.tool_input) ? payload.tool_input.command : undefined)
  if (SKIP_COMMAND_RE.test(command)) return []

  const cwd = jqStr(payload.cwd) || io.cwd
  const top = await io.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
  if (top.exitCode !== 0) return []
  const root = top.stdout.replace(/\n+$/, '')
  if (root === '') return []

  const listed = await io.run(['git', '-C', cwd, 'ls-files', '-z', '--modified', '--others', '--exclude-standard', '--full-name'], { timeoutMs: 10_000 })
  if (listed.exitCode !== 0) return []

  const threshold = saved.started - MTIME_SLACK_MS
  const stateDir = join(projectDir, '.claude', STATE_DIR)
  const picked: string[] = []
  for (const rel of new Set(listed.stdout.split('\0').filter((s) => s !== ''))) {
    const abs = join(root, rel)
    if (abs.startsWith(`${stateDir}/`) || rel.startsWith(`.claude/${STATE_DIR}/`)) continue
    const st = await io.stat(abs)
    if (st?.kind === 'file' && st.mtimeMs >= threshold) picked.push(abs)
  }
  if (picked.length === 0) return []

  const memo = join(stateDir, `changed_files.${stateId}.txt`)
  const existing = (await io.readFile(memo)) ?? ''
  const have = new Set(existing.split('\n'))
  const added = picked.filter((p) => !have.has(p))
  if (added.length > 0) await io.writeFile(memo, `${existing}${added.map((p) => `${p}\n`).join('')}`)
  return added
}

/** PostToolUse(Bash): 記録できたときだけ gate の rules フェーズを走らせる。 */
export async function bashChanges(io: Io, payload: Dict): Promise<ScriptResult> {
  const recorded = await recordBashChanges(io, payload)
  if (recorded.length === 0) return ok()
  return stopTestGate(io, 'rules', payload)
}
