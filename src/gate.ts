// gate hook 本体。PostToolUse（rules フェーズ）と Stop / SubagentStop（checks フェーズ）の両方から
// 呼ばれ、gate.yaml の glob ルールに従って変更ファイルに対応するコマンドを実行する。
//
// 二相構造:
//   - rules フェーズ（PostToolUse、phase=rules）: マッチしたルールの run だけを実行する。ブロックしない
//     （PostToolUse の exit 2 はツール実行後の stderr フィードバックであり、会話は止まらない）。マッチした
//     ルールが run_checks で参照した consistency_checks の名前を、checks フェーズが後で実行するための
//     「予約」として永続化する。
//   - checks フェーズ（Stop / SubagentStop、phase=checks、デフォルト）: 予約された consistency_checks
//     だけを実行する。rules は実行しない。失敗なら exit 2 で会話の終了をブロックし、MAX_ATTEMPTS で
//     打ち切る。
//
// 予約が空（何も rules フェーズでマッチしなかった）なら checks フェーズは即 exit 0。run_checks を持たない
// ルールで通ったファイルは、それ以上待つものが無いので rules フェーズの時点で完了扱いになり、CHANGED
// からも SIDECAR からも外れる。以後そのファイルが別の変更で壊れても検出されない（run_checks がパッケージ
// 跨ぎ検証の唯一の手段）。
//
// 状態ファイル（CHANGED/COUNT/SIDECAR/PENDING/ログディレクトリ）の ID は、agentId があれば
// "<session_id>--<agent_id>"、無ければ session_id そのもの。changed_files の各行は実パスが
// <projectDir>/.claude/worktrees/<name>/ 配下ならそのディレクトリを「ルート」として扱い、ルートごとに cwd と
// そのルート自身の .claude/gate.yaml（無ければメインの cfg にフォールバック）で独立にチェックする。
// worktree が既に消えている場合は警告して対象から外す。予約（PENDING）もルート単位で持つ（あるルートの
// rule がマッチして予約した check を、別のルートで実行してはいけない）。
//
// rule は通ったが consistency_checks の確認待ちのファイルは changed_files から間引き
// gate_passed.<state_id>.txt (SIDECAR) へ退避する。checks フェーズで対応する consistency_checks が全て
// 成功したら SIDECAR から確定除去する。失敗し MAX_ATTEMPTS で諦めたときは、黙って確認済み扱いにはせず
// CHANGED へ戻す（次の編集で rules フェーズが再度拾えるようにするため）。
//
// gate.yaml の書式（scripts/gate.schema.json も参照）:
//
// match:       glob（文字列 or リスト）。* は / を跨がない、** は跨ぐ、{a,b} 展開可。
// dir:         コマンドを実行する作業ディレクトリ（省略時はプロジェクトルート）。
//              per_file_dir が設定されているときは無視される。
// per_file_dir: dir を無視し、match にマッチした各ファイルからルートを決めて、ルートごとに run を実行する
//              （ルート単位で重複排除、実行順はルート名の昇順）。値は true / "file" / "pattern_root" の
//              いずれか（true は "file" の別名）。
//              - "file"（true と同義）: マッチした各ファイル自身のディレクトリをルートにする。match の
//                パターン文字列（** の位置）は一切見ない。ディレクトリ＝パッケージという構成（Go の1ディレクトリ
//                1パッケージなど）向け。
//              - "pattern_root": マッチしたパターンの最初の ** セグメントの直前までに対応する実パス部分を
//                ルートにする（** を含まないパターンではファイル自身の dirname にフォールバック）。
//                ネストした階層のファイルを触っても package.json / pyproject.toml があるパッケージルートで
//                まとめて実行したい構成（pnpm workspace 等）向け。
//              上記以外の値（false・未設定を含む）は per_file_dir を使わない指定として扱われるが、
//              true/false のいずれでもない不正な文字列が指定された場合はルールをスキップした上で rules
//              フェーズを失敗扱いにする（黙って無視しない）。
// run:         マッチしたとき実行するコマンド列。1つでも非0なら失敗＝rules フェーズでは stderr 通知（会話は
//              止めない）、checks フェーズでは停止をブロック。各要素は文字列、{cmd, name, timeout} 形式、
//              または {parallel: [...]} 形式。timeout はそのコマンドのタイムアウト秒数（省略時 300 秒）。
//              超過したら強制終了して失敗扱い。rule / consistency_check レベルの timeout: はデフォルト値になる。
//              name はログファイル名に使う識別名（省略時は cmd から生成）。
// CLAUDE_GATE_FILES:
//              run / consistency_checks の各コマンドには、そのとき対象になっているファイルのルート相対
//              パスが環境変数 CLAUDE_GATE_FILES で渡る。値は shlex 引用済み・重複排除・昇順で、空白区切りの
//              1行。パスに空白が無ければ `cmd $CLAUDE_GATE_FILES` で渡せる。空白を含みうるなら
//              `eval "set -- $CLAUDE_GATE_FILES"` で位置パラメータに戻して使う。
// parallel:    run の要素として {parallel: [文字列 or {cmd, timeout}, ...]} を書くと、その中のコマンドは
//              並行実行される（全て完了してから次の要素へ進む）。parallel の中に parallel はネストできない
//              （失敗扱い）。
// policy:      dogwood のポリシーファイル（.dw）のパス。トップレベルに書くと全ルール / 全
//              consistency_checks の既定値になり、rules[] / consistency_checks[] 側に書くとそのルールだけ
//              上書きする。root_dir（projectDir または worktree ルート）からの相対パス（絶対パスと ~ 展開も
//              可）。設定されている間は run の各コマンドを実行前に dogwood replay で判定し、deny なら実行せず
//              控えに積む。スキップは失敗ではない。未設定なら同梱の既定ポリシー scripts/dogwood/gate.default.dw
//              が適用される。false を書くと判定せず従来どおり毎回実行する。パスを明示したのにそのファイルが
//              存在しない場合は、既定へフォールバックせず判定を無効にしてログを出す（設定ミスを黙って
//              埋めないため）。ポリシーはあるのに replay が非0・出力が壊れている場合、そのコマンドは実行せず
//              控えに積む。dogwood が見つからない場合も同じだが、既定ポリシー（policy: を書いていない）の
//              ときだけは従来どおり実行する。
// policy_schema: policy の検証に使う Cedar スキーマ（.cedarschema）のパス。省略時は同梱の
//              scripts/dogwood/gate.cedarschema。ポリシーに渡る入力は name と cmd の2つだけ。
//
// ポリシー判定の実行履歴は ${projectDir}/.claude/.gate-status/gate_trace.{state_id}.jsonl に、スキップした
// コマンドの控えは同じ場所の gate_deferred.{state_id}.json に溜まる。控えは rules フェーズで allow された
// コマンドが1つでも実行された回に、ポリシー判定をバイパスして消化される。ただし消化されるのはその回が
// 始まる前から控えにあった分だけ。checks フェーズ（Stop / SubagentStop）では、その回が始まる前から
// あった控えを全件消化し、失敗した分は控えに戻して停止をブロックする。各プロジェクトの .gitignore には
// .claude/.gate-status/ を足すこと。
//
// 各コマンドの出力は ${projectDir}/.claude/.gate-status/logs/{state_id}/{name もしくは cmd}.{uid}.log に
// 書き出される（コマンドの完了時にまとめて。実行中の開始行だけは先に書く）。フック起動時に自動削除:
// 現セッションのログは1時間（LOG_MAX_AGE）超で、過去セッションのログは最終書き込みから5分
// （LOG_STALE_GRACE）超で消える。
// run_checks:  このルールがマッチしたとき、rules フェーズが checks フェーズへ予約する consistency_checks の
//              名前一覧。実際に実行されるのは checks フェーズで、マッチしたルールが参照した名前だけが動く。
// consistency_checks: name/dir/run を持つ名前付きチェック定義集（match は持たない）。checks フェーズでしか
//              実行されない。
import { matchPatterns, type PatternPair } from './glob.ts'
import type { Io, ScriptResult } from './io.ts'
import { parseYaml } from './load-yaml.ts'
import { basename, dirname, expandUser, isAbsolute, join, normpath, relpath } from './path.ts'
import { type Dict, isDict, pyRepr, truthy } from './pyutil.ts'
import { splitRoot as splitRootOf } from './roots.ts'
import { shellQuote, shellSplit } from './shell.ts'
import { which } from './which.ts'

