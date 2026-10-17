// 後続コマンド（followup）: あるコマンドを実行したら、人間が .md に書いておいた次のコマンドを実行し、その結果を Claude に返す。
//
// 例: `gh pr create` を実行したら `gh pr checks {{pr}} --watch` を続けて実行し、その結果を報告させる。
// Claude Code のバックグラウンド実行はコマンドを Claude が決めるので見当違いなことがある。ここでは「きっかけ」と
// 「実行するコマンド」は人間が定義ファイルに書き、コマンドの引数（{{pr}} のような穴）だけを埋める。
//
// 実行の仕方は 2 つあり、引数が hook で埋まるかどうかで決まる:
// - hook 実行（強制）: 定義の args に正規表現（pattern）があり、きっかけのコマンドの出力（PostToolUse の tool_response）か
//   コマンド文字列からすべての穴が埋まったとき（穴が無いときも）。hook が埋めたコマンドをバックグラウンドで起動し、
//   Claude の作業は止めない。結果は hook が回収して Claude に渡す: 終了後の最初の hook（どのツールの PostToolUse でも、
//   次のプロンプトでも）で additionalContext として、まだ走っているなら Stop で終了（または timeout）まで待ち合わせて
//   ブロックの理由として渡す。モデルは一切介在しないので、必ず実行され、結果は遅くとも Stop で返る。Bash ツールの
//   時間制限（最長 10 分）も関係ない。
// - Claude 実行: 穴が hook で埋まらないとき。hook はモデルを呼べないので、Claude に「{{...}} を直前の出力から推測して
//   埋めて次の Bash で実行せよ」と求め、実行されたか（雛形の穴を任意の引数として読んだパターンに一致する Bash が
//   成功したか）を見届ける。失敗したら理由を見て組み立て直させ、一度も実行しないまま終わろうとしたら Stop を止める。
//   結果は Bash ツールの結果として Claude に届く（バックグラウンド実行なら Claude Code が完了時に渡す）。
//
// 定義ファイル（~/.claude/followup/*.md とプロジェクトの .claude/followup/*.md。同名はプロジェクト側が優先）:
//
// ---
// name: pr_checks              # 省略時はファイル名（.md 抜き）
// description: PR を作ったら CI を見届ける
// when: '^gh pr create\b'      # 必須。Bash のコマンドにマッチする正規表現（pre_bash と同じ Python re の書き方）
// unless: '--dry-run'          # 任意。マッチすれば発火しない
// run: 'gh pr checks {{pr}} --watch'   # 必須。{{name}} が引数の穴
// args:                        # 任意。引数ごとの埋め方
//   pr:                        #   辞書なら hook が埋める: from（output = きっかけの出力、command = きっかけのコマンド。
//     from: output             #   既定 output）の pattern（正規表現。最初のキャプチャ、無ければ一致全体）。
//     pattern: 'pull/(\d+)'    #   埋めた値はシェルの 1 語として引用符で守られる（雛形の穴を引用符で囲まないこと）。
//     hint: 'PR の番号'          #   hint は取れなかったとき Claude に見せる説明
//   repo: 'owner/name の形'     #   文字列なら Claude に見せる説明だけ（Claude が埋める）
// timeout: 1800                # 任意。hook 実行の上限（秒。既定 1800）。Stop で待ち合わせるのもここまで
// max_attempts: 3              # 任意。Claude 実行が失敗したときに組み立て直して再実行させる上限（既定 3）
// expires / projects / when_exists     # 任意。feedback ルールと同じ適用条件
// ---
// 本文（任意）: 補足指示。Claude 実行のときそのまま Claude に渡す。
//
// 保留は <followupDir>/.pending/<session>[--<agent>].json に置き（feedback の .ask_state と同じ流儀で、プロジェクトの
// 作業ツリーには書かない）、hook 実行のログ・終了コード・PID は <followupDir>/.runs/<id>.{log,exit,pid} に置く。
// エージェントごとに分けるので、サブエージェントの中で発火した後続コマンドはそのサブエージェントが引き取る。
//
// hook 自身のバグで作業を止めないよう、例外は握りつぶして exit 0 にする（.errors.jsonl に残す）。壊れた定義ファイルは
// そのファイルだけを飛ばし、理由を .errors.jsonl に記録する（feedback ルールと同じ）。
import { errorText, FRONTMATTER_RE, isRuleActive, loadYamlText, logError, parseExpires, stringList } from './feedback-rules.ts'
import { type Lang, tr } from './i18n.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { join } from './path.ts'
import { type Dict, isDict, jqStr, pyRegExp, toCount, truthy } from './pyutil.ts'
import { shellQuote } from './shell.ts'

