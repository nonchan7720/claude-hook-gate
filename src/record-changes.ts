// PostToolUse hook: 変更ファイルのパスをセッション別メモに記録する。
// PJ が gate.yaml を持つ場合のみ動く（オプトイン）。
import { findGateYaml } from './config-dir.ts'
import { type Io, ok, type ScriptResult } from './io.ts'
import { join } from './path.ts'
import { type Dict, isDict, jqStr } from './pyutil.ts'
import { gateStatusDir } from './running-registry.ts'

export async function recordChanges(io: Io, payload: Dict): Promise<ScriptResult> {
  if (!(await findGateYaml(io))) return ok()

  const filePath = jqStr(isDict(payload.tool_input) ? payload.tool_input.file_path : undefined)
  const sessionId = jqStr(payload.session_id) || 'unknown'
  const agentId = jqStr(payload.agent_id)
  const stateId = agentId ? `${sessionId}--${agentId}` : sessionId
  const memo = join(gateStatusDir(io), `changed_files.${stateId}.txt`)

  if (filePath) {
    const existing = (await io.readFile(memo)) ?? ''
    if (!existing.split('\n').includes(filePath)) await io.writeFile(memo, `${existing}${filePath}\n`)
  }
  return ok()
}
