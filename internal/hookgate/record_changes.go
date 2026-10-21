package hookgate

// PostToolUse hook: 変更ファイルのパスをセッション別メモに記録する（src/record-changes.ts）。
// PJ が gate.yaml を持つ場合のみ動く（オプトイン）。

import "strings"

// RecordChanges は payload.tool_input.file_path を changed_files.<state_id>.txt に 1 行足す（既にあれば足さない）。
// メモに書けなかったときは何もしない（TS 版は例外になり、呼び出し側が握りつぶして次の段へ進むのと同じ結果）。
func RecordChanges(io Io, payload Dict) ScriptResult {
	if _, ok := FindGateYaml(io); !ok {
		return Ok("", "")
	}

	var filePath string
	if input, isDict := AsDict(payload["tool_input"]); isDict {
		filePath = JqStr(input["file_path"])
	}
	sessionID := JqStr(payload["session_id"])
	if sessionID == "" {
		sessionID = "unknown"
	}
	agentID := JqStr(payload["agent_id"])
	stateID := sessionID
	if agentID != "" {
		stateID = sessionID + "--" + agentID
	}
	memo := Join(GateStatusDir(io), "changed_files."+stateID+".txt")

	if filePath != "" {
		existing, _ := io.ReadFile(memo)
		found := false
		for _, line := range strings.Split(existing, "\n") {
			if line == filePath {
				found = true
				break
			}
		}
		if !found {
			_ = io.WriteFile(memo, existing+filePath+"\n")
		}
	}
	return Ok("", "")
}
