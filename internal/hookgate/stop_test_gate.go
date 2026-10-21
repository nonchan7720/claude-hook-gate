package hookgate

// gate のエントリポイント（src/stop-test-gate.ts）。phase は rules | checks（省略時は checks: Stop / SubagentStop からの呼び出しに
// 合わせたデフォルト）。PostToolUse からは "rules" を明示して呼ぶ。

// StopTestGate は gate.yaml が無ければ何もせず（gate.yml の綴り違いだけ警告する）、あれば RunGate を呼ぶ。phase が空なら checks。
func StopTestGate(io Io, phase string, payload Dict) ScriptResult {
	if _, ok := FindGateYaml(io); !ok {
		base := io.ProjectDir()
		if base == "" {
			base = io.Cwd()
		}
		if yml, found := FindConfigPath(io, base, "gate.yml"); found {
			return Ok(JSONStringify(OMap{{"systemMessage", Tr(io.Lang())("gate.ymlTypo", map[string]any{"path": yml})}})+"\n", "")
		}
		return Ok("", "")
	}
	sessionID := JqStr(payload["session_id"])
	if sessionID == "" {
		sessionID = "unknown"
	}
	if phase == "" {
		phase = "checks"
	}
	return RunGate(io, GateOptions{
		SessionID:      sessionID,
		AgentID:        JqStr(payload["agent_id"]),
		Phase:          phase,
		StopHookActive: payload["stop_hook_active"] == true,
	})
}