/** 一度も実行されない保留（Claude 実行）を理由に Stop を続けてブロックする上限。これに達したら要求を取り下げる。 */
export const MAX_STOP_BLOCKS = 3
/** max_attempts の既定（Claude 実行の失敗で組み立て直させる回数）。 */
export const DEFAULT_MAX_ATTEMPTS = 3
/** timeout の既定（hook 実行の上限、秒）。Claude Code のバックグラウンド Bash の既定と同じ 30 分。 */
export const DEFAULT_TIMEOUT_S = 1800
/** Claude に渡す出力の上限（末尾の行数とバイト数）。全文はログに残す。 */
const OUTPUT_TAIL_LINES = 60
const OUTPUT_TAIL_BYTES = 8192
const DAY_MS = 24 * 60 * 60 * 1000
const POLL_MS = 1000

export type ArgSpec = {
  /** hook が埋める: この正規表現を from に当て、最初のキャプチャ（無ければ一致全体）を値にする。 */
  pattern?: string
  from: 'output' | 'command'
  /** Claude に見せる説明（hook で埋められなかったとき）。 */
  hint?: string
}

export type Followup = {
  name: string
  description: string
  /** きっかけ（Bash のコマンドにマッチする正規表現。Python re の書き方）。 */
  when: string
  unless?: string
  /** 後続コマンドの雛形。{{name}} が引数の穴。 */
  run: string
  args: Record<string, ArgSpec>
  timeout: number
  maxAttempts: number
  /** frontmatter の後の本文（補足指示）。 */
  body: string
  path: string
  expires?: number
  projects: string[]
  whenExists: string[]
}

/** 保留中の後続コマンド 1 件。 */
export type Pending = {
  name: string
  description: string
  /** hook: hook がバックグラウンドで起動し結果を回収する。claude: Claude に実行させ、実行を見届ける。 */
  mode: 'hook' | 'claude'
  run: string
  /** Claude に見せる引数の説明（Claude 実行）。 */
  hints: Record<string, string>
  body: string
  /** きっかけになったコマンド（表示用に 1 行へ畳んだもの）。 */
  trigger: string
  toolUseId: string
  /** 失敗した回数（Claude 実行）。 */
  attempts: number
  /** 一度でも実行された（失敗を含む）。Stop はこれが false の Claude 実行の保留だけを止める。 */
  attempted: boolean
  maxAttempts: number
  createdAt: number
  /** hook 実行: 埋めたコマンド、実行ファイルの id、開始時刻、上限（秒）、cwd。 */
  command?: string
  runId?: string
  started?: number
  timeout?: number
  cwd?: string
}

type PendingState = { entries: Pending[]; stopBlocks: number }

export type BrokenFollowup = { path: string; reason: string }

/** 後続コマンドの定義と状態の置き場（~/.claude/followup）。CLAUDE_FOLLOWUP_DIR で差し替え可能。 */
export function followupDir(io: Io): string {
  const override = io.env.CLAUDE_FOLLOWUP_DIR
  if (override) return override
  return join(io.env.HOME || '~', '.claude', 'followup')
}

/** プロジェクト固有の定義の置き場（<projectDir>/.claude/followup）。 */
export const projectFollowupDir = (io: Io, projectDir?: string): string => join(projectDir || io.projectDir || io.cwd, '.claude', 'followup')

