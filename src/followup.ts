// 後続コマンド（followup）: あるコマンドを実行したら、人間が .md に書いておいた次のコマンドをバックグラウンドで実行させ、その結果を
// Claude に返す。
//
// 例: `gh pr create` を実行したら `gh pr checks {{pr}} --watch` を続けて実行し、その結果を報告させる。
// Claude Code のバックグラウンド実行はコマンドを Claude が決めるので見当違いなことがある。ここでは「きっかけ」と
// 「実行するコマンド」は人間が定義ファイルに書き、コマンドの引数（{{pr}} のような穴）だけを埋める。
//
// 役割分担:
// - 引数: 定義の args に正規表現（pattern）があれば、hook がきっかけのコマンドの出力（PostToolUse の tool_response）か
//   コマンド文字列から取り出して埋める。埋まらない穴だけ Claude が直前の出力から推測して埋める（hook はモデルを呼べない）。
// - 実行: Claude の Bash で、必ずバックグラウンド（run_in_background: true）で起動させる。前景で起動しようとしたら
//   PreToolUse で止めて背景で打ち直させる（followupGuard）。前景だと Bash ツールの時間制限（最長 10 分）で切られる
//   ことがあり、CI の完了待ちのような長いコマンドに向かない。
// - 結果: バックグラウンドのタスクが終わると Claude Code 自身が結果を Claude に渡し、待機中でも起こす（task-notification）。
//   hook はここに関与しない。Claude が終了しようとした時点でコマンドが終わっていなくても Stop は待たない（待つと
//   その間ユーザーが何もできない）。
// - 見届け: 保留（pending）に積んだ後続コマンドが起動されるまで、Stop をブロックする（MAX_STOP_BLOCKS 回で諦める）。
//   起動されたか（雛形の穴を任意の引数として読んだパターンに一致する Bash がバックグラウンドで始まったか、前景で成功したか）は
//   PostToolUse(Bash) で見る。起動自体が失敗したら（PostToolUseFailure）理由を見て組み立て直させる（max_attempts で打ち切り）。
//   バックグラウンドで走ったコマンドが引数の誤りで失敗したときは、Claude Code が渡す結果を見て組み立て直すよう、起動時に
//   伝えておく（hook はその失敗を見られない）。
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
//     from: output             #   既定 output）に pattern（正規表現。最初のキャプチャ、無ければ一致全体）を当てる。
//     pattern: 'pull/(\d+)'    #   埋めた値はシェルの 1 語として引用符で守られる（雛形の穴を引用符で囲まないこと）。
//     hint: 'PR の番号'          #   hint は取れなかったとき Claude に見せる説明
//   repo: 'owner/name の形'     #   文字列なら Claude に見せる説明だけ（Claude が埋める）
// timeout: 3600                # 任意。Bash の timeout（秒）として指定させる。省略時は Claude Code の既定（バックグラウンドは 30 分）
// max_attempts: 3              # 任意。起動が失敗したときに組み立て直して再実行させる上限（既定 3）
// expires / projects / when_exists     # 任意。feedback ルールと同じ適用条件
// ---
// 本文（任意）: 補足指示。そのまま Claude に渡す。
//
// 保留は <followupDir>/.pending/<session>[--<agent>].json に置く（feedback の .ask_state と同じ流儀で、プロジェクトの
// 作業ツリーには書かない）。エージェントごとに分けるので、サブエージェントの中で発火した後続コマンドはそのサブ
// エージェントが起動する。PreToolUse にはエージェント ID が入らないので、followupGuard はセッションの全エージェントの保留を見る。
//
// hook 自身のバグで作業を止めないよう、例外は握りつぶして exit 0 にする（.errors.jsonl に残す）。壊れた定義ファイルは
// そのファイルだけを飛ばし、理由を .errors.jsonl に記録する（feedback ルールと同じ）。
import { errorText, FRONTMATTER_RE, isRuleActive, loadYamlText, logError, parseExpires, stringList } from './feedback-rules.ts'
import { type Lang, tr } from './i18n.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { join } from './path.ts'
import { type Dict, isDict, jqStr, pyRegExp, toCount, truthy } from './pyutil.ts'
import { shellQuote } from './shell.ts'

/** 一度も起動されない保留を理由に Stop を続けてブロックする上限。これに達したら要求を取り下げる。 */
export const MAX_STOP_BLOCKS = 3
/** max_attempts の既定（起動の失敗で組み立て直させる回数）。 */
export const DEFAULT_MAX_ATTEMPTS = 3
const DAY_MS = 24 * 60 * 60 * 1000

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
  /** Bash の timeout として指定させる秒数。未指定なら Claude Code の既定。 */
  timeout?: number
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
  run: string
  /** hook が引数を埋めたコマンド。埋められなかったときは undefined（Claude が埋める）。 */
  command?: string
  /** Claude に見せる引数の説明。 */
  hints: Record<string, string>
  body: string
  /** きっかけになったコマンド（表示用に 1 行へ畳んだもの）。 */
  trigger: string
  toolUseId: string
  /** 起動が失敗した回数。 */
  attempts: number
  /** 一度でも起動された（失敗を含む）。Stop はこれが false の保留だけを止める。 */
  attempted: boolean
  maxAttempts: number
  timeout?: number
  createdAt: number
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

