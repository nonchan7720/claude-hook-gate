// gate.yaml の session_start フェーズ（SessionStart で走らせるコマンド）。stdout を additionalContext として返す。
// ポリシー（dogwood）・後回し・実行共有は使わない: セッションごとの出力をその場で context に入れるのが目的なので、
// 「あとで走らせる」「他のエージェントと共有する」の意味がない。同時実行枠（max_parallel）だけは守る。
// 失敗してもセッションは止めない（stderr に 1 回だけ知らせ、exit は 0）。メインのセッションだけが対象（agent_id があれば何もしない）。

import { findGateYaml } from './config-dir.ts'
import { Gate, slug } from './gate.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { type Dict, isDict, jqStr, truthy } from './pyutil.ts'
import { runWithSlot } from './shared-run.ts'
import { shellQuote } from './shell.ts'

export const SESSION_START_TIMEOUT = 10 // 秒。session_start の既定のタイムアウト（起動を遅らせないため短い）
export const SESSION_START_MAX_CHARS = 8192 // additionalContext に入れる出力の合計の上限（文字）
export const SESSION_START_MAX_TIMEOUT = 600 // 秒。timeout: の上限（hooks.json の SessionStart の timeout と同じ）
const MAX_TIMEOUT_MS = SESSION_START_MAX_TIMEOUT * 1000

type Item = { cmd: string; name: string; timeout: number; on: string[] | undefined; background: boolean }

/** session_start の 1 要素（文字列 or マッピング）を正規化する。cmd が無いものは undefined。 */
export function parseItem(raw: unknown): Item | undefined {
  const d: Dict = isDict(raw) ? raw : { cmd: raw }
  if (typeof d.cmd !== 'string' || d.cmd.trim() === '') return undefined
  const t = Number(d.timeout)
  const on = typeof d.on === 'string' ? [d.on] : Array.isArray(d.on) ? d.on.map(String) : undefined
  return {
    cmd: d.cmd,
    name: truthy(d.name) ? String(d.name) : slug(d.cmd),
    timeout: truthy(d.timeout) && Number.isFinite(t) && t > 0 ? Math.min(t, SESSION_START_MAX_TIMEOUT) : SESSION_START_TIMEOUT,
    on,
    background: d.background === true,
  }
}

type Done = { block?: string; note?: string; sys?: string }

/**
 * コマンドの stdout を context 用の文章にする。SessionStart の hook JSON（オブジェクト）なら hookSpecificOutput.additionalContext
 * （空でない文字列）だけを取り、最上位の systemMessage（文字列）は sys として返す。JSON でなければ trim した平文。
 */
export function readOutput(stdout: string): { text: string; sys?: string } {
  const t = stdout.trim()
  if (t.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(t)
      if (isDict(v)) {
        const spec = v.hookSpecificOutput
        const ctx = isDict(spec) && typeof spec.additionalContext === 'string' ? spec.additionalContext.trim() : ''
        return { text: ctx, ...(typeof v.systemMessage === 'string' && v.systemMessage.trim() !== '' ? { sys: v.systemMessage.trim() } : {}) }
      }
    } catch {
      // JSON でなければ平文として扱う
    }
  }
  return { text: t }
}

async function runForeground(gate: Gate, item: Item, env: Record<string, string>): Promise<Done> {
  const { io } = gate
  const logpath = await gate.newLogPath(item.name, item.cmd)
  const header = `$ ${item.cmd}  (cwd: ${gate.projectDir})\n`
  await io.writeFile(logpath, header).catch(() => undefined)
  const timeoutMs = Math.min(Math.round(item.timeout * 1000), MAX_TIMEOUT_MS)
  const started = await io.now()
  let code = 1
  const r = await runWithSlot(io, gate.maxParallel, timeoutMs, async (pidFiles) => {
    const writePid = pidFiles.map((f) => `{ echo $$ > ${shellQuote(f)}; } 2>/dev/null; `).join('')
    const run = await io.run(['sh', '-c', `${writePid}${item.cmd}`], { cwd: gate.projectDir, env, timeoutMs })
    const elapsed = (await io.now()) - started
    const timedOut = run.timedOut || (run.error !== undefined && elapsed >= timeoutMs - 1000)
    const out = run.stdout + (run.error !== undefined && !timedOut ? `${run.error}\n` : '')
    code = run.exitCode
    await io.writeFile(logpath, `${header}${out}${run.stderr}`).catch(() => undefined)
    return { out, ok: run.exitCode === 0 && !timedOut && run.error === undefined, timedOut, logpath }
  })
  if (!r.ok) {
    const reason = r.timedOut ? gate.t('gate.sessionStartTimeout', { seconds: item.timeout }) : gate.t('gate.sessionStartExit', { code })
    return { note: `${gate.t('gate.sessionStartFailed', { name: item.name, reason, logpath })}\n` }
  }
  const { text, sys } = readOutput(r.out)
  return { ...(text === '' ? {} : { block: `${gate.t('gate.sessionStartHeader', { name: item.name })}\n${text}` }), ...(sys ? { sys } : {}) }
}