const stateIdOf = (payload: Dict): string => {
  const sessionId = jqStr(payload.session_id) || 'unknown'
  const agentId = jqStr(payload.agent_id)
  return agentId ? `${sessionId}--${agentId}` : sessionId
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_')

export const pendingPath = (io: Io, stateId: string): string => join(followupDir(io), '.pending', `${safeName(stateId)}.json`)
const runsDir = (io: Io): string => join(followupDir(io), '.runs')
/** hook 実行のファイル: ログ（出力全文）、終了コード、PID。 */
export const runFiles = (io: Io, runId: string) => ({
  log: join(runsDir(io), `${runId}.log`),
  exit: join(runsDir(io), `${runId}.exit`),
  pid: join(runsDir(io), `${runId}.pid`),
})

// ---- 定義の読み込み ----

/** run の雛形に現れる引数の穴（{{name}}）。 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g

/** 雛形の穴の名前（出現順、重複なし）。 */
export const placeholders = (run: string): string[] => [...new Set([...run.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? ''))]

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 雛形から、引数を埋めたコマンドに一致する正規表現を作る（Claude 実行の見届け用）。穴は引用符付きの文字列か空白を
 * 含まない 1 語に、雛形の空白は任意の空白列に一致させる。前後は束縛しない（`cd x && ...` や ` 2>&1` を足しても一致する）。
 */
export function runRegExp(run: string): RegExp {
  let src = ''
  run.split(PLACEHOLDER_RE).forEach((part, i) => {
    if (i % 2 === 1) src += `(?:"[^"]*"|'[^']*'|\\S+)`
    else src += escapeRegExp(part).replace(/\s+/g, '\\s+')
  })
  return new RegExp(src)
}

/** args を正規化する。文字列は説明だけ、辞書は pattern / from / hint。pattern が使えない正規表現なら例外。 */
function argsOf(lang: Lang, raw: unknown): Record<string, ArgSpec> {
  const out: Record<string, ArgSpec> = {}
  if (!isDict(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (isDict(v)) {
      const spec: ArgSpec = { from: v.from === 'command' ? 'command' : 'output' }
      if (truthy(v.pattern)) {
        try {
          pyRegExp(String(v.pattern))
        } catch (e) {
          throw new Error(tr(lang)('followup.badRegex', { key: `args.${k}.pattern`, error: errorText(e) }))
        }
        spec.pattern = String(v.pattern)
      }
      if (truthy(v.hint)) spec.hint = String(v.hint)
      out[k] = spec
    } else if (truthy(v)) {
      out[k] = { from: 'output', hint: String(v) }
    }
  }
  return out
}

/**
 * 1 つの定義ファイルを読む。frontmatter が無ければ null。frontmatter が読めない、when / run が無い、when / unless /
 * args.*.pattern が使えない正規表現なら例外を投げる（listFollowupsIn がそのファイルだけを飛ばして記録する）。
 */
export async function loadFollowup(io: Io, path: string): Promise<Followup | null> {
  const content = await io.readFile(path)
  if (content === undefined) return null
  const m = FRONTMATTER_RE.exec(content)
  if (!m) return null
  const data = loadYamlText(m[1] ?? '')
  if (!isDict(data)) return null
  const t = tr(io.lang)
  for (const key of ['when', 'run']) if (!truthy(data[key])) throw new Error(t('followup.missingKey', { key }))
  for (const key of ['when', 'unless']) {
    const v = data[key]
    if (!truthy(v)) continue
    try {
      pyRegExp(String(v))
    } catch (e) {
      throw new Error(t('followup.badRegex', { key, error: errorText(e) }))
    }
  }
  const file = path.slice(path.lastIndexOf('/') + 1)
  const maxAttempts = toCount(data.max_attempts)
  const timeout = toCount(data.timeout)
  return {
    name: truthy(data.name) ? String(data.name) : file.replace(/\.md$/, ''),
    description: truthy(data.description) ? String(data.description) : '',
    when: String(data.when),
    ...(truthy(data.unless) ? { unless: String(data.unless) } : {}),
    run: String(data.run).trim(),
    args: argsOf(io.lang, data.args),
    timeout: timeout > 0 ? timeout : DEFAULT_TIMEOUT_S,
    maxAttempts: maxAttempts > 0 ? maxAttempts : DEFAULT_MAX_ATTEMPTS,
    body: content.slice(m[0].length).trim(),
    path,
    expires: parseExpires(data.expires),
    projects: stringList(data.projects),
    whenExists: stringList(data.when_exists),
  }
}

async function listFollowupsIn(io: Io, dir: string, broken: BrokenFollowup[]): Promise<Followup[]> {
  const out: Followup[] = []
  const names = (await io.list(dir))
    .filter((e) => e.kind === 'file' && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
  for (const name of names) {
    const path = join(dir, name)
    try {
      const f = await loadFollowup(io, path)
      if (f) out.push(f)
    } catch (e) {
      broken.push({ path, reason: tr(io.lang)('followup.unreadable', { error: errorText(e) }) })
    }
  }
  return out
}

/** グローバルとプロジェクトの定義を読み、同名はプロジェクト側を優先してマージし、expires / projects / when_exists で絞る。 */
export async function scanFollowups(io: Io): Promise<{ followups: Followup[]; broken: BrokenFollowup[] }> {
  const broken: BrokenFollowup[] = []
  const globalDir = followupDir(io)
  const projectDir = projectFollowupDir(io)
  const globalOnes = await listFollowupsIn(io, globalDir, broken)
  let merged = globalOnes
  if (projectDir !== globalDir) {
    const projectOnes = await listFollowupsIn(io, projectDir, broken)
    const overridden = new Set(projectOnes.map((f) => f.name))
    merged = [...globalOnes.filter((f) => !overridden.has(f.name)), ...projectOnes]
  }
  const active: Followup[] = []
  for (const f of merged) if (await isRuleActive(io, f)) active.push(f)
  return { followups: active, broken }
}

/** scanFollowups と同じで、壊れた定義を .errors.jsonl に記録する。 */
export async function listFollowups(io: Io): Promise<Followup[]> {
  const { followups, broken } = await scanFollowups(io)
  for (const b of broken) await logError(io, 'followup', b.reason, b.path)
  return followups
}

// ---- 引数の解決 ----

/** きっかけの出力（stdout + stderr）。tool_response に無ければ空。 */
export const outputOf = (payload: Dict): string => {
  const r = payload.tool_response
  if (!isDict(r)) return ''
  return [jqStr(r.stdout), jqStr(r.stderr)].filter((s) => s !== '').join('\n')
}

/**
 * 雛形の穴を hook で埋める。すべて埋まれば埋めたコマンド、1 つでも埋まらなければ undefined（Claude に埋めさせる）。
 * 値はシェルの 1 語として引用符で守る（出力から取る値は第三者が書けるので、雛形に素のまま差し込まない）。
 */
export function resolveArgs(f: Followup, command: string, output: string): { command: string; values: Record<string, string> } | undefined {
  const values: Record<string, string> = {}
  for (const name of placeholders(f.run)) {
    const spec = f.args[name]
    if (!spec?.pattern) return undefined
    const m = pyRegExp(spec.pattern).exec(spec.from === 'command' ? command : output)
    if (!m) return undefined
    const value = (m[1] ?? m[0]).trim()
    if (value === '') return undefined
    values[name] = value
  }
  const filled = f.run.replace(PLACEHOLDER_RE, (_, name: string) => shellQuote(values[name] ?? ''))
  return { command: filled, values }
}

/** Claude に見せる引数の説明。 */
const hintsOf = (f: Followup): Record<string, string> => Object.fromEntries(Object.entries(f.args).flatMap(([k, v]) => (v.hint ? [[k, v.hint]] : [])))

// ---- 保留状態 ----

async function loadPending(io: Io, stateId: string, now: number): Promise<PendingState> {
  try {
    const text = await io.readFile(pendingPath(io, stateId))
    if (text === undefined) return { entries: [], stopBlocks: 0 }
    const data: unknown = JSON.parse(text)
    if (!isDict(data) || !Array.isArray(data.entries)) return { entries: [], stopBlocks: 0 }
    // 古い保留（クラッシュなどの残骸）は捨てる。
    const entries = data.entries.filter(
      (e): e is Pending => isDict(e) && typeof e.run === 'string' && typeof e.createdAt === 'number' && e.createdAt >= now - DAY_MS,
    )
    return { entries, stopBlocks: toCount(data.stopBlocks) }
  } catch {
    return { entries: [], stopBlocks: 0 }
  }
}

async function savePending(io: Io, stateId: string, state: PendingState): Promise<void> {
  const path = pendingPath(io, stateId)
  if (state.entries.length === 0) {
    await io.removeFiles([path])
    return
  }
  await io.writeFile(path, `${JSON.stringify(state)}\n`)
}

/** 保留中の後続コマンド（テスト・参照用）。 */
export const loadPendingEntries = async (io: Io, stateId: string): Promise<Pending[]> => (await loadPending(io, stateId, await io.now())).entries

// ---- 表示 ----

/** コマンドを表示用の 1 行にする（先頭行、長ければ切る）。 */
export function oneLine(command: string, max = 120): string {
  const first =
    command
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? ''
  return first.length > max ? `${first.slice(0, max)} ...` : first
}

const labelOf = (p: { name: string; description: string }): string => (p.description ? `${p.name}: ${p.description}` : p.name)

/** Claude 実行の指示。 */
export function instructionText(lang: Lang, p: Pending): string {
  const t = tr(lang)
  const lines = [t('followup.triggered', { command: p.trigger, label: labelOf(p) }), `  ${p.run}`]
  const names = placeholders(p.run)
  if (names.length > 0) {
    lines.push(t('followup.argsHeader'))
    for (const n of names) lines.push(`  {{${n}}}: ${p.hints[n] ?? t('followup.argNoHint')}`)
  }
  if (p.body) lines.push(p.body)
  lines.push(t('followup.instruction'))
  return lines.join('\n')
}

/** 出力の末尾（行数とバイト数で切る）。切ったら先頭に省略の行を付ける。 */
export function outputTail(lang: Lang, text: string): string {
  const lines = text.replace(/\n+$/, '').split('\n')
  let kept = lines.slice(-OUTPUT_TAIL_LINES)
  while (kept.length > 1 && kept.join('\n').length > OUTPUT_TAIL_BYTES) kept = kept.slice(1)
  const omitted = lines.length - kept.length
  const body = kept.join('\n')
  return omitted > 0 ? `${tr(lang)('followup.outputOmitted', { n: omitted })}\n${body}` : body
}

const context = (event: string, body: string): ScriptResult =>
  ok(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: body } })}\n`)

const commandOf = (payload: Dict): string => jqStr(isDict(payload.tool_input) ? payload.tool_input.command : undefined)

/** Claude 実行の保留のうち、このコマンドが後続コマンドとして一致する最初のもの（古い順）。 */
const matchPending = (entries: Pending[], command: string): Pending | undefined => entries.find((p) => p.mode === 'claude' && runRegExp(p.run).test(command))

// ---- hook 実行（バックグラウンド） ----

// 起動スクリプト。$1 = コマンド、$2 = ログ、$3 = 終了コードのファイル、$4 = PID のファイル。コマンドは自分のシェルで
// 走らせ、終わったら終了コードを書く。hook のプロセス（$.process.run）が返っても生き残るよう、setsid があれば新しい
// セッションで（PID はそのグループのリーダーになるので、timeout では -PID でまとめて止められる）、無ければ nohup で起動する。
// 標準入出力はすべてファイルか /dev/null に向け、hook 側のパイプを握ったままにしない。
const LAUNCH_SCRIPT = [
  'runner=\'sh -c "$1" </dev/null >>"$2" 2>&1; echo $? >"$3"\'',
  'if command -v setsid >/dev/null 2>&1; then setsid sh -c "$runner" sh "$1" "$2" "$3" </dev/null >/dev/null 2>&1 &',
  'else nohup sh -c "$runner" sh "$1" "$2" "$3" </dev/null >/dev/null 2>&1 & fi',
  'echo $! >"$4"',
].join('\n')

async function launch(io: Io, f: Followup, command: string, trigger: string, payload: Dict, now: number): Promise<Pending | undefined> {
  const runId = `${safeName(stateIdOf(payload))}.${Math.floor(now)}-${Math.random().toString(36).slice(2, 8)}`
  const files = runFiles(io, runId)
  const cwd = jqStr(payload.cwd) || io.cwd
  const projectDir = io.projectDir || io.cwd
  await io.writeFile(files.log, `$ ${command}  (cwd: ${cwd})\n`)
  const r = await io.run(['sh', '-c', LAUNCH_SCRIPT, 'sh', command, files.log, files.exit, files.pid], {
    cwd,
    env: { CLAUDE_PROJECT_DIR: projectDir },
    timeoutMs: 10_000,
  })
  if (r.exitCode !== 0 || r.error !== undefined) {
    await logError(io, 'followup', `launch failed: ${r.error ?? r.stderr}`, f.path)
    await io.removeFiles([files.log, files.exit, files.pid])
    return undefined
  }
  return {
    name: f.name,
    description: f.description,
    mode: 'hook',
    run: f.run,
    hints: hintsOf(f),
    body: f.body,
    trigger,
    toolUseId: jqStr(payload.tool_use_id),
    attempts: 0,
    attempted: true,
    maxAttempts: f.maxAttempts,
    createdAt: now,
    command,
    runId,
    started: now,
    timeout: f.timeout,
    cwd,
  }
}

const readExit = async (io: Io, exitFile: string): Promise<number | undefined> => {
  const text = await io.readFile(exitFile)
  if (text === undefined || !/^\s*\d+\s*$/.test(text)) return undefined
  return Number.parseInt(text.trim(), 10)
}

const pidAlive = async (io: Io, pidFile: string): Promise<boolean> => {
  const pid = ((await io.readFile(pidFile)) ?? '').trim()
  if (!/^\d+$/.test(pid)) return false
  return (await io.run(['sh', '-c', 'kill -0 "$1" 2>/dev/null', 'sh', pid], { timeoutMs: 5_000 })).exitCode === 0
}

const killRun = async (io: Io, pidFile: string): Promise<void> => {
  const pid = ((await io.readFile(pidFile)) ?? '').trim()
  if (!/^\d+$/.test(pid)) return
  // プロセスグループ（setsid で起動したので PID = グループ）ごと止める。`kill -s TERM -- -PID` は dash / bash / zsh で通る書き方
  // （`kill -TERM -- -PID` は dash が受け付けない）。グループで止められなければ PID だけでも止める。
  await io.run(['sh', '-c', 'kill -s TERM -- "-$1" 2>/dev/null || kill -s TERM "$1" 2>/dev/null', 'sh', pid], { timeoutMs: 5_000 })
}

type RunOutcome = { kind: 'done'; code: number } | { kind: 'timeout' } | { kind: 'lost' }

/** hook 実行の保留が終わっていればその結果、まだ走っていれば undefined。 */
async function outcomeOf(io: Io, p: Pending, now: number): Promise<RunOutcome | undefined> {
  if (!p.runId) return { kind: 'lost' }
  const files = runFiles(io, p.runId)
  const code = await readExit(io, files.exit)
  if (code !== undefined) return { kind: 'done', code }
  if (now >= (p.started ?? p.createdAt) + (p.timeout ?? DEFAULT_TIMEOUT_S) * 1000) return { kind: 'timeout' }
  if (!(await pidAlive(io, files.pid))) {
    // 終了コードを書く前に消えた（kill や再起動）。少し待ってもう一度だけ見る（exit を書く直前かもしれない）。
    await io.run(['sleep', '0.2'])
    const late = await readExit(io, files.exit)
    return late !== undefined ? { kind: 'done', code: late } : { kind: 'lost' }
  }
  return undefined
}

/** 終わった hook 実行の結果を Claude に渡す文面にし、実行ファイルを片付ける。 */
async function resultText(io: Io, p: Pending, outcome: RunOutcome, now: number): Promise<string> {
  const t = tr(io.lang)
  const files = p.runId ? runFiles(io, p.runId) : undefined
  const log = files ? ((await io.readFile(files.log)) ?? '') : ''
  const command = oneLine(p.command ?? p.run)
  const seconds = Math.round((now - (p.started ?? p.createdAt)) / 1000)
  let head: string
  if (outcome.kind === 'done') head = t('followup.result', { command, name: p.name, code: outcome.code, seconds, log: files?.log ?? '' })
  else if (outcome.kind === 'timeout') {
    if (files) await killRun(io, files.pid)
    head = t('followup.resultTimeout', { command, name: p.name, timeout: p.timeout ?? DEFAULT_TIMEOUT_S, log: files?.log ?? '' })
  } else head = t('followup.resultLost', { command, name: p.name, log: files?.log ?? '' })
  // 出力はログに残し、ここでは末尾だけ渡す。ログの先頭行（$ コマンド）は除く。
  const body = outputTail(io.lang, log.split('\n').slice(1).join('\n'))
  if (files) await io.removeFiles([files.exit, files.pid])
  return body === '' ? head : `${head}\n${body}`
}

/**
 * この状態 ID の hook 実行のうち終わったものを回収し、保留から外して文面を返す。wait が真なら、走っているものは
 * timeout まで待ち合わせる（Stop 用）。
 */
async function collect(io: Io, stateId: string, state: PendingState, wait: boolean): Promise<string[]> {
  const notes: string[] = []
  const t = tr(io.lang)
  for (const p of state.entries.filter((e) => e.mode === 'hook')) {
    let now = await io.now()
    let outcome = await outcomeOf(io, p, now)
    while (outcome === undefined && wait) {
      io.progress?.(t('followup.waiting', { command: oneLine(p.command ?? p.run, 60), seconds: Math.floor((now - (p.started ?? p.createdAt)) / 1000) }))
      await io.run(['sleep', String(POLL_MS / 1000)])
      now = await io.now()
      outcome = await outcomeOf(io, p, now)
    }
    if (outcome === undefined) continue
    notes.push(await resultText(io, p, outcome, now))
    state.entries = state.entries.filter((e) => e !== p)
  }
  if (notes.length > 0) await savePending(io, stateId, state)
  return notes
}

// ---- PostToolUse（どのツールでも）/ UserPromptSubmit: 終わった hook 実行の結果を渡す ----

async function collectStep(io: Io, payload: Dict, event: string): Promise<ScriptResult> {
  const stateId = stateIdOf(payload)
  const state = await loadPending(io, stateId, await io.now())
  if (!state.entries.some((e) => e.mode === 'hook')) return ok()
  const notes = await collect(io, stateId, state, false)
  if (notes.length === 0) return ok()
  const body = notes.join('\n\n')
  return event === 'UserPromptSubmit' ? ok(body) : context(event, body)
}

/** 終わった hook 実行の結果があれば additionalContext で渡す（PostToolUse のどのツールでも、UserPromptSubmit でも）。 */
export async function followupCollect(io: Io, payload: Dict, event = 'PostToolUse'): Promise<ScriptResult> {
  try {
    return await collectStep(io, payload, event)
  } catch (e) {
    await logError(io, 'followup', errorText(e))
    return ok('', `[followup] internal error (ignored): ${errorText(e)}\n`)
  }
}

// ---- PostToolUse(Bash) ----

async function afterBash(io: Io, payload: Dict): Promise<ScriptResult> {
  const command = commandOf(payload)
  if (command === '') return ok()
  const followups = await listFollowups(io)
  const stateId = stateIdOf(payload)
  const now = await io.now()
  const state = await loadPending(io, stateId, now)
  if (followups.length === 0 && state.entries.length === 0) return ok()
  const t = tr(io.lang)
  const notes: string[] = []
  let changed = false

  // 1. 終わった hook 実行の結果。
  notes.push(...(await collect(io, stateId, state, false)))

  // 2. Claude 実行の保留に一致するコマンドが成功した。
  const done = matchPending(state.entries, command)
  if (done) {
    state.entries = state.entries.filter((p) => p !== done)
    changed = true
    notes.push(t('followup.done', { command: oneLine(command), name: done.name }))
  }

  // 3. きっかけに一致したら、hook で埋まれば起動し、埋まらなければ Claude に求める。後続コマンド自身がそのきっかけに一致しても
  //    （`gh pr` の後に `gh pr checks` など）同じ定義を再発火させない。
  const trigger = oneLine(command)
  const output = outputOf(payload)
  for (const f of followups) {
    if (done?.name === f.name) continue
    if (!pyRegExp(f.when).test(command)) continue
    if (f.unless !== undefined && pyRegExp(f.unless).test(command)) continue
    const resolved = resolveArgs(f, command, output)
    if (resolved) {
      const p = await launch(io, f, resolved.command, trigger, payload, now)
      if (p) {
        state.entries.push(p)
        changed = true
        notes.push(t('followup.started', { trigger, label: labelOf(f), command: resolved.command }))
        continue
      }
      // 起動できなければ Claude に求める。
    }
    const p: Pending = {
      name: f.name,
      description: f.description,
      mode: 'claude',
      run: f.run,
      hints: hintsOf(f),
      body: f.body,
      trigger,
      toolUseId: jqStr(payload.tool_use_id),
      attempts: 0,
      attempted: false,
      maxAttempts: f.maxAttempts,
      createdAt: now,
    }
    state.entries.push(p)
    changed = true
    notes.push(instructionText(io.lang, p))
  }

  if (changed) await savePending(io, stateId, state)
  return notes.length > 0 ? context('PostToolUse', notes.join('\n\n')) : ok()
}

/** PostToolUse(Bash): きっかけに一致したら後続コマンドを起動するか実行を求め、保留中の後続コマンドが成功したら完了を伝える。 */
export async function followupAfterBash(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await afterBash(io, payload)
  } catch (e) {
    await logError(io, 'followup', errorText(e))
    return ok('', `[followup] internal error (ignored): ${errorText(e)}\n`)
  }
}

// ---- PostToolUseFailure(Bash) ----

async function afterBashFailure(io: Io, payload: Dict): Promise<ScriptResult> {
  const command = commandOf(payload)
  if (command === '') return ok()
  const stateId = stateIdOf(payload)
  const state = await loadPending(io, stateId, await io.now())
  const p = matchPending(state.entries, command)
  if (!p) return ok()
  const t = tr(io.lang)
  if (payload.is_interrupt === true) {
    // ユーザーが止めたのなら、その後続コマンドは求めない。
    state.entries = state.entries.filter((x) => x !== p)
    await savePending(io, stateId, state)
    return ok()
  }
  p.attempts += 1
  p.attempted = true
  if (p.attempts >= p.maxAttempts) {
    state.entries = state.entries.filter((x) => x !== p)
    await savePending(io, stateId, state)
    return context('PostToolUseFailure', t('followup.gaveUp', { name: p.name, max: p.maxAttempts }))
  }
  await savePending(io, stateId, state)
  return context('PostToolUseFailure', t('followup.failed', { command: oneLine(command), name: p.name, attempt: p.attempts, max: p.maxAttempts }))
}

/** PostToolUseFailure(Bash): 保留中の後続コマンド（Claude 実行）が失敗したら、理由を見て組み立て直すよう伝える（上限で打ち切り）。 */
export async function followupAfterBashFailure(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await afterBashFailure(io, payload)
  } catch (e) {
    await logError(io, 'followup', errorText(e))
    return ok('', `[followup] internal error (ignored): ${errorText(e)}\n`)
  }
}

// ---- Stop / SubagentStop ----

const block = (reason: string): ScriptResult => ({ exitCode: 2, stdout: `${JSON.stringify({ decision: 'block', reason })}\n`, stderr: `${reason}\n` })

async function stopCheck(io: Io, payload: Dict): Promise<ScriptResult> {
  const stateId = stateIdOf(payload)
  const state = await loadPending(io, stateId, await io.now())
  const t = tr(io.lang)

  // hook 実行: 走っているものは終了（または timeout）まで待ち合わせ、結果を理由にして一度止める（Claude が報告してから終わる）。
  const results = await collect(io, stateId, state, true)
  if (results.length > 0) return block(results.join('\n\n'))

  // Claude 実行: 一度も実行されていない保留があれば実行を求める。
  const waiting = state.entries.filter((p) => p.mode === 'claude' && !p.attempted)
  if (waiting.length === 0) {
    if (state.stopBlocks !== 0) {
      state.stopBlocks = 0
      await savePending(io, stateId, state)
    }
    return ok()
  }
  state.stopBlocks += 1
  if (state.stopBlocks >= MAX_STOP_BLOCKS) {
    // 諦める: 一度も実行されない保留を捨て、実行済みの保留（失敗の再試行待ち）は残す。
    state.entries = state.entries.filter((p) => p.attempted)
    state.stopBlocks = 0
    await savePending(io, stateId, state)
    return ok('', `${t('followup.stopGaveUp', { max: MAX_STOP_BLOCKS })}\n`)
  }
  await savePending(io, stateId, state)
  const lines = [t('followup.stopHeader', { attempt: state.stopBlocks, max: MAX_STOP_BLOCKS })]
  for (const p of waiting) lines.push(t('followup.stopItem', { label: labelOf(p), run: p.run, command: p.trigger }))
  return block(lines.join('\n'))
}

/**
 * Stop / SubagentStop: 走っている hook 実行は終わるまで待って結果を渡し（一度ブロック）、一度も実行されていない
 * Claude 実行の保留があれば停止をブロックする（MAX_STOP_BLOCKS 回で諦める）。
 */
export async function followupStopCheck(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await stopCheck(io, payload)
  } catch (e) {
    await logError(io, 'followup', errorText(e))
    return ok('', `[followup] internal error (ignored): ${errorText(e)}\n`)
  }
}

// ---- SessionStart ----

/** SessionStart: startup / clear なら自セッションの保留と実行ファイルを消す。24 時間より古いものはいつでも消す。 */
export async function resetFollowups(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    const sessionId = safeName(jqStr(payload.session_id) || 'unknown')
    const source = jqStr(payload.source)
    const fresh = source === 'startup' || source === 'clear'
    const now = await io.now()
    const doomed: string[] = []
    for (const [dir, ext] of [
      [join(followupDir(io), '.pending'), '.json'],
      [runsDir(io), ''],
    ] as const) {
      for (const e of await io.list(dir)) {
        if (e.kind !== 'file' || !e.name.endsWith(ext)) continue
        const mine = e.name.startsWith(`${sessionId}.`) || e.name.startsWith(`${sessionId}--`)
        if ((mine && fresh) || e.mtimeMs < now - DAY_MS) doomed.push(join(dir, e.name))
      }
    }
    await io.removeFiles(doomed)
  } catch {
    // 掃除の失敗で作業を止めない。
  }
  return ok()
}