const pendingDir = (io: Io): string => join(followupDir(io), '.pending')
export const pendingPath = (io: Io, stateId: string): string => join(pendingDir(io), `${safeName(stateId)}.json`)

// ---- 定義の読み込み ----

/** run の雛形に現れる引数の穴（{{name}}）。 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g

/** 雛形の穴の名前（出現順、重複なし）。 */
export const placeholders = (run: string): string[] => [...new Set([...run.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? ''))]

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 雛形から、引数を埋めたコマンドに一致する正規表現を作る（起動の見届け用）。穴は引用符付きの文字列か空白を含まない
 * 1 語に、雛形の空白は任意の空白列に一致させる。前後は束縛しない（`cd x && ...` や ` 2>&1` を足しても一致する）。
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
    ...(timeout > 0 ? { timeout } : {}),
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
export function resolveArgs(
  f: Pick<Followup, 'run' | 'args'>,
  command: string,
  output: string,
): { command: string; values: Record<string, string> } | undefined {
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

function parsePending(text: string | undefined, now: number): PendingState {
  if (text === undefined) return { entries: [], stopBlocks: 0 }
  try {
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

const loadPending = async (io: Io, stateId: string, now: number): Promise<PendingState> => parsePending(await io.readFile(pendingPath(io, stateId)), now)

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

/** セッションの全エージェント（<session>.json と <session>--*.json）の保留。PreToolUse にはエージェント ID が入らないので、これで見る。 */
async function loadSessionPending(io: Io, sessionId: string, now: number): Promise<Pending[]> {
  const dir = pendingDir(io)
  const prefix = safeName(sessionId)
  const out: Pending[] = []
  for (const e of await io.list(dir)) {
    if (e.kind !== 'file' || !(e.name === `${prefix}.json` || (e.name.startsWith(`${prefix}--`) && e.name.endsWith('.json')))) continue
    out.push(...parsePending(await io.readFile(join(dir, e.name)), now).entries)
  }
  return out
}

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

/** 発火時に Claude へ渡す指示。引数が埋まっていればそのコマンドを、埋まっていなければ雛形と埋め方を見せる。 */
export function instructionText(lang: Lang, p: Pending): string {
  const t = tr(lang)
  const lines: string[] = []
  if (p.command !== undefined) {
    lines.push(t('followup.triggeredFilled', { command: p.trigger, label: labelOf(p) }), `  ${p.command}`)
  } else {
    lines.push(t('followup.triggered', { command: p.trigger, label: labelOf(p) }), `  ${p.run}`)
    const names = placeholders(p.run)
    if (names.length > 0) {
      lines.push(t('followup.argsHeader'))
      for (const n of names) lines.push(`  {{${n}}}: ${p.hints[n] ?? t('followup.argNoHint')}`)
    }
  }
  if (p.body) lines.push(p.body)
  lines.push(p.timeout !== undefined ? t('followup.instructionTimeout', { ms: p.timeout * 1000 }) : t('followup.instruction'))
  return lines.join('\n')
}

const context = (event: string, body: string): ScriptResult =>
  ok(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: body } })}\n`)

const commandOf = (payload: Dict): string => jqStr(isDict(payload.tool_input) ? payload.tool_input.command : undefined)

/** 保留のうち、このコマンドが後続コマンドとして一致する最初のもの（古い順）。 */
const matchPending = (entries: Pending[], command: string): Pending | undefined => entries.find((p) => runRegExp(p.run).test(command))

/** バックグラウンドで起動された Bash か（tool_input の run_in_background、または tool_response の backgroundTaskId）。 */
const inBackground = (payload: Dict): boolean =>
  (isDict(payload.tool_input) && payload.tool_input.run_in_background === true) ||
  (isDict(payload.tool_response) && truthy(payload.tool_response.backgroundTaskId))

// ---- PreToolUse(Bash): 後続コマンドは背景で ----

async function guard(io: Io, payload: Dict): Promise<ScriptResult> {
  const command = commandOf(payload)
  if (command === '' || (isDict(payload.tool_input) && payload.tool_input.run_in_background === true)) return ok()
  const entries = await loadSessionPending(io, jqStr(payload.session_id) || 'unknown', await io.now())
  const p = matchPending(entries, command)
  if (!p) return ok()
  const reason = tr(io.lang)('followup.foreground', { name: p.name, command: oneLine(command) })
  return ok(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`)
}