// ---- 定数 ----
export const MAX_ATTEMPTS = 5
export const DEFAULT_TIMEOUT = 300 // 秒。rule / consistency_check の timeout: で上書き可
export const LOG_MAX_AGE = 3600 // 秒。現セッションのログでもこれより古ければ削除
export const LOG_STALE_GRACE = 300 // 秒。他セッションのログは最終書き込みからこれだけ経てば削除
export const TRACE_WINDOW = 86400 // 秒。dogwood の時間窓の上限（既定 24h）を超えた履歴は判定に使えない
export const POLICY_TIMEOUT = 30 // 秒。dogwood replay 自体のタイムアウト
export const FILES_ENV_KEY = 'CLAUDE_GATE_FILES' // run のコマンドへ「今回 match した対象ファイル」を渡す環境変数名
const DOGWOOD_FALLBACKS = ['~/.cargo/bin/dogwood', '~/.local/share/mise/shims/dogwood']
const GATE_PRINCIPAL = 'Gate::Agent::"gate"'
const STATUS_CMD_MAX = 100 // 文字。1 行ログに載せるコマンドの最大長
const FAIL_TAIL_LINES = 60 // 失敗コマンド1本あたりに載せる出力の末尾行数
const FAIL_DETAIL_MAX = 12000 // 失敗詳細全体の最大文字数
const UNMATCHED_SHOWN = 5 // どのルールにもマッチしなかったファイルを 1 行に列挙する最大数
const MAX_TIMEOUT_MS = 600_000 // $.process.run の上限（10 分）

// ---- 設定の型（YAML はユーザー入力なので、実行時は緩く扱う） ----
export type RunItem = string | { cmd?: string; name?: string; timeout?: number } | { parallel?: RunItem[] }
type Setting = { policy?: unknown; policy_schema?: unknown }
export type GateRule = Setting & {
  match?: unknown
  dir?: string
  per_file_dir?: unknown
  run?: RunItem[]
  run_checks?: string[]
  timeout?: number
}
export type GateCheck = Setting & { name: string; dir?: string; run?: RunItem[]; timeout?: number }
export type GateConfig = Setting & { rules?: GateRule[]; consistency_checks?: GateCheck[] }
type Key = string // `${root}\0${rel}`
type Env = Record<string, string>
type Pending = Record<string, Record<string, string[]>>
type Entry = Dict & { root?: string; cwd?: string; name?: string; cmd?: string; timeout?: number; label?: string; env?: Env }

const mk = (root: string, rel: string): Key => `${root}\0${rel}`
const unmk = (k: Key): [string, string] => {
  const i = k.indexOf('\0')
  return [k.slice(0, i), k.slice(i + 1)]
}
const sortedKeys = (s: Iterable<Key>): Key[] => [...s].sort()

// ---- 純粋関数（glob とルート抽出） ----
export function normalizePerFileDirMode(value: unknown): 'file' | 'pattern_root' | null {
  if (value === true || value === 'file') return 'file'
  if (value === 'pattern_root') return 'pattern_root'
  return null
}

/** per_file_dir: "file"（true の別名）のときの実行ルート。マッチしたファイル自身のディレクトリ。 */
export const fileRoot = (relPath: string): string => dirname(relPath)

/** pattern を "/" で区切ったとき、最初に現れる ** 単独セグメントの位置（0始まり）。無ければ null。 */
export function patternRootSegmentCount(pattern: string): number | null {
  const segs = pattern.split('/')
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as string
    if (seg.length >= 2 && /^\*+$/.test(seg)) return i
  }
  return null
}

/** per_file_dir: "pattern_root" のときの実行ルート。最初の ** セグメントの直前までのパス部分。 */
export function globMatchRoot(pattern: string, relPath: string): string {
  const idx = patternRootSegmentCount(pattern)
  if (idx === null) return dirname(relPath)
  return relPath.split('/').slice(0, idx).join('/')
}

/** matched の各ファイルについて、mode に応じたルートを求める（per_file_dir のルート単位の重複排除に使う）。 */
export function computePerFileRoots(mode: 'file' | 'pattern_root', patternPairs: PatternPair[], matched: string[]): Record<string, string> {
  const roots: Record<string, string> = {}
  if (mode === 'file') {
    for (const rp of matched) roots[rp] = fileRoot(rp)
    return roots
  }
  for (const rp of matched) {
    for (const [text, rx] of patternPairs) {
      if (rx.test(rp)) {
        roots[rp] = globMatchRoot(text, rp)
        break
      }
    }
  }
  return roots
}

/** コマンド文字列をログファイル名に使える形へ（英数と ._- 以外を _ に、80文字まで）。 */
export const slug = (cmd: string): string =>
  cmd
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 80) || 'cmd'

/** 複数行のコマンドは最初の非空行 + " ..." にし、長すぎるものは切り詰める（1 コマンド 1 行）。 */
export function oneLine(cmd: unknown): string {
  const lines = String(cmd)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
  let text = lines[0] ?? ''
  if (lines.length > 1) text += ' ...'
  return text.length <= STATUS_CMD_MAX ? text : `${text.slice(0, STATUS_CMD_MAX - 3)}...`
}

/** match したファイル（ルート相対パス）を run のコマンドへ渡す env。`for f in $CLAUDE_GATE_FILES` と単語分割して使えるよう引用する。 */
export const filesEnv = (rels: Iterable<string>): Env => ({ [FILES_ENV_KEY]: [...new Set(rels)].sort().map(shellQuote).join(' ') })

/** 2つの env の CLAUDE_GATE_FILES を和集合にする（他のキーは a を優先して残す）。 */
export function mergeFilesEnv(a: Env | undefined, b: Env | undefined): Env {
  const rels = new Set<string>()
  for (const env of [a, b]) if (env?.[FILES_ENV_KEY]) for (const r of shellSplit(env[FILES_ENV_KEY])) rels.add(r)
  return { ...b, ...a, ...filesEnv(rels) }
}

const sameEnv = (a: Env | undefined, b: Env | undefined): boolean =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort())

/** Cedar の文字列リテラルにする。 */
export const cedarString = (value: unknown): string =>
  `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}"`

/** 実行履歴1件を dogwood のトレース行にする。判定を生むのは request だけで、response / error は履歴専用イベント。 */
export function traceLine(rec: Dict, project: string, index: number): string {
  const resource = `Gate::Project::${cedarString(project)}`
  const payload = `{ name: ${cedarString(rec.name || '')}, cmd: ${cedarString(rec.cmd || '')} }`
  return (
    `@${Math.trunc(Number(rec.ts) || 0)} scope(principal: ${GATE_PRINCIPAL}, resource: ${resource}) request_context(input: ${payload}) ` +
    `Gate::Action::"Run"::${rec.kind || 'request'}(input: ${payload}, callerPrincipal: ${GATE_PRINCIPAL}, callerResource: ${resource}, ` +
    `requestId: ${cedarString(`r${index}`)})`
  )
}

/** run の要素（文字列 or {cmd, name, timeout}）から [コマンド文字列, タイムアウト秒, ログ名] を取り出す。 */
export function parseCmd(item: unknown, defaultTimeout: number): [cmd: string, timeout: number, name: string | null] {
  if (isDict(item)) {
    return [
      (truthy(item.cmd) ? item.cmd : '') as string,
      (truthy(item.timeout) ? item.timeout : defaultTimeout) as number,
      truthy(item.name) ? String(item.name) : null,
    ]
  }
  return [item as string, defaultTimeout, null]
}

const isParallel = (item: unknown): item is { parallel?: RunItem[] } => isDict(item) && 'parallel' in item

/** run_cmds は1つ失敗しても後続を実行し続ける（&& ではなく ; 相当）ので、表示もそれに合わせる。 */
export function summarizeCmds(cmds: RunItem[]): string {
  const parts: string[] = []
  for (const c of cmds) {
    if (isParallel(c)) parts.push(`(${summarizeCmds(c.parallel || []).replaceAll(' ; ', ' & ')})`)
    else if (isDict(c)) parts.push(truthy(c.cmd) ? String(c.cmd) : '')
    else parts.push(c as string)
  }
  return parts.join(' ; ')
}

/** 出力を末尾 limit 行に切り詰める。切ったときは先頭に省略表示を付ける。 */
export function tailOutput(out: string, limit = FAIL_TAIL_LINES): string {
  const lines = out.trimEnd().split(/\r?\n/)
  if (lines.length <= limit) return lines.join('\n')
  return [`…（先頭 ${lines.length - limit} 行省略）`, ...lines.slice(-limit)].join('\n')
}

/** 失敗詳細を1つの文字列にまとめる。全体が上限を超えたら残りは省略して log を見るよう促す。 */
export function failureDetails(failures: string[]): string {
  if (failures.length === 0) return ''
  let text = ''
  let used = 0
  let omitted = 0
  for (const [i, original] of failures.entries()) {
    let d = original
    if (used + d.length + 1 > FAIL_DETAIL_MAX && used) {
      omitted = failures.length - i
      break
    }
    if (used + d.length + 1 > FAIL_DETAIL_MAX) d = `${d.slice(0, FAIL_DETAIL_MAX)}\n…（以降省略）`
    text += `${d}\n`
    used += d.length + 1
  }
  if (omitted) text += `…（残り ${omitted} 件の失敗は省略。各 [gate] log のパスを見てください）\n`
  return text.trimEnd()
}

