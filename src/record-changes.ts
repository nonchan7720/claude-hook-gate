// PostToolUse hook: 変更ファイルのパスをセッション別メモに記録する。
// PJ が .claude/gate.yaml を持つ場合のみ動く（オプトイン）。
import { type Io, ok, type ScriptResult } from './io.ts'
import { join } from './path.ts'
import { type Dict, isDict, jqStr } from './pyutil.ts'

export async function recordChanges(io: Io, payload: Dict): Promise<ScriptResult> {
  const projectDir = io.projectDir || io.cwd
  if (!(await io.exists(join(projectDir, '.claude', 'gate.yaml')))) return ok()

  const filePath = jqStr(isDict(payload.tool_input) ? payload.tool_input.file_path : undefined)
  const sessionId = jqStr(payload.session_id) || 'unknown'
  const agentId = jqStr(payload.agent_id)
  const stateId = agentId ? `${sessionId}--${agentId}` : sessionId
  const memo = join(projectDir, '.claude', '.gate-status', `changed_files.${stateId}.txt`)

  if (filePath) {
    const existing = (await io.readFile(memo)) ?? ''
    if (!existing.split('\n').includes(filePath)) await io.writeFile(memo, `${existing}${filePath}\n`)
  }
  return ok()
}
