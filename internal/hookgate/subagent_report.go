package hookgate

// サブエージェントの停止時（SubagentStop）に走った hook の結果を、呼び出し元のエージェントへ渡す。
//
// SubagentStop の gate（checks フェーズ）と feedback の stop_check の結果は、サブエージェント自身にしか届かない
// （block の reason はサブエージェントへ、systemMessage はユーザーへ）。呼び出し元は Agent ツールの結果（サブ
// エージェントの最後の発言）しか見えないので、検証が通ったのかを知るには gate のログを読むしかなかった。
//
// そこで SubagentStop のたびに、その回の結果を <projectDir>/.claude/.gate-status/subagent_report.<session>--<agent>.json に書き
// （SaveSubagentReport）、呼び出し元の PostToolUse(Agent) で tool_response.agentId から引いて additionalContext と
// して渡し、ファイルを消す（SubagentReport）。SubagentStop は block のたびに繰り返されるので、最後の回（サブエージェントが
// 実際に止まった回）の結果が残る。ただし成功報告の直後の Stop（gate が印を消費して素通しした回）は gate の結果を
// 上書きせず、直前の「すべて通った」を残す。
//
// 置き場所は gate の他の状態ファイルと同じ .claude/.gate-status/ で、名前も <base>.<session>--<agent>.<ext> に揃えている。
// 掃除は SessionStart の reset-gate に任せる（startup / clear で自セッションの分を、24h 超は全セッションの分を消す）。
// バックグラウンドで起動したサブエージェントは PostToolUse(Agent) が先に来るので引き取られず、そうして残った分もここで消える。
// gate.yaml の無い PJ でも、stop_check が何か見つけたときだけは書く（feedback_gate_attempts と同じ）。

import (
	"encoding/json"
	"strings"
)

// subagentReportData は状態ファイルの中身（TS の Report）。空文字は未設定。
type subagentReportData struct {
	AgentType string
	Gate      string
	Feedback  string
}

func subagentReportPath(io Io, sessionID, agentID string) string {
	return Join(GateStatusDir(io), "subagent_report."+sessionID+"--"+agentID+".json")
}

// subagentSessionID は `jqStr(payload.session_id) || 'unknown'`。
func subagentSessionID(payload Dict) string {
	if s := JqStr(payload["session_id"]); s != "" {
		return s
	}
	return "unknown"
}

// subagentJSTrim は JS の String.prototype.trim()。
func subagentJSTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

func subagentBlockReason(stdout string) string {
	for _, line := range strings.Split(stdout, "\n") {
		var v any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			// JSON でない行は読み飛ばす
			continue
		}
		if d, ok := AsDict(v); ok && d["decision"] == "block" {
			if reason, isStr := d["reason"].(string); isStr {
				return reason
			}
		}
	}
	return ""
}

// subagentFeedbackText は feedback の stop_check の結果のうち、呼び出し元へ渡すもの（block の理由、または warn / 打ち切りの出力）。
func subagentFeedbackText(r ScriptResult) string {
	text := r.Stderr
	if r.ExitCode == 2 {
		if reason := subagentBlockReason(r.Stdout); reason != "" {
			text = reason
		}
	}
	return subagentJSTrim(text)
}

// subagentReportField は状態ファイルの項目を文字列にする（TS は検証せずに使うので、偽値は空、文字列以外は String() 相当）。
func subagentReportField(d Dict, key string) string {
	v := d[key]
	if !Truthy(v) {
		return ""
	}
	return Str(v)
}

func loadSubagentReport(io Io, path string) (subagentReportData, bool) {
	text, ok := io.ReadFile(path)
	if !ok {
		return subagentReportData{}, false
	}
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return subagentReportData{}, false
	}
	d, isDict := AsDict(v)
	if !isDict {
		return subagentReportData{}, false
	}
	return subagentReportData{AgentType: subagentReportField(d, "agentType"), Gate: subagentReportField(d, "gate"), Feedback: subagentReportField(d, "feedback")}, true
}

// SaveSubagentReport は SubagentStop: その回の gate と stop_check の結果を控える。常に ok を返す（作業を止めない）。
// gate / feedback の nil は TS の undefined（その回は走らなかった）。
func SaveSubagentReport(io Io, payload Dict, gate, feedback *ScriptResult) ScriptResult {
	agentID := JqStr(payload["agent_id"])
	if agentID == "" {
		return Ok("", "")
	}
	path := subagentReportPath(io, subagentSessionID(payload), agentID)
	// 成功報告の直後の回は gate を走らせていないので、前の回の結果（すべて通った）を残す。
	gateText := ""
	switch {
	case gate != nil && gate.ReportConsumed:
		if prev, ok := loadSubagentReport(io, path); ok {
			gateText = prev.Gate
		}
	case gate != nil:
		gateText = subagentJSTrim(gate.Report)
	}
	fbText := ""
	if feedback != nil {
		fbText = subagentFeedbackText(*feedback)
	}
	if gateText == "" && fbText == "" {
		io.RemoveFiles([]string{path})
		return Ok("", "")
	}
	var report OMap
	if agentType := JqStr(payload["agent_type"]); agentType != "" {
		report = append(report, KV{"agentType", agentType})
	}
	if gateText != "" {
		report = append(report, KV{"gate", gateText})
	}
	if fbText != "" {
		report = append(report, KV{"feedback", fbText})
	}
	// 控えられなくても作業は止めない。
	_ = io.WriteFile(path, JSONStringify(report)+"\n")
	return Ok("", "")
}

// SubagentReport は PostToolUse(Agent): 終わったサブエージェントの控えがあれば、呼び出し元の context へ渡して消す。
func SubagentReport(io Io, payload Dict) ScriptResult {
	agentID := ""
	if response, ok := AsDict(payload["tool_response"]); ok {
		agentID = JqStr(response["agentId"])
	}
	if agentID == "" {
		return Ok("", "")
	}
	path := subagentReportPath(io, subagentSessionID(payload), agentID)
	report, found := loadSubagentReport(io, path)
	io.RemoveFiles([]string{path})
	if !found || (report.Gate == "" && report.Feedback == "") {
		return Ok("", "")
	}
	agent := agentID
	if report.AgentType != "" {
		agent = report.AgentType + " (" + agentID + ")"
	}
	lines := []string{Tr(io.Lang())("subagentReport.header", map[string]any{"agent": agent})}
	for _, s := range []string{report.Gate, report.Feedback} {
		if s != "" {
			lines = append(lines, s)
		}
	}
	body := strings.Join(lines, "\n")
	out := OMap{{"hookSpecificOutput", OMap{{"hookEventName", "PostToolUse"}, {"additionalContext", body}}}}
	return Ok(JSONStringify(out)+"\n", "")
}