// ---- ファイル単位の排他（同一プロセス内。flock の代わり） ----
const locks = new Map<string, Promise<unknown>>()
function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve()
  const run = prev.then(fn)
  locks.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

let logSeq = 0

type Chunk = { lines: string[]; detail?: string }
type PolicyResolved = { policy: string; schema: string; isDefault: boolean }
const UNSET = Symbol('unset')

/** フェーズ1回分の共有状態。executed は「ポリシー判定の結果として実際に実行されたコマンドがあったか」。 */
export class PolicyState {
  executed = false
  /** この回の中で deferCmd() したキー。allow されて undefer された後に別ルールで再度 deny されて積み直された分を消化対象にしない。 */
  deferredThisRun = new Set<string>()
}

export class Gate {
  readonly io: Io
  readonly projectDir: string
  readonly sessionId: string
  readonly agentId: string
  readonly stateId: string
  readonly phase: string
  readonly stopHookActive: boolean
  readonly claudeDir: string
  readonly action: string
  readonly gateYml: string
  readonly stateDir: string
  readonly changed: string
  readonly count: string
  readonly sidecar: string
  readonly pending: string
  readonly trace: string
  readonly deferred: string
  readonly logRoot: string
  readonly logDir: string
  defaultPolicy: string
  readonly defaultPolicySchema: string
  /** 実行するコマンドに渡す環境変数（元の hook スクリプトが子プロセスへ引き継いでいたもの）。 */
  readonly baseEnv: Env
  /** 通過・スキップ・失敗の 1 行ログ（通ったのか実行されなかったのかを区別するため）。 */
  status: string[] = []
  /** 失敗したコマンドだけの詳細（ヘッダ・出力末尾・タイムアウト文言・log パス）。 */
  failures: string[] = []
  stdout = ''
  stderr = ''

  constructor(io: Io, opts: { sessionId?: string; agentId?: string; phase?: string; stopHookActive?: boolean } = {}) {
    this.io = io
    this.projectDir = io.projectDir || io.cwd
    this.sessionId = opts.sessionId || 'unknown'
    this.agentId = opts.agentId || ''
    this.stateId = this.agentId ? `${this.sessionId}--${this.agentId}` : this.sessionId
    // 未指定時は checks（この hook の唯一の呼び出し元が長らく Stop だったため）。
    this.phase = (opts.phase || 'checks').trim().toLowerCase()
    this.stopHookActive = opts.stopHookActive === true
    this.claudeDir = join(this.projectDir, '.claude')
    this.action = join(this.claudeDir, 'gate.yaml')
    this.gateYml = join(this.claudeDir, 'gate.yml') // 拡張子 typo 検知用
    this.stateDir = join(this.claudeDir, '.gate-status') // 状態ファイルとログの置き場所（gate.yaml は動かさない）
    this.changed = join(this.stateDir, `changed_files.${this.stateId}.txt`)
    this.count = join(this.stateDir, `gate_attempts.${this.stateId}.txt`)
    this.sidecar = join(this.stateDir, `gate_passed.${this.stateId}.txt`) // rule通過・checks確認待ち
    this.pending = join(this.stateDir, `gate_pending_checks.${this.stateId}.json`) // checksフェーズへの予約
    this.trace = join(this.stateDir, `gate_trace.${this.stateId}.jsonl`) // ポリシー判定に食わせる実行履歴
    this.deferred = join(this.stateDir, `gate_deferred.${this.stateId}.json`) // ポリシーでスキップした分の控え
    this.logRoot = join(this.stateDir, 'logs')
    this.logDir = join(this.logRoot, this.stateId)
    this.defaultPolicy = join(io.pluginRoot, 'scripts', 'dogwood', 'gate.default.dw')
    this.defaultPolicySchema = join(io.pluginRoot, 'scripts', 'dogwood', 'gate.cedarschema')
    this.baseEnv = {
      CLAUDE_PROJECT_DIR: this.projectDir,
      CLAUDE_SESSION_ID: this.sessionId,
      CLAUDE_STOP_HOOK_ACTIVE: this.stopHookActive ? 'true' : 'false',
      CLAUDE_GATE_PHASE: this.phase,
      ...(this.agentId ? { CLAUDE_AGENT_ID: this.agentId } : {}),
    }
  }

  private print(obj: unknown): void {
    this.stdout += `${JSON.stringify(obj)}\n`
  }

  private writeErr(text: string): void {
    this.stderr += text
  }

  /** 状態ファイルを削除する。only を渡すと、その集合だけを消す。 */
  async cleanup(only?: string[]): Promise<void> {
    await this.io.removeFiles(only ?? [this.changed, this.count, this.sidecar, this.pending])
  }

  private async rm(path: string): Promise<void> {
    await this.io.removeFiles([path])
  }

  // ---- ログ掃除 ----
  private async pruneDir(dirpath: string, maxAge: number, rmdir = false): Promise<void> {
    const cutoff = (await this.io.now()) - maxAge * 1000
    const entries = await this.io.list(dirpath)
    const old = entries.filter((e) => e.name.endsWith('.log') && e.kind === 'file' && e.mtimeMs < cutoff).map((e) => join(dirpath, e.name))
    if (old.length > 0) await this.io.removeFiles(old)
    if (rmdir) await this.io.removeDir(dirpath)
  }

  /** 現セッション分は LOG_MAX_AGE、他セッション分は LOG_STALE_GRACE を超えたら削除。 */
  async pruneLogs(): Promise<void> {
    for (const e of await this.io.list(this.logRoot)) {
      const path = join(this.logRoot, e.name)
      if (e.kind === 'dir') {
        if (e.name === this.stateId) await this.pruneDir(path, LOG_MAX_AGE)
        else await this.pruneDir(path, LOG_STALE_GRACE, true)
      } else if (e.name.endsWith('.log') && e.kind === 'file') {
        // セッション別ディレクトリ導入前の直下ログも掃除
        if (e.mtimeMs < (await this.io.now()) - LOG_STALE_GRACE * 1000) await this.rm(path)
      }
    }
  }

  // ---- 通過・スキップ・失敗の 1 行ログ ----
  note(kind: string, label: string, cmd: unknown, detail = ''): void {
    this.status.push(`[gate] ${kind}: ${label} $ ${oneLine(cmd)}${detail ? ` ${detail}` : ''}`)
  }

  statusBlock(fallback = ''): string {
    return this.status.length > 0 ? this.status.join('\n') : fallback
  }

