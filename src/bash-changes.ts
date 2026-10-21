// Bash 経由で書き換えられたファイルを、変更ファイルのメモ（changed_files.<stateId>.txt）へ記録する。
// PreToolUse(Bash) で開始時刻を控え（bashStarted）、PostToolUse(Bash) で git が見ている変更・未追跡ファイルのうち
// mtime がコマンド開始以降のものだけを拾う（recordBashChanges）。git の履歴・作業ツリー操作（rebase / checkout など）で
// 動いたファイルは「変更」ではないので、そのコマンドは最初から記録対象外にする。
// 見る作業ツリーは cwd のものと <projectDir>/.claude/worktrees/ 配下の worktree のうちコマンドに出てくるもので、同じコマンドの中で
// コミットされたファイルもコミット履歴から拾う（scanRoots / candidates）。
// 拾ったファイルは feedback の post_edit / pre_edit でも検査する（src/feedback-bash-edit.ts）。Edit / Write を使わず
// heredoc・python・sed -i などで書いても検査が抜けないようにするため。
//
// gate.yaml を持つ PJ（オプトイン）では、開始時刻を .claude/.gate-status/ に置き、拾ったファイルを変更ファイルのメモにも
// 記録して gate の rules フェーズを走らせる。gate.yaml の無い PJ では、post_edit / pre_edit の enforce を持つ有効な
// feedback ルールがあるときだけ追跡し、開始時刻は feedback 側の状態置き場（<feedbackDir>/.bash_started/。
// .ask_state と同じ流儀）に置く。gate を使っていない PJ の作業ツリーに状態ファイルを作らない（.gitignore されて
// いないので、`git add -A` で巻き込まれる）ため。メモ（changed_files）も書かない（gate の無い PJ の stop_check は
// git でフォールバックする）。
//
// 開始時刻のファイル（bash_started.<session>--<tool_use_id>.json）は tool_use_id で引く。エンジンが classic.PreToolUse
// に渡すイベントにはエージェント ID が入らない（tool.call の入力に tool / tool_use_id を足した形で、agentId は落とされる）
// 一方、classic.PostToolUse は stdin JSON そのままで agent_id を持つ。状態 ID（<session>[--<agent>]）で引くと
// サブエージェントの中では両者が食い違って開始時刻が見つからず、Bash の変更が一切記録されなかった。tool_use_id は
// 両方のイベントに同じ値で入るので、これを鍵にする。変更の記録先（changed_files）は PostToolUse 側の状態 ID で決める。

import { findGateYaml } from './config-dir.ts'
import { feedbackBashEdits, wantsBashEdits } from './feedback-bash-edit.ts'
import { feedbackDir, listRules } from './feedback-rules.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { join } from './path.ts'
import { type Dict, isDict, jqStr } from './pyutil.ts'
import { gateStatusDir } from './running-registry.ts'
import { stopTestGate } from './stop-test-gate.ts'

/**
 * 記録しない git コマンド（履歴・作業ツリーを動かす操作）。サブコマンドの位置（git と、-C <dir> / -c <k=v> /
 * --xxx などのグローバルオプションの直後）だけを見る。`git commit -m "fix checkout"` のようにメッセージや
 * 引数に語が入っただけのコマンドまで記録対象外にしないため。
 */
