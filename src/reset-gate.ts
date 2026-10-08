// SessionStart hook: 自分のセッション分の状態だけを消す。加えて、クラッシュ等で残った古いセッションの
// ゴミ（24h超）も掃除する。
// 注意: stdout に出力しないこと（UserPromptSubmit では context に注入されるため）。
//
// SessionStart は起動時だけでなく resume / `/clear` / compact でも発火する。resume / compact は同一
// セッションの継続なので、無条件に消すと中断前に変更したファイルがゲートの検証対象から丸ごと落ちて
// しまう。source が startup / clear のときだけ削除し、resume / compact や未知の source
// （取得できない場合を含む）では安全側に倒して削除しない。
import { type Io, ok, type ScriptResult } from './io.ts'
import { join } from './path.ts'
import { type Dict, jqStr } from './pyutil.ts'
import { clearSummary } from './running-registry.ts'

// [ファイル名の先頭, 拡張子]。<base>.<session>.<ext> と <base>.<session>--<agent>.<ext> が対象。
const STATE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['changed_files', '.txt'],
  ['gate_attempts', '.txt'],
  ['gate_passed', '.txt'],
  ['gate_push_verified', '.txt'],
  ['gate_reported', '.txt'],
  ['gate_pending_checks', '.json'],
  ['gate_trace', '.jsonl'],
  ['gate_deferred', '.json'],
  ['feedback_gate_attempts', '.txt'],
]
const DAY_MS = 1440 * 60 * 1000

const globMatch = (name: string, prefix: string, suffix: string): boolean =>
  name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix)

export async function resetGate(io: Io, payload: Dict): Promise<ScriptResult> {
  const projectDir = io.projectDir || io.cwd
  const claudeDir = join(projectDir, '.claude')
  const stateDir = join(claudeDir, '.gate-status')
  const sessionId = jqStr(payload.session_id) || 'unknown'
  const source = jqStr(payload.source)
  const now = await io.now()

  if (source === 'startup' || source === 'clear') {
    await clearSummary(io)
    // SubagentStop 経由の状態ファイル（changed_files.<session>--<agent>.txt 等）も対象。置き場所は
    // .claude/.gate-status/。移行前の旧パス（.claude/ 直下と .claude/hooks/logs/）の残骸も同じ条件で消す。
    for (const dir of [stateDir, claudeDir]) {
      const names = (await io.list(dir)).map((e) => e.name)
      const doomed: string[] = []
      for (const [base, ext] of STATE_FILES) {
        const exact = `${base}.${sessionId}${ext}`
        for (const name of names) {
          if (name === exact || globMatch(name, `${base}.${sessionId}--`, ext)) doomed.push(join(dir, name))
        }
      }
      await io.removeFiles(doomed)
    }
    for (const logRoot of [join(stateDir, 'logs'), join(claudeDir, 'hooks', 'logs')]) {
      for (const e of await io.list(logRoot)) {
        if (e.name === sessionId || e.name.startsWith(`${sessionId}--`)) await io.removeTree(join(logRoot, e.name))
      }
    }
  }

  for (const dir of [stateDir, claudeDir]) {
    const old: string[] = []
    for (const e of await io.list(dir)) {
      if (e.kind !== 'file' || e.mtimeMs >= now - DAY_MS) continue
      if (STATE_FILES.some(([base, ext]) => globMatch(e.name, `${base}.`, ext))) {
        old.push(join(dir, e.name))
      }
    }
    await io.removeFiles(old)
  }

  // ログ（新: .gate-status/logs/<state_id>/、旧: hooks/logs/<state_id>/）も 24h 超は掃除する。
  for (const logRoot of [join(stateDir, 'logs'), join(claudeDir, 'hooks', 'logs')]) {
    for (const e of await io.list(logRoot)) {
      if (e.kind !== 'dir') continue
      const st = await io.stat(join(logRoot, e.name))
      if (st && st.mtimeMs < now - DAY_MS) await io.removeTree(join(logRoot, e.name))
    }
  }
  // 旧パスのログ置き場が空になったら片付ける。
  await io.removeDir(join(claudeDir, 'hooks', 'logs'))
  await io.removeDir(join(claudeDir, 'hooks'))

  return ok()
}