  // ---- 実行履歴と控え（スキップ分）の永続化 ----
  private async loadTrace(): Promise<Dict[]> {
    const text = (await this.io.readFile(this.trace)) ?? ''
    const records: Dict[] = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const rec: unknown = JSON.parse(t)
        if (isDict(rec)) records.push(rec)
      } catch {
        // 壊れた行は読み飛ばす
      }
    }
    return records
  }

  /** 実行履歴のうち root のものだけを ts 昇順で返す。 */
  async readTrace(root: string): Promise<Dict[]> {
    if (!(await this.io.exists(this.trace))) return []
    const records = await withLock(this.trace, () => this.loadTrace())
    return records.filter((r) => r.root === root).sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
  }

  /**
   * 実行履歴を1件追記し、書き込んだ ts を返す。dogwood のトレースは時系列順である必要があるので ts は
   * root 内で単調非減少にする。書き込みのたびに TRACE_WINDOW より古いレコードを間引く。
   */
  async appendTrace(root: string, cwd: string, name: string, cmd: string, kind: string): Promise<number> {
    const now = Math.floor((await this.io.now()) / 1000)
    return withLock(this.trace, async () => {
      const records = await this.loadTrace()
      const last = Math.max(0, ...records.filter((r) => r.root === root).map((r) => Number(r.ts) || 0))
      const ts = Math.max(now, last)
      records.push({ ts, root, cwd, name, cmd, kind })
      const kept = records.filter((r) => (Number(r.ts) || 0) >= now - TRACE_WINDOW)
      await this.io.writeFile(this.trace, kept.map((r) => `${JSON.stringify(r)}\n`).join(''))
      return ts
    })
  }

  private async loadDeferred(): Promise<Entry[]> {
    const text = (await this.io.readFile(this.deferred)) || '[]'
    try {
      const entries: unknown = JSON.parse(text)
      return Array.isArray(entries) ? (entries as Entry[]) : []
    } catch {
      return []
    }
  }

  private dumpDeferred(entries: Entry[]): Promise<void> {
    return this.io.writeFile(this.deferred, JSON.stringify(entries))
  }

  /**
   * スキップしたコマンドを控えへ積む。(root, cwd, cmd) が同じものは積み直さないが、対象ファイルの env
   * （CLAUDE_GATE_FILES）だけは既存の控えへマージする。控えを消化するのは後の回なので、その間に積まれた
   * 別の match ファイルを取りこぼさないため。
   */
  async deferCmd(root: string, cwd: string, name: string, cmd: string, timeout: number, label: string, extraEnv?: Env): Promise<void> {
    await withLock(this.deferred, async () => {
      const entries = await this.loadDeferred()
      for (const e of entries) {
        if (e.root === root && e.cwd === cwd && e.cmd === cmd) {
          const merged = mergeFilesEnv(e.env, extraEnv)
          if (!sameEnv(merged, e.env)) {
            e.env = merged
            await this.dumpDeferred(entries)
          }
          return
        }
      }
      entries.push({ root, cwd, name, cmd, timeout, label, env: extraEnv ?? {} })
      await this.dumpDeferred(entries)
    })
  }

  /** 今から実行するコマンドが控えにも残っていれば取り除く（前回 deny された分を消化と実行で二重に走らせないため）。 */
  async undeferCmd(root: string, cwd: string, cmd: string): Promise<void> {
    if (!(await this.io.exists(this.deferred))) return
    await withLock(this.deferred, async () => {
      const entries = await this.loadDeferred()
      const kept = entries.filter((e) => !(e.root === root && e.cwd === cwd && e.cmd === cmd))
      if (kept.length !== entries.length) await this.dumpDeferred(kept)
    })
  }

  /** 控えを全件取り出して空にする。 */
  async takeDeferred(): Promise<Entry[]> {
    if (!(await this.io.exists(this.deferred))) return []
    return withLock(this.deferred, async () => {
      const entries = await this.loadDeferred()
      await this.dumpDeferred([])
      return entries
    })
  }

  private static deferKey = (e: Entry): string => `${e.root}\0${e.cwd}\0${e.cmd}`

  /** 控えの現在の内容を (root, cwd, cmd) キーの集合として返す（消化しない）。 */
  async deferredKeys(): Promise<Set<string>> {
    if (!(await this.io.exists(this.deferred))) return new Set()
    const entries = await withLock(this.deferred, () => this.loadDeferred())
    return new Set(entries.map(Gate.deferKey))
  }

  /** 控えのうち渡されたキーに一致するものだけを取り出す。一致しなかったエントリ（この呼び出し中に新しく積まれた分）は控えに残す。 */
  async takeDeferredMatching(keys: Set<string>): Promise<Entry[]> {
    if (!(await this.io.exists(this.deferred))) return []
    return withLock(this.deferred, async () => {
      const entries = await this.loadDeferred()
      const matched: Entry[] = []
      const kept: Entry[] = []
      for (const e of entries) (keys.has(Gate.deferKey(e)) ? matched : kept).push(e)
      if (matched.length > 0) await this.dumpDeferred(kept)
      return matched
    })
  }

  // ---- dogwood ポリシー評価 ----
  /** dogwood バイナリのパス。DOGWOOD_BIN が指定されているときは PATH へ落ちない。見つからなければ undefined。 */
  async resolveDogwood(): Promise<string | undefined> {
    const explicit = this.io.env.DOGWOOD_BIN
    if (explicit) return (await this.io.isExecutable(explicit)) ? explicit : undefined
    const found = await which(this.io, 'dogwood')
    if (found) return found
    for (const candidate of DOGWOOD_FALLBACKS) {
      const path = expandUser(candidate, this.io.env.HOME)
      if (await this.io.isExecutable(path)) return path
    }
    return undefined
  }

  /** policy / policy_schema の値を絶対パスにする（~ 展開、rootDir からの相対）。 */
  resolvePolicyPath(rootDir: string, value: unknown): string | null {
    if (!truthy(value)) return null
    const path = expandUser(String(value), this.io.env.HOME)
    return isAbsolute(path) ? path : normpath(join(rootDir, path))
  }

  /** owner（rule / consistency_check）→ cfg（トップレベル）の順に、値ではなく「キーの有無」で設定値を選ぶ。false が無効化の指定なので真偽値では選べない。 */
  private inheritedSetting(cfg: Setting | null | undefined, owner: Setting | null | undefined, key: keyof Setting): unknown {
    for (const src of [owner || {}, cfg || {}]) if (key in src) return src[key]
    return UNSET
  }

  /**
   * policy / policy_schema / 既定ポリシーかどうか を解決する。owner 側の指定がトップレベル（cfg）を上書きする。
   * 未設定なら同梱の既定ポリシーを使い、false を指定した場合と、明示したファイルが存在しない場合は null
   * ＝ポリシー機構は無効で従来どおり実行する（明示指定の取りこぼしは設定ミスなので既定へフォールバック
   * せずログに残す）。
   */
  async policyPaths(cfg: Setting | null | undefined, owner: Setting | null | undefined, rootDir: string, logs?: string[]): Promise<PolicyResolved | null> {
    const value = this.inheritedSetting(cfg, owner, 'policy')
    if (value === false) return null
    const isDefault = value === UNSET || value === null || value === undefined
    const policy = isDefault ? this.defaultPolicy : this.resolvePolicyPath(rootDir, value)
    if (!policy || !(await this.io.exists(policy))) {
      if (!isDefault && policy && logs) {
        logs.push(`=== [gate] policy に指定されたファイルが見つかりません: ${policy}。ポリシー判定を行わず実行します。 ===`)
      }
      return null
    }
    const schema = this.resolvePolicyPath(rootDir, owner?.policy_schema || cfg?.policy_schema)
    return { policy, schema: schema || this.defaultPolicySchema, isDefault }
  }

  /**
   * 今回のコマンドの verdict を dogwood replay で求め、[verdict, null] を返す。dogwood には単発の許可判定
   * コマンドが無いので、root の実行履歴をトレースへ変換し、末尾に今回の request を足して頭から食わせ、最後の
   * verdict を今回の判定として使う。評価できなかったときは [null, 理由] を返す。
   */
  async dogwoodVerdict(policy: string, schema: string, rootDir: string, name: string, cmd: string): Promise<[string | null, string | null]> {
    const binpath = await this.resolveDogwood()
    if (!binpath) return [null, 'dogwood バイナリが見つかりません（DOGWOOD_BIN / PATH / ~/.cargo/bin を確認してください）']
    const history = await this.readTrace(rootDir)
    const lastTs = history.length > 0 ? Number(history[history.length - 1]?.ts) || 0 : 0
    const now = await this.io.now()
    const request = { ts: Math.max(Math.floor(now / 1000), lastTs), name, cmd, kind: 'request' }
    const project = basename(normpath(rootDir)) || 'project'
    const tracefile = join(this.stateDir, `.dogwood-${now}-${logSeq++}.trace`)
    let r: Awaited<ReturnType<Io['run']>>
    try {
      await this.io.writeFile(tracefile, [...history, request].map((rec, i) => `${traceLine(rec, project, i)}\n`).join(''))
      r = await this.io.run([binpath, 'replay', policy, '--policy-schema', schema, '--trace', tracefile, '--format', 'json'], {
        timeoutMs: POLICY_TIMEOUT * 1000,
      })
    } finally {
      await this.rm(tracefile)
    }
    if (r.error !== undefined || r.timedOut) {
      return [null, `dogwood の実行に失敗しました: ${r.error ?? 'timed out'}`]
    }
    if (r.exitCode !== 0) {
      const detail = (r.stderr || r.stdout || '').trim().replaceAll('\n', ' ').slice(0, 200)
      return [null, `dogwood replay が異常終了しました（exit ${r.exitCode}）: ${detail}`]
    }
    let verdicts: unknown[]
    try {
      const parsed: unknown = JSON.parse(r.stdout)
      const v = isDict(parsed) ? parsed.verdicts : undefined
      verdicts = Array.isArray(v) ? v : []
    } catch {
      return [null, 'dogwood replay の出力を JSON として読めませんでした']
    }
    if (verdicts.length === 0) return [null, 'dogwood replay が verdict を返しませんでした']
    const last = verdicts[verdicts.length - 1]
    const verdict = String((isDict(last) ? last.verdict : '') || '').toLowerCase()
    if (verdict !== 'allow' && verdict !== 'deny') return [null, `dogwood replay の verdict を解釈できませんでした: ${pyRepr(verdict)}`]
    return [verdict, null]
  }

  /** rule / consistency_check のポリシー設定を解決する。無効なら null を返し、呼び出し側は従来どおり無条件にコマンドを実行する。 */
  async makePolicyContext(
    cfg: Setting | null | undefined,
    owner: Setting | null | undefined,
    rootDir: string,
    state: PolicyState | undefined,
    logs?: string[],
  ): Promise<PolicyContext | null> {
    if (!state) return null
    const resolved = await this.policyPaths(cfg, owner, rootDir, logs)
    if (!resolved) return null
    return new PolicyContext(this, rootDir, resolved.policy, resolved.schema, resolved.isDefault, state)
  }

  // ---- コマンド実行 ----
  /**
   * コマンドを実行し { out, ok, timedOut, logpath } を返す。出力（stdout と stderr を混ぜたもの）は
   * logDir/{name もしくは cmd}.{uid}.log に書き出す。タイムアウト時は強制終了して失敗扱い。
   */
  async runCmd(
    cmd: string,
    cwd: string,
    timeout: number,
    name?: string | null,
    extraEnv?: Env,
  ): Promise<{ out: string; ok: boolean; timedOut: boolean; logpath: string }> {
    const uid = `${Math.floor((await this.io.now()) / 1000)}-${logSeq++}`
    const logpath = join(this.logDir, `${slug(name || cmd)}.${uid}.log`)
    const header = `$ ${cmd}  (cwd: ${cwd})\n`
    await this.io.writeFile(logpath, header).catch(() => undefined)
    const started = await this.io.now()
    const r = await this.io.run(['sh', '-c', `exec 2>&1; ${cmd}`], {
      cwd,
      env: { ...this.baseEnv, ...extraEnv },
      timeoutMs: Math.min(Math.round(timeout * 1000), MAX_TIMEOUT_MS),
    })
    // エンジンの process.run はタイムアウトを「起動できなかった」と同じ拒否で返すので、経過時間で見分ける。
    const elapsed = (await this.io.now()) - started
    const timedOut = r.timedOut || (r.error !== undefined && elapsed >= Math.min(timeout * 1000, MAX_TIMEOUT_MS) - 1000)
    let out = r.stdout + r.stderr
    if (r.error !== undefined && !timedOut) out += `${out && !out.endsWith('\n') ? '\n' : ''}${r.error}\n`
    await this.io.writeFile(logpath, header + out).catch(() => undefined)
    return { out, ok: r.exitCode === 0 && !timedOut && r.error === undefined, timedOut, logpath }
  }

  /** 1コマンド実行して [ログ行リスト, ok] を返す。並行実行時もログを混ぜないため一旦まとめる。 */
  async execOne(label: string, cmd: string, cwd: string, timeout: number, mark = '', name?: string | null, extraEnv?: Env): Promise<[Chunk, boolean]> {
    const title = name ? `${name}: ${cmd}` : cmd
    const chunk: Chunk = { lines: [`=== [gate] (${label})${mark} $ ${title} ===`] }
    const started = await this.io.now()
    const { out, ok, timedOut, logpath } = await this.runCmd(cmd, cwd, timeout, name, extraEnv)
    this.note(ok ? 'ok' : 'fail', label, cmd, `(${(((await this.io.now()) - started) / 1000).toFixed(1)}s)`)
    const detail = [chunk.lines[0] as string]
    if (out) {
      chunk.lines.push(out.trimEnd())
      detail.push(tailOutput(out))
    }
    if (timedOut) {
      const msg = `[gate] タイムアウト（${timeout}秒）で強制終了しました。無限ループやハングの可能性があります。`
      chunk.lines.push(msg)
      detail.push(msg)
    }
    if (!ok) {
      chunk.lines.push(`[gate] log: ${logpath}`)
      detail.push(`[gate] log: ${logpath}`)
      chunk.detail = detail.join('\n')
    }
    return [chunk, ok]
  }

  private collectFailure(chunk: Chunk): void {
    if (chunk.detail) this.failures.push(chunk.detail)
  }

  withDetails(prefix: string): string {
    const details = failureDetails(this.failures)
    return prefix + (details ? `\n\n--- 失敗したコマンドの出力 ---\n${details}` : '')
  }

  /** parallel ブロック内のコマンドを並行実行。ログは定義順で出力。失敗があれば true。 */
  async runParallel(
    label: string,
    items: RunItem[],
    cwd: string,
    defaultTimeout: number,
    logs: string[],
    policy?: PolicyContext | null,
    extraEnv?: Env,
  ): Promise<boolean> {
    let failed = false
    const tasks: Array<[string, number, string | null]> = []
    for (const item of items) {
      if (isParallel(item)) {
        logs.push(`=== [gate] (${label}) parallel の中に parallel はネストできません。失敗扱いにします。 ===`)
        failed = true
        continue
      }
      const [cmd, timeout, name] = parseCmd(item, defaultTimeout)
      if (!cmd) continue
      if (policy && !(await policy.allows(label, cwd, cmd, timeout, name, logs, extraEnv))) continue
      tasks.push([cmd, timeout, name])
    }
    if (tasks.length === 0) return failed
    const results = await Promise.all(tasks.map((t) => this.execOne(label, t[0], cwd, t[1], ' [parallel]', t[2], extraEnv)))
    for (const [i, [chunk, ok]] of results.entries()) {
      const [cmd, , name] = tasks[i] as [string, number, string | null]
      logs.push(...chunk.lines)
      this.collectFailure(chunk)
      if (policy) await policy.record(cwd, cmd, name, ok)
      if (!ok) failed = true
    }
    return failed
  }

  /** コマンド列を順に実行してログを蓄積。1つでも失敗/タイムアウトなら true を返す。 */
  async runCmds(
    label: string,
    cmds: RunItem[],
    cwd: string,
    defaultTimeout: number,
    logs: string[],
    policy?: PolicyContext | null,
    extraEnv?: Env,
  ): Promise<boolean> {
    let failed = false
    for (const item of cmds) {
      if (isParallel(item)) {
        if (await this.runParallel(label, item.parallel || [], cwd, defaultTimeout, logs, policy, extraEnv)) failed = true
        continue
      }
      const [cmd, timeout, name] = parseCmd(item, defaultTimeout)
      if (!cmd) continue
      if (policy && !(await policy.allows(label, cwd, cmd, timeout, name, logs, extraEnv))) continue
      const [chunk, ok] = await this.execOne(label, cmd, cwd, timeout, '', name, extraEnv)
      logs.push(...chunk.lines)
      this.collectFailure(chunk)
      if (policy) await policy.record(cwd, cmd, name, ok)
      if (!ok) failed = true
    }
    return failed
  }

  /**
   * 控えに溜まったコマンドを実行する。ここではポリシー判定をバイパスする。判定していないので request は
   * 残さず、結果だけを実行履歴に残す。cwd が消えているエントリは実行せずに捨てる。
   * 戻り値: [summary, 失敗したエントリのリスト]。
   */
  async runDeferred(entries: Entry[], logs: string[]): Promise<[string[], Entry[]]> {
    const summary: string[] = []
    const failed: Entry[] = []
    for (const entry of entries) {
      const cmd = entry.cmd || ''
      const cwd = entry.cwd || ''
      if (!cmd) continue
      const label = `deferred:${entry.label || '.'}`
      if ((await this.io.stat(cwd))?.kind !== 'dir') {
        logs.push(`=== [gate] (${label}) cwd が存在しません: ${cwd}。この控えを破棄します。 ===`)
        continue
      }
      const name = entry.name || slug(cmd)
      summary.push(`(${label}) ${cmd}`)
      const [chunk, ok] = await this.execOne(label, cmd, cwd, entry.timeout || DEFAULT_TIMEOUT, '', name, entry.env)
      logs.push(...chunk.lines)
      this.collectFailure(chunk)
      await this.appendTrace(entry.root || this.projectDir, cwd, name, cmd, ok ? 'response' : 'error')
      if (!ok) failed.push(entry)
    }
    return [summary, failed]
  }

  /** 失敗した控えを積み直す（次の checks フェーズ・commit / push でも消化を求めるため）。 */
  async requeueDeferred(entries: Entry[]): Promise<void> {
    for (const e of entries)
      await this.deferCmd(e.root as string, e.cwd as string, e.name as string, e.cmd as string, e.timeout as number, e.label as string, e.env)
  }

  // ---- ルート（worktree）と変更ファイル一覧 ----
  splitRoot(raw: string): [string, string] {
    return splitRootOf(this.projectDir, raw)
  }

  /** path（無ければ空扱い）を読み、(root, rel) キーの出現順リストと、キーごとの元表記を返す。 */
  async loadChangedFlat(path: string): Promise<{ order: Key[]; rawByKey: Map<Key, string> }> {
    const text = await this.io.readFile(path)
    const order: Key[] = []
    const rawByKey = new Map<Key, string>()
    if (text === undefined) return { order, rawByKey }
    for (const raw of text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '')) {
      const key = mk(...this.splitRoot(raw))
      if (!rawByKey.has(key)) {
        rawByKey.set(key, raw)
        order.push(key)
      }
    }
    return { order, rawByKey }
  }

  /** keys（重複除去済み前提）を raw 表記で書き出す。空なら削除する。 */
  async writeChangedFlat(path: string, keys: Key[], rawByKey: Map<Key, string>): Promise<void> {
    if (keys.length === 0) return this.rm(path)
    await this.io.writeFile(path, keys.map((k) => `${rawByKey.get(k)}\n`).join(''))
  }

  private groupKeysByRoot(keys: Key[]): { order: string[]; relsByRoot: Map<string, string[]> } {
    const order: string[] = []
    const relsByRoot = new Map<string, string[]>()
    for (const k of keys) {
      const [root, rel] = unmk(k)
      let list = relsByRoot.get(root)
      if (!list) {
        list = []
        relsByRoot.set(root, list)
        order.push(root)
      }
      list.push(rel)
    }
    return { order, relsByRoot }
  }

  /** root 自身の .claude/gate.yaml を読む。無ければメインの cfg にフォールバックする。 */
  private async loadRootCfg(root: string, mainCfg: GateConfig | null): Promise<GateConfig | null> {
    const path = join(root, '.claude', 'gate.yaml')
    return (await this.io.exists(path)) ? await this.loadAction(path) : mainCfg
  }

  async loadAction(path: string): Promise<GateConfig | null> {
    const text = await this.io.readFile(path)
    if (text === undefined) throw new Error(`gate.yaml を読めません: ${path}`)
    return parseYaml(text) as GateConfig | null
  }

  // ---- rules フェーズ ----
  /** どのルールにもマッチせず何も実行されなかったファイルを、スキップとして 1 行で残す。 */
  private noteUnmatchedFiles(rels: string[], triggered: Array<{ matched: string[] }>): void {
    const covered = new Set<string>()
    for (const t of triggered) for (const m of t.matched) covered.add(m)
    const unmatched = [...new Set(rels)].filter((r) => !covered.has(r)).sort()
    if (unmatched.length === 0) return
    const shown = unmatched.slice(0, UNMATCHED_SHOWN).join(', ')
    const more = unmatched.length > UNMATCHED_SHOWN ? ` ほか${unmatched.length - UNMATCHED_SHOWN}件` : ''
    this.status.push(`[gate] skip: ${shown}${more} (どのルールにもマッチしません)`)
  }

  /**
   * rels に対してマッチしたルールの run だけを実行する。consistency_checks には一切触れない。
   * 戻り値の checkNames はマッチしたルールが run_checks で参照した名前（出現順・重複排除）、checkRefFiles は
   * その名前ごとの参照元マッチファイル集合。
   */
  async runRules(cfg: GateConfig | null, rels: string[], logs: string[], rootDir: string, policyState?: PolicyState) {
    const rules = cfg?.rules || []

    const triggered: Array<{ rule: GateRule; matched: string[]; pairs: PatternPair[] }> = []
    for (const rule of rules) {
      const m = rule.match
      const pats = (typeof m === 'string' ? [m] : truthy(m) ? m : []) as Iterable<string>
      const pairs = matchPatterns(pats)
      const matched = [...new Set(rels.filter((rp) => pairs.some(([, rx]) => rx.test(rp))))].sort()
      if (matched.length > 0) triggered.push({ rule, matched, pairs })
    }

    const summary: string[] = []
    let failed = false
    const successFiles = new Set<string>()
    const failFiles = new Set<string>()
    const checkNames: string[] = []
    const checkRefFiles = new Map<string, Set<string>>()
    for (const { rule, matched, pairs } of triggered) {
      const cmds = rule.run || []
      const timeout = rule.timeout || DEFAULT_TIMEOUT
      const policy = await this.makePolicyContext(cfg, rule, rootDir, policyState, logs)
      const ruleFiles = new Set(matched)
      for (const name of rule.run_checks || []) {
        let set = checkRefFiles.get(name)
        if (!set) {
          set = new Set()
          checkRefFiles.set(name, set)
        }
        for (const f of ruleFiles) set.add(f)
        if (!checkNames.includes(name)) checkNames.push(name)
      }
      const rawPerFileDir = rule.per_file_dir
      if (truthy(rawPerFileDir)) {
        const mode = normalizePerFileDirMode(rawPerFileDir)
        if (mode === null) {
          logs.push(
            `=== [gate] per_file_dir の値が不正です: ${pyRepr(rawPerFileDir)}（true / "file" / "pattern_root" のいずれかを指定してください）。このルールをスキップします。 ===`,
          )
          summary.push(`${summarizeCmds(cmds)}  [skip: per_file_dir不正]`)
          failed = true
          for (const f of ruleFiles) failFiles.add(f)
          continue
        }
        // mode == "file": マッチした各ファイル自身のディレクトリをルートに、
        // mode == "pattern_root": マッチしたパターンの最初の ** 直前をルートにし、
        // いずれもルート単位で重複排除して実行（ルート名の昇順）
        const rootsByRel = computePerFileRoots(mode, pairs, matched)
        for (const d of [...new Set(Object.values(rootsByRel))].sort()) {
          const cwd = d ? join(rootDir, d) : rootDir
          const label = d || '.'
          const dirFiles = matched.filter((rp) => rootsByRel[rp] === d)
          if ((await this.io.stat(cwd))?.kind !== 'dir') {
            logs.push(`=== [gate] (${label}) cwd が存在しません: ${cwd}。このルートをスキップします。 ===`)
            summary.push(`(${label}) ${summarizeCmds(cmds)}  [skip: cwd無し]`)
            this.note('skip', label, summarizeCmds(cmds), '(cwd が存在しません)')
            continue
          }
          summary.push(`(${label}) ${summarizeCmds(cmds)}`)
          if (await this.runCmds(label, cmds, cwd, timeout, logs, policy, filesEnv(dirFiles))) {
            failed = true
            for (const f of dirFiles) failFiles.add(f)
          } else {
            for (const f of dirFiles) successFiles.add(f)
          }
        }
      } else {
        const cwd = rule.dir ? join(rootDir, rule.dir) : rootDir
        const label = rule.dir ?? '.'
        if ((await this.io.stat(cwd))?.kind !== 'dir') {
          logs.push(`=== [gate] (${label}) cwd が存在しません: ${cwd}。このルールをスキップします。 ===`)
          summary.push(`(${label}) ${summarizeCmds(cmds)}  [skip: cwd無し]`)
          this.note('skip', label, summarizeCmds(cmds), '(cwd が存在しません)')
          continue
        }
        summary.push(`(${label}) ${summarizeCmds(cmds)}`)
        if (await this.runCmds(label, cmds, cwd, timeout, logs, policy, filesEnv(ruleFiles))) {
          failed = true
          for (const f of ruleFiles) failFiles.add(f)
        } else {
          for (const f of ruleFiles) successFiles.add(f)
        }
      }
    }

    this.noteUnmatchedFiles(rels, triggered)
    return { summary, failed, successFiles, failFiles, checkNames, checkRefFiles }
  }

  /** root ごとに runRules を実行し、結果をキー (root, rel) 単位にまとめて返す。 */
  private async runRulesAllRoots(
    rootOrder: string[],
    relsByRoot: Map<string, string[]>,
    mainCfg: GateConfig | null,
    logs: string[],
    policyState?: PolicyState,
  ) {
    const summary: string[] = []
    let failed = false
    const successKeys = new Set<Key>()
    const failKeys = new Set<Key>()
    const consumedKeys = new Set<Key>()
    const checkNamesByRoot = new Map<string, string[]>()
    const checkRefKeysByRoot = new Map<string, Map<string, Set<Key>>>()
    for (const root of rootOrder) {
      const rels = relsByRoot.get(root) || []
      if (rels.length === 0) continue
      if (root !== this.projectDir && (await this.io.stat(root))?.kind !== 'dir') {
        logs.push(`=== [gate] worktree が見つかりません: ${root}。対象から外します。 ===`)
        for (const rp of rels) consumedKeys.add(mk(root, rp))
        continue
      }
      const cfg = root === this.projectDir ? mainCfg : await this.loadRootCfg(root, mainCfg)
      const prefix = root === this.projectDir ? '' : `[${relpath(root, this.projectDir)}] `
      const r = await this.runRules(cfg, rels, logs, root, policyState)
      summary.push(...r.summary.map((s) => prefix + s))
      if (r.failed) failed = true
      for (const rp of r.successFiles) successKeys.add(mk(root, rp))
      for (const rp of r.failFiles) failKeys.add(mk(root, rp))
      if (r.checkNames.length > 0) {
        checkNamesByRoot.set(root, r.checkNames)
        const refs = new Map<string, Set<Key>>()
        for (const [name, files] of r.checkRefFiles) refs.set(name, new Set([...files].map((rp) => mk(root, rp))))
        checkRefKeysByRoot.set(root, refs)
      }
    }
    return { summary, failed, successKeys, failKeys, consumedKeys, checkNamesByRoot, checkRefKeysByRoot }
  }

  private async loadPending(): Promise<Pending> {
    const text = await this.io.readFile(this.pending)
    if (text === undefined) return {}
    try {
      const v: unknown = JSON.parse(text)
      return isDict(v) && truthy(v) ? (v as Pending) : {}
    } catch {
      return {}
    }
  }

  private async savePending(data: Pending): Promise<void> {
    if (Object.keys(data).length === 0) return this.rm(this.pending)
    await this.io.writeFile(this.pending, JSON.stringify(data))
  }

  /** rules フェーズで新たに参照された consistency_checks の予約を、ルートごとに既存の予約とユニオンして永続化する。 */
  private async mergePendingChecks(
    checkNamesByRoot: Map<string, string[]>,
    checkRefKeysByRoot: Map<string, Map<string, Set<Key>>>,
    rawByKey: Map<Key, string>,
  ): Promise<void> {
    if (checkNamesByRoot.size === 0) return
    const data = await this.loadPending()
    for (const [root, names] of checkNamesByRoot) {
      const rootChecks = data[root] ?? {}
      data[root] = rootChecks
      const ref = checkRefKeysByRoot.get(root)
      for (const name of names) {
        const raws = [...(ref?.get(name) ?? [])].map((k) => rawByKey.get(k) as string)
        rootChecks[name] = [...new Set([...(rootChecks[name] || []), ...raws])].sort()
      }
    }
    await this.savePending(data)
  }

  private async runRulesPhase(): Promise<number> {
    if (!((await this.io.exists(this.action)) && (await this.io.exists(this.changed)))) return 0
    const { order, rawByKey } = await this.loadChangedFlat(this.changed)
    if (order.length === 0) {
      await this.rm(this.changed)
      return 0
    }

    const cfg = await this.loadAction(this.action)
    const rules = cfg?.rules || []
    if (rules.length === 0) {
      await this.rm(this.changed)
      return 0
    }

    const logs: string[] = []
    const policyState = new PolicyState()
    const keysBeforeThisRun = await this.deferredKeys()
    const { order: rootOrder, relsByRoot } = this.groupKeysByRoot(order)
    const res = await this.runRulesAllRoots(rootOrder, relsByRoot, cfg, logs, policyState)
    const summary = res.summary
    let failed = res.failed

    // ポリシー判定を通って実際に実行されたコマンドがあった回にだけ控えを消化する。消化するのはこの回が
    // 始まる前から控えにあった分だけ。この回の中で新しく積まれた分は次回以降に回す（間引きを1回分は
    // 効かせるため）。控えの失敗は failed には数えるが、元の match ファイル集合とは切れているので
    // success / fail のキーには影響させない。
    if (policyState.executed) {
      const keysToDrain = new Set([...keysBeforeThisRun].filter((k) => !policyState.deferredThisRun.has(k)))
      const [deferredSummary, deferredFailed] = await this.runDeferred(await this.takeDeferredMatching(keysToDrain), logs)
      summary.push(...deferredSummary)
      if (deferredFailed.length > 0) failed = true
    }

    if (res.checkNamesByRoot.size > 0) await this.mergePendingChecks(res.checkNamesByRoot, res.checkRefKeysByRoot, rawByKey)

    // run_checks を参照したキーだけ checks フェーズの確認待ちとして SIDECAR へ退避する。run_checks を持たない
    // ルールで通ったキーは、それ以上待つものが無いので CHANGED からも SIDECAR からも完全に手を離す。
    const checkedKeys = new Set<Key>()
    for (const ref of res.checkRefKeysByRoot.values()) for (const keys of ref.values()) for (const k of keys) checkedKeys.add(k)

    const remaining: Key[] = []
    const seen = new Set<Key>()
    const sidecarAdd: Key[] = []
    const seenSidecar = new Set<Key>()
    for (const k of order) {
      if (res.consumedKeys.has(k)) continue
      if (res.successKeys.has(k) && !res.failKeys.has(k)) {
        if (checkedKeys.has(k) && !seenSidecar.has(k)) {
          seenSidecar.add(k)
          sidecarAdd.push(k)
        }
        continue
      }
      if (seen.has(k)) continue
      seen.add(k)
      remaining.push(k)
    }
    await this.writeChangedFlat(this.changed, remaining, rawByKey)

    if (sidecarAdd.length > 0) {
      const existing = await this.loadChangedFlat(this.sidecar)
      const merged = [...new Set([...existing.order, ...sidecarAdd])]
      const rawLookup = new Map([...existing.rawByKey, ...rawByKey])
      await this.writeChangedFlat(this.sidecar, merged, rawLookup)
    }

    if (failed) {
      this.writeErr(`${[...this.status, ...logs].join('\n')}\n`)
      this.writeErr('[gate] rules フェーズの検証に失敗しました（会話は止まりません）。上のエラーを見て修正してください。\n')
      return 2
    }
    if (summary.length > 0 || this.status.length > 0) {
      const body = this.statusBlock(summary.map((s) => `✓ ${s}`).join('\n'))
      this.print({ systemMessage: `[gate] rules フェーズ成功:\n${body}` })
    }
    return 0
  }

  // ---- checks フェーズ ----
  /** 予約された consistency_checks の名前だけを実行する。定義が見つからない／cwd が無いものはスキップ扱い（失敗にはしない）。 */
  private async runNamedChecks(
    checksByName: Map<string, GateCheck>,
    names: string[],
    logs: string[],
    rootDir: string,
    cfg: GateConfig | null,
    policyState: PolicyState,
    filesByName: Record<string, string[]>,
  ): Promise<[string[], boolean]> {
    const summary: string[] = []
    let failed = false
    for (const name of [...names].sort()) {
      const check = checksByName.get(name)
      if (!check) {
        logs.push(`=== [gate] consistency_checks に "${name}" が見つかりません。スキップします。 ===`)
        summary.push(`(check:${name}) 見つかりません、スキップ`)
        this.status.push(`[gate] skip: check:${name} (consistency_checks に定義がありません)`)
        continue
      }
      const cwd = check.dir ? join(rootDir, check.dir) : rootDir
      const cmds = check.run || []
      const timeout = check.timeout || DEFAULT_TIMEOUT
      if ((await this.io.stat(cwd))?.kind !== 'dir') {
        logs.push(`=== [gate] (check:${name}) cwd が存在しません: ${cwd}。このチェックをスキップします。 ===`)
        summary.push(`(check:${name}) ${summarizeCmds(cmds)}  [skip: cwd無し]`)
        this.note('skip', `check:${name}`, summarizeCmds(cmds), '(cwd が存在しません)')
        continue
      }
      summary.push(`(check:${name}) ${summarizeCmds(cmds)}`)
      const policy = await this.makePolicyContext(cfg, check, rootDir, policyState, logs)
      const refs = filesByName[name] || []
      const env = filesEnv(refs.map((raw) => this.splitRoot(raw)[1]))
      if (await this.runCmds(`check:${name}`, cmds, cwd, timeout, logs, policy, env)) failed = true
    }
    return [summary, failed]
  }

  /** pending（{root: {check名: [raw,...]}}）から参照されている全キーを返す。 */
  private pendingRefKeys(pending: Pending): Set<Key> {
    const keys = new Set<Key>()
    for (const checks of Object.values(pending)) for (const raws of Object.values(checks)) for (const raw of raws) keys.add(mk(...this.splitRoot(raw)))
    return keys
  }

  private pendingRawByKey(pending: Pending): Map<Key, string> {
    const m = new Map<Key, string>()
    for (const checks of Object.values(pending)) {
      for (const raws of Object.values(checks)) {
        for (const raw of raws) {
          const k = mk(...this.splitRoot(raw))
          if (!m.has(k)) m.set(k, raw)
        }
      }
    }
    return m
  }

  /** 予約された consistency_checks が全て成功したとき、対応するキーを SIDECAR から確定除去する。 */
  private async confirmPending(pending: Pending): Promise<void> {
    const keys = this.pendingRefKeys(pending)
    if (keys.size === 0) return
    const { order, rawByKey } = await this.loadChangedFlat(this.sidecar)
    await this.writeChangedFlat(
      this.sidecar,
      order.filter((k) => !keys.has(k)),
      rawByKey,
    )
  }

  /** consistency_checks の確認を諦めたとき、対応するキーを SIDECAR から取り除き CHANGED へ戻す。 */
  private async requeuePendingToChanged(pending: Pending): Promise<void> {
    const keys = this.pendingRefKeys(pending)
    if (keys.size === 0) return
    const sidecar = await this.loadChangedFlat(this.sidecar)
    await this.writeChangedFlat(
      this.sidecar,
      sidecar.order.filter((k) => !keys.has(k)),
      sidecar.rawByKey,
    )

    const changed = await this.loadChangedFlat(this.changed)
    const rawLookup = new Map([...this.pendingRawByKey(pending), ...sidecar.rawByKey, ...changed.rawByKey])
    const have = new Set(changed.order)
    const merged = [...new Set([...changed.order, ...sortedKeys([...keys].filter((k) => !have.has(k)))])]
    await this.writeChangedFlat(this.changed, merged, rawLookup)
  }

  /** worktree が既に消えているルート分の予約は、SIDECAR からも静かに落とす。 */
  private async purgeRootsFromSidecar(droppedRoots: Set<string>): Promise<void> {
    if (droppedRoots.size === 0) return
    const { order, rawByKey } = await this.loadChangedFlat(this.sidecar)
    await this.writeChangedFlat(
      this.sidecar,
      order.filter((k) => !droppedRoots.has(unmk(k)[0])),
      rawByKey,
    )
  }

  private async runChecksPhase(): Promise<number> {
    const pending = (await this.io.exists(this.pending)) ? await this.loadPending() : {}
    if (Object.keys(pending).length === 0) await this.rm(this.pending)
    // rules フェーズの控えは、そこで実行が起きた回にしか消化されない。編集が止まると残り続け、未検証のまま
    // commit / 終了してしまうので、checks フェーズでも全件消化する。
    const deferred = await this.takeDeferred()
    if (Object.keys(pending).length === 0 && deferred.length === 0) return 0

    const mainCfg = await this.loadAction(this.action)

    const logs: string[] = []
    const summary: string[] = []
    let failed = false
    const policyState = new PolicyState()
    const activePending: Pending = {}
    const droppedRoots = new Set<string>()
    for (const [root, checksMap] of Object.entries(pending)) {
      if (root !== this.projectDir && (await this.io.stat(root))?.kind !== 'dir') {
        logs.push(`=== [gate] worktree が見つかりません: ${root}。対象から外します。 ===`)
        droppedRoots.add(root)
        continue
      }
      activePending[root] = checksMap
      const cfg = root === this.projectDir ? mainCfg : await this.loadRootCfg(root, mainCfg)
      const checksByName = new Map(((cfg?.consistency_checks || []) as GateCheck[]).map((c) => [c.name, c]))
      const prefix = root === this.projectDir ? '' : `[${relpath(root, this.projectDir)}] `
      const [rSummary, rFailed] = await this.runNamedChecks(checksByName, Object.keys(checksMap), logs, root, cfg, policyState, checksMap)
      summary.push(...rSummary.map((s) => prefix + s))
      if (rFailed) failed = true
    }

    await this.purgeRootsFromSidecar(droppedRoots)

    const [dSummary, dFailed] = await this.runDeferred(deferred, logs)
    summary.push(...dSummary)
    if (dFailed.length > 0) {
      await this.requeueDeferred(dFailed)
      failed = true
    }

    if (!failed) {
      await this.confirmPending(activePending)
      await this.cleanup([this.count, this.pending])
      const body = this.statusBlock(summary.length > 0 ? summary.map((s) => `✓ ${s}`).join('\n') : '（対象なし）')
      const title = Object.keys(pending).length > 0 ? 'consistency checks' : '後回しにした検証コマンド'
      this.print({ systemMessage: `[gate] ${title} 成功:\n${body}` })
      return 0
    }

    this.writeErr(`${[...this.status, ...logs].join('\n')}\n`)

    let attempts = 0
    const countText = await this.io.readFile(this.count)
    if (countText !== undefined && /^\s*[+-]?\d+\s*$/.test(countText)) attempts = Number.parseInt(countText.trim(), 10)
    // 前回の Stop hook がブロックして継続させた結果の Stop ではない = 新しいユーザーターン起点の Stop なので、リトライ回数を数え直す。
    if (!this.stopHookActive) attempts = 0
    attempts += 1
    await this.io.writeFile(this.count, String(attempts))

    if (attempts >= MAX_ATTEMPTS) {
      await this.requeuePendingToChanged(activePending)
      await this.cleanup([this.count, this.pending])
      this.writeErr(`consistency checks が ${MAX_ATTEMPTS} 回連続失敗。ループを打ち切ります。手動確認を。\n`)
      const msg =
        `[gate] consistency checks が${MAX_ATTEMPTS}回連続で失敗したため打ち切りました。` +
        '対象ファイルは未検証のまま CHANGED へ戻しました。' +
        '手動で確認してください。今すぐ解除したい場合は新しいセッションを開始するか ' +
        '/clear を実行してください（SessionStart の reset-gate が状態ファイルを削除します）。\n' +
        summary.map((s) => `✗ ${s}`).join('\n') +
        this.withDetails('')
      this.print({ systemMessage: msg })
      return 0
    }

    const reason =
      `consistency checks 失敗（試行 ${attempts}/${MAX_ATTEMPTS}）。上のエラーを見て修正を継続してください。\n` +
      summary.map((s) => `✗ ${s}`).join('\n') +
      this.withDetails('')
    this.writeErr(`${reason}\n`)
    // stdout が空だと harness 側の判定で exit 2 が non-blocking 扱いになる不具合があるため、stderr の内容に関わらず必ず JSON を出す。
    this.print({ decision: 'block', reason })
    return 2
  }

  async main(): Promise<number> {
    await this.pruneLogs()
    if (!(await this.io.exists(this.action)) && (await this.io.exists(this.gateYml))) {
      this.print({
        systemMessage: '[gate] .claude/gate.yaml が見つかりませんが .claude/gate.yml があります。拡張子が yaml ではなく yml になっていないか確認してください。',
      })
    }
    if (!(await this.io.exists(this.action))) {
      await this.cleanup()
      return 0
    }
    return this.phase === 'rules' ? this.runRulesPhase() : this.runChecksPhase()
  }
}