export const SKIP_COMMAND_RE =
  /\bgit(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*\s+(rebase|checkout|switch|merge|pull|stash|reset|cherry-pick|revert|restore|clean|am|apply|worktree)\b/

/**
 * 読むだけのコマンド（ファイルを書き換えられないもの）は変更検出の対象外にする。同じ作業ツリーで別のセッションが編集中だと、
 * このコマンドの間に書かれたファイルを「このコマンドの変更」として拾ってしまい、調査しかしていないセッションの gate が
 * 他人の変更で走る（そして同じコマンドの直列化で相手の実行を待つ）ため。判定は保守的: コマンドを `|` / `&&` / `||` / `;` /
 * 改行 / `&` / `$(` / バッククォート / `(` / `{` で区切り、各区切りの先頭の語（環境変数の代入と `command` / `builtin` /
 * `time` / `exec` は読み飛ばす）がすべて読むだけのものに限る。ファイルへのリダイレクト（`>`。`2>&1` と `/dev/null` 行きは除く）、
 * `find` の `-exec` / `-delete`、`sed` の `-i`、`sort` の `-o`、`awk` の `system(` などがあれば読むだけとはみなさない。
 * 分からないものは「書くかもしれない」側に倒す（検査が増える方向で、抜ける方向ではない）。
 */
const READ_ONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'tac',
  'nl',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'find',
  'fd',
  'fdfind',
  'sort',
  'uniq',
  'cut',
  'tr',
  'awk',
  'gawk',
  'mawk',
  'sed',
  'diff',
  'cmp',
  'comm',
  'stat',
  'file',
  'du',
  'df',
  'tree',
  'pwd',
  'echo',
  'printf',
  'which',
  'whereis',
  'type',
  'env',
  'printenv',
  'jq',
  'yq',
  'column',
  'od',
  'xxd',
  'hexdump',
  'strings',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'date',
  'uname',
  'id',
  'whoami',
  'hostname',
  'sleep',
  'rev',
  'fold',
  'paste',
  'join',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
  'cksum',
  'ps',
  'pgrep',
  'lsof',
  'man',
  'true',
  'false',
  ':',
  'test',
  '[',
  '[[',
  'cd',
  'pushd',
  'popd',
  'exit',
  'return',
  'export',
  'local',
  'set',
  'unset',
  'shift',
])
const READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'ls-files',
  'ls-tree',
  'grep',
  'rev-parse',
  'rev-list',
  'describe',
  'shortlog',
  'cat-file',
  'branch',
  'tag',
  'remote',
  'fetch',
  'reflog',
  'name-rev',
  'show-ref',
  'for-each-ref',
  'diff-tree',
  'var',
  'version',
  'help',
])
const READ_ONLY_GO = new Set(['env', 'version', 'list', 'doc'])
/** これが入っていれば書くかもしれない（どのコマンドでも）。 */
const WRITE_HINT_RE = /system\(|-exec\b|-execdir\b|-ok\b|-okdir\b|-delete\b|-fprint|--in-place|--output/
/** 許されるリダイレクト: 2>&1 や >/dev/null の類。これを消したあとに `>` が残れば、ファイルへ書いている。 */
const HARMLESS_REDIRECT_RE = /\d*>>?&\d+|\d*>>?\s*\/dev\/null/g
const SEGMENT_SPLIT_RE = /\|\|?|&&|;|\n|&|\$\(|`|<\(|\(|\{/
const LEADING_ASSIGN_RE = /^(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)*/
const WRAPPER_WORDS = new Set(['command', 'builtin', 'time', 'exec', 'nice'])

/** segment の語（空白区切り。引用符の中の空白までは見ない）。 */
const wordsOf = (segment: string): string[] =>
  segment
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')

/** 先頭の語から wrapper と環境変数の代入を外した語の列。 */
function commandWords(segment: string): string[] {
  let rest = segment.replace(LEADING_ASSIGN_RE, '')
  let words = wordsOf(rest)
  while (words.length > 0 && WRAPPER_WORDS.has(words[0] ?? '')) {
    rest = rest.replace(/^\s*\S+\s*/, '').replace(LEADING_ASSIGN_RE, '')
    words = wordsOf(rest)
  }
  return words
}

/** git / go の、グローバルオプションを飛ばした先のサブコマンド。 */
function subcommandOf(words: string[], valueOptions: Set<string>): string {
  for (let i = 1; i < words.length; i++) {
    const w = words[i] ?? ''
    if (valueOptions.has(w)) {
      i++
      continue
    }
    if (w.startsWith('-')) continue
    return w
  }
  return ''
}

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** command がファイルを書き換えないコマンドだけでできているか（保守的: 分からなければ false）。 */
export function isReadOnlyCommand(command: string): boolean {
  const text = command.replace(HARMLESS_REDIRECT_RE, ' ')
  if (text.includes('>') || WRITE_HINT_RE.test(text)) return false
  let any = false
  for (const segment of text.split(SEGMENT_SPLIT_RE)) {
    const words = commandWords(segment)
    if (words.length === 0) continue
    const name = (words[0] ?? '').replace(/^.*\//, '').replace(/[)}]+$/, '')
    if (name === '') continue
    any = true
    if (name === 'git') {
      if (!READ_ONLY_GIT.has(subcommandOf(words, GIT_VALUE_OPTIONS))) return false
      continue
    }
    if (name === 'go') {
      if (!READ_ONLY_GO.has(subcommandOf(words, new Set()))) return false
      continue
    }
    if (!READ_ONLY_COMMANDS.has(name)) return false
    if (name === 'sed' && words.some((w) => /^-[A-Za-z]*i/.test(w))) return false
    if (name === 'sort' && words.some((w) => /^-[A-Za-z]*o/.test(w))) return false
  }
  return any
}

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

const commandOf = (payload: Dict): string => jqStr(isDict(payload.tool_input) ? payload.tool_input.command : undefined)

const hasGate = async (io: Io, projectDir: string): Promise<boolean> => (await findGateYaml(io, projectDir)) !== undefined

/** 開始時刻ファイルを置くディレクトリ。gate.yaml があれば <設定ディレクトリ>/.gate-status/、無ければ <feedbackDir>/.bash_started/。 */
export const startedDir = (io: Io, _projectDir: string, gate: boolean): string => (gate ? gateStatusDir(io) : join(feedbackDir(io), '.bash_started'))

const startedPath = (dir: string, payload: Dict): string => join(dir, `bash_started.${startedKey(payload)}.json`)

/** PreToolUse(Bash): コマンド開始時刻を控える（追跡する必要のある PJ だけ）。常に ok() を返す。 */
export async function bashStarted(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    if (isReadOnlyCommand(commandOf(payload))) return ok()
    const projectDir = io.projectDir || io.cwd
    const gate = await hasGate(io, projectDir)
    if (!gate && !wantsBashEdits(await listRules(io))) return ok()
    const dir = startedDir(io, projectDir, gate)
    const started = await io.now()
    await io.writeFile(startedPath(dir, payload), `${JSON.stringify({ tool_use_id: jqStr(payload.tool_use_id), started })}\n`)
    await sweepStale(io, dir, jqStr(payload.session_id) || 'unknown', started)
  } catch {
    // 追跡の失敗で作業を止めない。
  }
  return ok()
}

/** 同じセッションの bash_started.<session>--*.json のうち、STALE_STARTED_MS より古いものを消す。 */
async function sweepStale(io: Io, stateDir: string, sessionId: string, now: number): Promise<void> {
  const prefix = `bash_started.${sessionId}--`
  const stale = (await io.list(stateDir))
    .filter((e) => e.kind === 'file' && e.name.startsWith(prefix) && e.name.endsWith('.json') && e.mtimeMs < now - STALE_STARTED_MS)
    .map((e) => join(stateDir, e.name))
  if (stale.length > 0) await io.removeFiles(stale)
}

/**
 * Bash が書き換えたファイル。changed はこのコマンドが書き換えた全ファイル（絶対パス、feedback の検査対象）、
 * recorded はそのうち変更ファイルのメモに新たに記録したもの（gate.yaml がある PJ だけ。rules フェーズの要否に使う）。
 * threshold は書き換えを判定した mtime の下限（ミリ秒）。
 */
export type BashChanges = { changed: string[]; recorded: string[]; threshold: number; gate: boolean }

const NONE: BashChanges = { changed: [], recorded: [], threshold: 0, gate: false }

/** PostToolUse(Bash): このコマンドが書き換えたファイルを拾い、gate.yaml があれば変更ファイルのメモに記録する。 */
export async function detectBashChanges(io: Io, payload: Dict): Promise<BashChanges> {
  try {
    const projectDir = io.projectDir || io.cwd
    const gate = await hasGate(io, projectDir)
    const dir = startedDir(io, projectDir, gate)
    const startedFile = startedPath(dir, payload)
    const raw = await io.readFile(startedFile)
    if (raw === undefined) return NONE
    try {
      return await detect(io, projectDir, gate, dir, raw, payload)
    } finally {
      await io.removeFiles([startedFile])
    }
  } catch {
    return NONE
  }
}

/** PostToolUse(Bash): このコマンドが書き換えたファイルを記録し、新たに記録した絶対パスを返す（gate.yaml が無ければ常に空）。 */
export async function recordBashChanges(io: Io, payload: Dict): Promise<string[]> {
  return (await detectBashChanges(io, payload)).recorded
}

async function detect(io: Io, projectDir: string, gate: boolean, startedDirPath: string, raw: string, payload: Dict): Promise<BashChanges> {
  let saved: unknown
  try {
    saved = JSON.parse(raw)
  } catch {
    return NONE
  }
  if (!isDict(saved) || typeof saved.started !== 'number') return NONE
  // tool_use_id が食い違う開始時刻は、別のコマンドのものなので使わない。
  if (jqStr(saved.tool_use_id) !== jqStr(payload.tool_use_id)) return NONE

  const command = commandOf(payload)
  if (SKIP_COMMAND_RE.test(command) || isReadOnlyCommand(command)) return NONE

  const threshold = saved.started - MTIME_SLACK_MS
  const stateDir = gateStatusDir(io)
  const foreign = gate ? await filesOfOtherSessions(io, stateDir, jqStr(payload.session_id) || 'unknown') : new Set<string>()
  const picked = new Set<string>()
  for (const root of await scanRoots(io, projectDir, jqStr(payload.cwd) || io.cwd, command)) {
    for (const rel of await candidates(io, root, threshold)) {
      const abs = join(root, rel)
      if (abs.startsWith(`${stateDir}/`) || abs.startsWith(`${startedDirPath}/`) || rel.startsWith(`.claude/${STATE_DIR}/`)) continue
      if (foreign.has(abs)) continue
      const st = await io.stat(abs)
      if (st?.kind === 'file' && st.mtimeMs >= threshold) picked.add(abs)
    }
  }
  const changed = [...picked]
  if (changed.length === 0 || !gate) return { changed, recorded: [], threshold, gate }

  const memo = join(stateDir, `changed_files.${stateIdOf(payload)}.txt`)
  const existing = (await io.readFile(memo)) ?? ''
  const have = new Set(existing.split('\n'))
  const recorded = changed.filter((p) => !have.has(p))
  if (recorded.length > 0) await io.writeFile(memo, `${existing}${recorded.map((p) => `${p}\n`).join('')}`)
  return { changed, recorded, threshold, gate }
}

const OTHER_STATE_RE = /^(?:changed_files|gate_passed|gate_failed)\.(.+)\.txt$/

/**
 * 同じ作業ツリーで動く他のセッションが自分の変更として持っているファイル（changed_files / gate_passed / gate_failed の
 * <session>[--<agent>] が自分のセッションでないもの）。このコマンドの間に mtime が動いていても、それは相手の編集なので
 * 拾わない。相手の gate がそのファイルを検査する。自分のセッションのサブエージェント分は従来どおり拾う。
 */
async function filesOfOtherSessions(io: Io, stateDir: string, sessionId: string): Promise<Set<string>> {
  const out = new Set<string>()
  for (const e of await io.list(stateDir)) {
    const m = e.kind === 'file' ? OTHER_STATE_RE.exec(e.name) : null
    if (m === null) continue
    const id = m[1] ?? ''
    if (id === sessionId || id.startsWith(`${sessionId}--`)) continue
    for (const line of ((await io.readFile(join(stateDir, e.name))) ?? '').split('\n')) if (line !== '') out.add(line)
  }
  return out
}

const gitTop = async (io: Io, dir: string): Promise<string> => {
  const top = await io.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
  return top.exitCode === 0 ? top.stdout.replace(/\n+$/, '') : ''
}

/** command が worktree <name> を指しているか（`.claude/worktrees/<name>` を含み、その後に名前が続かない）。 */
export const mentionsWorktree = (command: string, name: string): boolean => {
  const needle = `worktrees/${name}`
  for (let i = command.indexOf(needle); i >= 0; i = command.indexOf(needle, i + 1)) {
    const next = command.charAt(i + needle.length)
    if (!/[A-Za-z0-9._-]/.test(next)) return true
  }
  return false
}

/**
 * 変更を探す git の作業ツリー: cwd の作業ツリーと、<projectDir>/.claude/worktrees/ 直下の worktree のうちコマンドに
 * パスが出てくるもの。worktree は .git を持つ入れ子の作業ツリーなので、外側から ls-files しても "<name>/" の 1 行に
 * しかならない。cwd が本体のまま worktree のファイルを書き換えるコマンド（絶対パスへの heredoc など）を拾うため、個別に見る。
 * コマンドに出てこない worktree は見ない。別のセッション（やエージェント）がその worktree で編集中だと、このコマンドの
 * 間に書かれたファイルとして拾ってしまい、他人の書きかけ（Red のテストなど）で自分の gate が落ちるため。
 */
async function scanRoots(io: Io, projectDir: string, cwd: string, command: string): Promise<string[]> {
  const roots: string[] = []
  const add = (top: string) => {
    if (top !== '' && !roots.includes(top)) roots.push(top)
  }
  add(await gitTop(io, cwd))
  const worktreesDir = join(projectDir, '.claude', 'worktrees')
  for (const e of await io.list(worktreesDir)) {
    if (e.kind === 'dir' && mentionsWorktree(command, e.name)) add(await gitTop(io, join(worktreesDir, e.name)))
  }
  return roots
}

/**
 * root で変更の候補になるルート相対パス: 変更・未追跡のファイルと、threshold 以降のコミットが触ったファイル。
 * 書いてそのまま同じコマンドで git commit すると作業ツリーには何も残らないので、コミット側も見る。
 * どちらも最後に mtime で絞るので、他の作業のコミットが混ざっても、このコマンドの間に書かれていなければ落ちる。
 */
async function candidates(io: Io, root: string, threshold: number): Promise<string[]> {
  const out = new Set<string>()
  const listed = await io.run(['git', '-C', root, 'ls-files', '-z', '--modified', '--others', '--exclude-standard', '--full-name'], { timeoutMs: 10_000 })
  if (listed.exitCode === 0) for (const s of listed.stdout.split('\0')) if (s !== '' && !s.endsWith('/')) out.add(s)
  const since = `--since=@${Math.floor(threshold / 1000)}`
  const logged = await io.run(['git', '-C', root, 'log', since, '--no-merges', '--name-only', '-z', '--format=', 'HEAD'], { timeoutMs: 10_000 })
  if (logged.exitCode === 0) for (const s of logged.stdout.split(/[\0\n]/)) if (s !== '') out.add(s)
  return [...out]
}

/**
 * PostToolUse(Bash) の各段。register.ts はこれを順に runSteps へ渡し、結果（block / warn）をまとめる:
 * 書き換えたファイルを拾う → それぞれを feedback の post_edit / pre_edit で検査する → メモに記録できたときだけ
 * gate の rules フェーズを走らせる。Edit / Write の PostToolUse（recordChanges → feedbackPostEdit → rules）と同じ並び。
 */
export function bashChangeSteps(payload: Dict): Array<(io: Io) => Promise<ScriptResult>> {
  let found: BashChanges = NONE
  return [
    async (io) => {
      found = await detectBashChanges(io, payload)
      return ok()
    },
    (io) => (found.changed.length > 0 ? feedbackBashEdits(io, payload, found.changed, found.threshold) : Promise.resolve(ok())),
    (io) => (found.recorded.length > 0 ? stopTestGate(io, 'rules', payload) : Promise.resolve(ok())),
  ]
}

/** PostToolUse(Bash): bashChangeSteps を 1 つの結果にまとめて返す（テスト・単体呼び出し用。block は先のものが勝つ）。 */
export async function bashChanges(io: Io, payload: Dict): Promise<ScriptResult> {
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  for (const step of bashChangeSteps(payload)) {
    const r = await step(io)
    stderr += r.stderr
    if (exitCode === 0 && r.exitCode !== 0) exitCode = r.exitCode
    if (stdout.trim() === '' && r.stdout.trim() !== '') stdout = r.stdout
  }
  return { exitCode, stdout, stderr }
}