/** background: true: 起動して待たない。出力は注入せず、ログにだけ残す。 */
async function startBackground(gate: Gate, item: Item, env: Record<string, string>): Promise<Done> {
  const { io } = gate
  const logpath = await gate.newLogPath(item.name, item.cmd)
  await io.writeFile(logpath, `$ ${item.cmd}  (cwd: ${gate.projectDir}) [background]\n`).catch(() => undefined)
  // 標準入出力をログと /dev/null に付け替えて、hook のパイプを閉じる（hook が子の終了を待たない）。setsid があれば別セッションにする。
  const script =
    'if command -v setsid >/dev/null 2>&1; then ' +
    'setsid nohup sh -c "$CLAUDE_GATE_BG_CMD" >>"$CLAUDE_GATE_BG_LOG" 2>&1 </dev/null & ' +
    'else nohup sh -c "$CLAUDE_GATE_BG_CMD" >>"$CLAUDE_GATE_BG_LOG" 2>&1 </dev/null & fi'
  const r = await io.run(['sh', '-c', script], {
    cwd: gate.projectDir,
    env: { ...env, CLAUDE_GATE_BG_CMD: item.cmd, CLAUDE_GATE_BG_LOG: logpath },
    timeoutMs: 5000,
  })
  if (r.exitCode !== 0 || r.error !== undefined) {
    return { note: `${gate.t('gate.sessionStartFailed', { name: item.name, reason: gate.t('gate.sessionStartExit', { code: r.exitCode }), logpath })}\n` }
  }
  return {}
}

export async function sessionStartGate(io: Io, payload: Dict): Promise<ScriptResult> {
  if (jqStr(payload.agent_id)) return ok()
  const path = await findGateYaml(io)
  if (!path) return ok()
  const gate = new Gate(io, { sessionId: jqStr(payload.session_id) || 'unknown', phase: 'session_start' })
  const cfg = await gate.loadAction(path).catch(() => null)
  const raw = isDict(cfg) && Array.isArray(cfg.session_start) ? cfg.session_start : []
  const source = jqStr(payload.source)
  const items = raw.map(parseItem).filter((i): i is Item => i !== undefined && (i.on === undefined || i.on.includes(source)))
  if (items.length === 0) return ok()
  const env = { ...gate.baseEnv, CLAUDE_GATE_FILES: '', CLAUDE_SESSION_SOURCE: source }
  const done = await Promise.all(
    items.map((item) =>
      (item.background ? startBackground(gate, item, env) : runForeground(gate, item, env)).catch(
        (e): Done => ({
          note: `[gate] session_start: ${item.name}: ${e instanceof Error ? e.message : String(e)}\n`,
        }),
      ),
    ),
  )
  let text = done
    .map((d) => d.block)
    .filter((b): b is string => b !== undefined)
    .join('\n\n')
  if (text.length > SESSION_START_MAX_CHARS) {
    let cut = text.slice(0, SESSION_START_MAX_CHARS)
    // サロゲートペアの途中で切らない（末尾が上位サロゲートなら落とす）。
    const last = cut.charCodeAt(cut.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
    text = `${cut.trimEnd()}\n${gate.t('gate.sessionStartTruncated', { limit: SESSION_START_MAX_CHARS })}`
  }
  const notes = done.map((d) => d.note ?? '').join('')
  const result = ok(text === '' ? '' : `${text}\n`, notes)
  // stderr は exit 0 だと表示されないので、失敗の通知と JSON の systemMessage をユーザーに見せる systemMessage にも載せる。
  const sys = [...done.flatMap((d) => [d.note?.trimEnd(), d.sys])].filter((m): m is string => !!m).join('\n')
  return sys === '' ? result : { ...result, systemMessage: sys }
}