/** rule / consistency_check 1つ分のポリシー設定。 */
export class PolicyContext {
  constructor(
    private readonly gate: Gate,
    readonly rootDir: string,
    readonly policy: string,
    readonly schema: string,
    readonly isDefault: boolean,
    readonly state: PolicyState,
  ) {}

  /**
   * 判定して実行してよければ true。deny・評価不能ならスキップして控えへ積む。スキップは失敗ではないので、
   * 呼び出し側は failed を立てない。ただし既定ポリシー（policy: 未設定）で dogwood 自体が入っていない環境では、
   * 判定せず素通しする。ポリシーを設定した覚えの無い利用者の全コマンドが黙って止まるのを避けるため。
   * dogwood が在るのに評価できない場合は素通ししない。
   */
  async allows(label: string, cwd: string, cmd: string, timeout: number, name: string | null | undefined, logs: string[], extraEnv?: Env): Promise<boolean> {
    if (this.isDefault && !(await this.gate.resolveDogwood())) return true
    const pname = name || slug(cmd)
    const [verdict, reason] = await this.gate.dogwoodVerdict(this.policy, this.schema, this.rootDir, pname, cmd)
    if (verdict === null) {
      logs.push(
        `=== [gate] (${label}) ポリシーを評価できないため今回はスキップしました（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます）［${reason}］ $ ${cmd} ===`,
      )
    } else {
      await this.gate.appendTrace(this.rootDir, cwd, pname, cmd, 'request')
      if (verdict === 'allow') {
        await this.gate.undeferCmd(this.rootDir, cwd, cmd)
        this.state.executed = true
        return true
      }
      logs.push(
        `=== [gate] (${label}) ポリシーにより今回はスキップしました（意図的な間引き。理由の調査は不要。控えに積んだので後で自動実行されます） $ ${cmd} ===`,
      )
    }
    this.gate.note(
      'skip',
      label,
      cmd,
      verdict ? '(ポリシー判定で見送り。控えに積んだので後で自動実行)' : `(ポリシーを評価できず見送り。控えに積んだので後で自動実行: ${reason})`,
    )
    this.state.deferredThisRun.add(`${this.rootDir}\0${cwd}\0${cmd}`)
    await this.gate.deferCmd(this.rootDir, cwd, pname, cmd, timeout, label, extraEnv)
    return false
  }

  async record(cwd: string, cmd: string, name: string | null | undefined, ok: boolean): Promise<void> {
    await this.gate.appendTrace(this.rootDir, cwd, name || slug(cmd), cmd, ok ? 'response' : 'error')
  }
}

/** gate を1回実行する。内部エラーは握りつぶして作業を継続させる（stderr に詳細、systemMessage で通知）。 */
export async function runGate(io: Io, opts: { sessionId?: string; agentId?: string; phase?: string; stopHookActive?: boolean } = {}): Promise<ScriptResult> {
  const gate = new Gate(io, opts)
  let exitCode: number
  try {
    exitCode = await gate.main()
  } catch (e) {
    gate.stderr += `[gate] internal error:\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`
    gate.stdout += `${JSON.stringify({ systemMessage: '[gate] 内部エラーが発生したためチェックをスキップしました（作業は継続します）。詳細は stderr を参照してください。' })}\n`
    exitCode = 0
  }
  return { exitCode, stdout: gate.stdout, stderr: gate.stderr }
}
