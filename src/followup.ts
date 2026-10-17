// 後続コマンド（followup）: あるコマンドを実行したら、人間が .md に書いておいた次のコマンドを Claude に実行させる。
//
// 例: `gh pr create` を実行したら `gh pr checks {{pr}} --watch` を続けて実行し、その結果を報告させる。
// Claude Code のバックグラウンド実行はコマンドを Claude が決めるので見当違いなことがある。ここでは「きっかけ」と
// 「実行するコマンド」は人間が定義ファイルに書き、コマンドの引数（{{pr}} のような穴）だけを Claude が直前の出力などから
// 推測して埋める。hook は引数を推測できない（モデルを呼べない）ので、コマンドの実行自体も Claude に Bash でさせ、
// hook は「実行を求める → 実行されたか見届ける → 失敗したら理由を添えて組み立て直させる」の役だけを持つ。
//
// 定義ファイル（~/.claude/followup/*.md とプロジェクトの .claude/followup/*.md。同名はプロジェクト側が優先）:
//
// ---
// name: pr_checks              # 省略時はファイル名（.md 抜き）
// description: PR を作ったら CI を見届ける
// when: '^gh pr create\b'      # 必須。Bash のコマンドにマッチする正規表現（pre_bash と同じ Python re の書き方）
// unless: '--dry-run'          # 任意。マッチすれば発火しない
// run: 'gh pr checks {{pr}} --watch'   # 必須。{{name}} は Claude が埋める引数
// args:                        # 任意。引数ごとの埋め方の説明（Claude への手がかり）
//   pr: 'gh pr create の出力にある PR の URL（.../pull/N）の N'
// max_attempts: 3              # 任意。後続コマンドが失敗したときに組み立て直して再実行させる上限（既定 3）
// expires / projects / when_exists     # 任意。feedback ルールと同じ適用条件
// ---
// 本文（任意）: 後続コマンドを実行するときの補足指示。そのまま Claude に渡す。
//
// 流れ:
// - PostToolUse(Bash)（成功したコマンド）: when にマッチしたら、保留（pending）に積み、additionalContext で
//   「このコマンドを {{...}} を埋めて実行せよ」と指示する。同じ hook で、保留中の後続コマンド（run の穴を任意の
//   引数として読んだパターン）に一致するコマンドが成功していれば、その保留を消して完了を伝える。
// - PostToolUseFailure(Bash): 保留中の後続コマンドに一致するコマンドが失敗したら、失敗回数を上げ、「引数が誤って
//   いれば組み立て直して再実行、コマンドが正しくて失敗が結果ならそれを報告」と伝える。max_attempts に達したら
//   打ち切って保留を消す。ユーザーが中断した（is_interrupt）ならその保留は黙って消す。
// - Stop / SubagentStop: 一度も実行されていない保留があれば停止をブロックして実行を求める（MAX_STOP_BLOCKS 回
//   連続でブロックしたら諦める）。一度でも実行された（失敗を含む）保留は、結果が Claude とユーザーに届いているので
//   止めない。
// - SessionStart（startup / clear）: 自セッションの保留を消す。24 時間より古い保留も消す。
//
// 保留は <followupDir>/.pending/<session>[--<agent>].json に置く（feedback の .ask_state と同じ流儀で、プロジェクトの
// 作業ツリーには書かない）。エージェントごとに分けるので、サブエージェントの中で発火した後続コマンドはそのサブ
// エージェントが実行する。
//
// hook 自身のバグで作業を止めないよう、例外は握りつぶして exit 0 にする（.errors.jsonl に残す）。壊れた定義ファイルは
// そのファイルだけを飛ばし、理由を .errors.jsonl に記録する（feedback ルールと同じ）。
import { errorText, FRONTMATTER_RE, isRuleActive, loadYamlText, logError, parseExpires, stringList } from './feedback-rules.ts'
import { type Lang, tr } from './i18n.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { join } from './path.ts'
import { type Dict, isDict, jqStr, pyRegExp, toCount, truthy } from './pyutil.ts'

/** 一度も実行されない保留を理由に Stop を続けてブロックする上限。これに達したら要求を取り下げる。 */
export const MAX_STOP_BLOCKS = 3
/** max_attempts の既定（後続コマンドの失敗で組み立て直させる回数）。 */
export const DEFAULT_MAX_ATTEMPTS = 3
const DAY_MS = 24 * 60 * 60 * 1000

export type Followup = {
  name: string
  description: string
  /** きっかけ（Bash のコマンドにマッチする正規表現。Python re の書き方）。 */
  when: string
  unless?: string
  /** 後続コマンドの雛形。{{name}} が Claude の埋める引数。 */
  run: string
  /** 引数名 → 埋め方の説明。 */
  args: Record<string, string>
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
  args: Record<string, string>
  body: string
  /** きっかけになったコマンド（表示用に 1 行へ畳んだもの）。 */
  command: string
  toolUseId: string
  /** 失敗した回数。 */
  attempts: number
  /** 一度でも実行された（失敗を含む）。Stop はこれが false の保留だけを止める。 */
  attempted: boolean
  maxAttempts: number
  createdAt: number
}

type PendingState = { entries: Pending[]; stopBlocks: number }