/** PreToolUse(Bash): 保留中の後続コマンドを前景で起動しようとしたら deny し、run_in_background: true で打ち直させる。 */
export async function followupGuard(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await guard(io, payload)
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

  // 1. 保留中の後続コマンドが起動された（背景で始まった、または前景で成功した）。
  const done = matchPending(state.entries, command)
  if (done) {
    state.entries = state.entries.filter((p) => p !== done)
    changed = true
    notes.push(t(inBackground(payload) ? 'followup.launched' : 'followup.done', { command: oneLine(command), name: done.name }))
  }

  // 2. きっかけに一致したら保留に積んで起動を求める。後続コマンド自身がそのきっかけに一致しても（`gh pr` の後に `gh pr checks` など）
  //    同じ定義を再発火させない。
  const trigger = oneLine(command)
  const output = outputOf(payload)
  for (const f of followups) {
    if (done?.name === f.name) continue
    if (!pyRegExp(f.when).test(command)) continue
    if (f.unless !== undefined && pyRegExp(f.unless).test(command)) continue
    const resolved = resolveArgs(f, command, output)
    const p: Pending = {
      name: f.name,
      description: f.description,
      run: f.run,
      ...(resolved ? { command: resolved.command } : {}),
      hints: hintsOf(f),
      body: f.body,
      trigger,
      toolUseId: jqStr(payload.tool_use_id),
      attempts: 0,
      attempted: false,
      maxAttempts: f.maxAttempts,
      ...(f.timeout !== undefined ? { timeout: f.timeout } : {}),
      createdAt: now,
    }
    state.entries.push(p)
    changed = true
    notes.push(instructionText(io.lang, p))
  }

  if (changed) await savePending(io, stateId, state)
  return notes.length > 0 ? context('PostToolUse', notes.join('\n\n')) : ok()
}

/** PostToolUse(Bash): きっかけに一致したら後続コマンドの起動を求め、保留中の後続コマンドが起動されたら保留を消して伝える。 */
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

/** PostToolUseFailure(Bash): 保留中の後続コマンドの起動が失敗したら、理由を見て組み立て直すよう伝える（上限で打ち切り）。 */
export async function followupAfterBashFailure(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await afterBashFailure(io, payload)
  } catch (e) {
    await logError(io, 'followup', errorText(e))
    return ok('', `[followup] internal error (ignored): ${errorText(e)}\n`)
  }
}

// ---- Stop / SubagentStop ----

async function stopCheck(io: Io, payload: Dict): Promise<ScriptResult> {
  const stateId = stateIdOf(payload)
  const state = await loadPending(io, stateId, await io.now())
  const waiting = state.entries.filter((p) => !p.attempted)
  if (waiting.length === 0) {
    if (state.stopBlocks !== 0) {
      state.stopBlocks = 0
      await savePending(io, stateId, state)
    }
    return ok()
  }
  const t = tr(io.lang)
  state.stopBlocks += 1
  if (state.stopBlocks >= MAX_STOP_BLOCKS) {
    // 諦める: 一度も起動されない保留を捨て、起動済みの保留（失敗の再試行待ち）は残す。
    state.entries = state.entries.filter((p) => p.attempted)
    state.stopBlocks = 0
    await savePending(io, stateId, state)
    return ok('', `${t('followup.stopGaveUp', { max: MAX_STOP_BLOCKS })}\n`)
  }
  await savePending(io, stateId, state)
  const lines = [t('followup.stopHeader', { attempt: state.stopBlocks, max: MAX_STOP_BLOCKS })]
  for (const p of waiting) lines.push(t('followup.stopItem', { label: labelOf(p), run: p.command ?? p.run, command: p.trigger }))
  const reason = lines.join('\n')
  return { exitCode: 2, stdout: `${JSON.stringify({ decision: 'block', reason })}\n`, stderr: `${reason}\n` }
}

/** Stop / SubagentStop: 一度も起動されていない後続コマンドがあれば停止をブロックする（MAX_STOP_BLOCKS 回で諦める）。起動済みのものは待たない。 */
export async function followupStopCheck(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    return await stopCheck(io, payload)
  } catch (e) {
    await logError(io, 'followup', errorText(e))
    return ok('', `[followup] internal error (ignored): ${errorText(e)}\n`)
  }
}

// ---- SessionStart ----

/** SessionStart: startup / clear なら自セッションの保留を消す。24 時間より古い保留はいつでも消す。 */
export async function resetFollowups(io: Io, payload: Dict): Promise<ScriptResult> {
  try {
    const dir = pendingDir(io)
    const sessionId = safeName(jqStr(payload.session_id) || 'unknown')
    const source = jqStr(payload.source)
    const now = await io.now()
    const doomed: string[] = []
    for (const e of await io.list(dir)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
      const mine = e.name === `${sessionId}.json` || e.name.startsWith(`${sessionId}--`)
      if ((mine && (source === 'startup' || source === 'clear')) || e.mtimeMs < now - DAY_MS) doomed.push(join(dir, e.name))
    }
    await io.removeFiles(doomed)
  } catch {
    // 掃除の失敗で作業を止めない。
  }
  return ok()
}
