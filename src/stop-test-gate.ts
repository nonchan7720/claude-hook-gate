// gate のエントリポイント。phase は rules | checks（省略時は checks: Stop / SubagentStop からの呼び出しに
// 合わせたデフォルト）。PostToolUse からは "rules" を明示して呼ぶ。
import { runGate } from './gate.ts'
import { tr } from './i18n.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { GATE_YML_TYPO } from './messages.ts'
import { join } from './path.ts'
import { type Dict, jqStr } from './pyutil.ts'

export async function stopTestGate(io: Io, phase: string | undefined, payload: Dict): Promise<ScriptResult> {
  const projectDir = io.projectDir || io.cwd
  if (!(await io.exists(join(projectDir, '.claude', 'gate.yaml')))) {
    if (await io.exists(join(projectDir, '.claude', 'gate.yml'))) {
      return ok(`${JSON.stringify({ systemMessage: tr(io.lang)(GATE_YML_TYPO) })}\n`)
    }
    return ok()
  }
  return runGate(io, {
    sessionId: jqStr(payload.session_id) || 'unknown',
    agentId: jqStr(payload.agent_id),
    phase: phase || 'checks',
    stopHookActive: payload.stop_hook_active === true,
  })
}