export type BrokenFollowup = { path: string; reason: string }

/** 後続コマンドの定義と保留状態の置き場（~/.claude/followup）。CLAUDE_FOLLOWUP_DIR で差し替え可能。 */
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

// ---- 定義の読み込み ----

/** run の雛形に現れる引数の穴（{{name}}）。 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g

/** 雛形の穴の名前（出現順、重複なし）。 */
export const placeholders = (run: string): string[] => [...new Set([...run.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? ''))]

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 雛形から、引数を埋めたコマンドに一致する正規表現を作る。穴は引用符付きの文字列か空白を含まない 1 語に、
 * 雛形の空白は任意の空白列に一致させる。前後は束縛しない（`cd x && ...` や ` 2>&1` を足しても一致する）。
 */
export function runRegExp(run: string): RegExp {
  let src = ''
  run.split(PLACEHOLDER_RE).forEach((part, i) => {
    if (i % 2 === 1) src += `(?:"[^"]*"|'[^']*'|\\S+)`
    else src += escapeRegExp(part).replace(/\s+/g, '\\s+')
  })
  return new RegExp(src)
}

const argsOf = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!isDict(raw)) return out
  for (const [k, v] of Object.entries(raw)) if (truthy(v)) out[k] = String(v)
  return out
}

/**
 * 1 つの定義ファイルを読む。frontmatter が無ければ null。frontmatter が読めない、when / run が無い、when / unless が
 * 使えない正規表現なら例外を投げる（listFollowupsIn がそのファイルだけを飛ばして記録する）。
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
  return {
    name: truthy(data.name) ? String(data.name) : file.replace(/\.md$/, ''),
    description: truthy(data.description) ? String(data.description) : '',
    when: String(data.when),
    ...(truthy(data.unless) ? { unless: String(data.unless) } : {}),
    run: String(data.run).trim(),
    args: argsOf(data.args),
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

/** 保留中の後続コマンド（テスト・/correct などの参照用）。 */
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

/** 発火時に Claude へ渡す指示。 */
export function instructionText(lang: Lang, p: Pending): string {
  const t = tr(lang)
  const lines = [t('followup.triggered', { command: p.command, label: labelOf(p) }), `  ${p.run}`]
  const names = placeholders(p.run)
  if (names.length > 0) {
    lines.push(t('followup.argsHeader'))
    for (const n of names) lines.push(`  {{${n}}}: ${p.args[n] ?? t('followup.argNoHint')}`)
  }
  if (p.body) lines.push(p.body)
  lines.push(t('followup.instruction'))
  return lines.join('\n')
}

const context = (event: string, body: string): ScriptResult =>
  ok(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: body } })}\n`)

const commandOf = (payload: Dict): string => jqStr(isDict(payload.tool_input) ? payload.tool_input.command : undefined)

/** 保留のうち、このコマンドが後続コマンドとして一致する最初のもの（古い順）。 */
const matchPending = (entries: Pending[], command: string): Pending | undefined => entries.find((p) => runRegExp(p.run).test(command))

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

  // 1. 保留中の後続コマンドが成功した。
  const done = matchPending(state.entries, command)
  if (done) {
    state.entries = state.entries.filter((p) => p !== done)
    changed = true
    notes.push(t('followup.done', { command: oneLine(command), name: done.name }))
  }

  // 2. きっかけに一致したら保留に積んで指示する。後続コマンド自身がそのきっかけに一致しても（`gh pr` の後に `gh pr checks` など）
  //    同じ定義を再発火させない。
  for (const f of followups) {
    if (done?.name === f.name) continue
    if (!pyRegExp(f.when).test(command)) continue
    if (f.unless !== undefined && pyRegExp(f.unless).test(command)) continue
    const p: Pending = {
      name: f.name,
      description: f.description,
      run: f.run,
      args: f.args,
      body: f.body,
      command: oneLine(command),
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

/** PostToolUse(Bash): きっかけに一致したら後続コマンドの実行を求め、保留中の後続コマンドが成功したら完了を伝える。 */
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

/** PostToolUseFailure(Bash): 保留中の後続コマンドが失敗したら、理由を見て組み立て直すよう伝える（上限で打ち切り）。 */
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
    // 諦める: 一度も実行されない保留を捨て、実行済みの保留（失敗の再試行待ち）は残す。
    state.entries = state.entries.filter((p) => p.attempted)
    state.stopBlocks = 0
    await savePending(io, stateId, state)
    return ok('', `${t('followup.stopGaveUp', { max: MAX_STOP_BLOCKS })}\n`)
  }
  await savePending(io, stateId, state)
  const lines = [t('followup.stopHeader', { attempt: state.stopBlocks, max: MAX_STOP_BLOCKS })]
  for (const p of waiting) lines.push(t('followup.stopItem', { label: labelOf(p), run: p.run, command: p.command }))
  const reason = lines.join('\n')
  return { exitCode: 2, stdout: `${JSON.stringify({ decision: 'block', reason })}\n`, stderr: `${reason}\n` }
}

/** Stop / SubagentStop: 一度も実行されていない後続コマンドがあれば停止をブロックする（MAX_STOP_BLOCKS 回で諦める）。 */
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
    const dir = join(followupDir(io), '.pending')
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
