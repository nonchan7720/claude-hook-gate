package hookgate

// PostToolUse hook: feedback ルールの enforce (post_edit) を評価する。
//
// Edit / Write / MultiEdit の直後に、編集後のファイル全体（ディスク上の全文）を post_edit の enforce と照合する。
// pre_edit は tool_input の差分だけを見るため「console.log を残さない」のような“編集後の状態”を検査できない。
// それを補う。
//
// severity が warn 以外（block/deny/ask）の違反があれば stdout に {"decision":"block","reason":...} を出す
// （PostToolUse に ask は無いので block 扱い。exit 0 のまま outcome.go が block に変換する）。
// warn のみなら stderr に書いて exit 0。違反が無ければ何も出さず exit 0。
//
// hook 自身のバグで作業を止めないよう、例外は必ず握りつぶして exit 0 にする（stderr に1行だけ出し、~/.claude/feedback/.errors.jsonl に残す）。

import (
	"strconv"
	"strings"
)

func feedbackPostEditMain(io Io, payload Dict) (ScriptResult, error) {
	toolName := ""
	if Truthy(payload["tool_name"]) {
		toolName = Str(payload["tool_name"])
	}
	if toolName != "Edit" && toolName != "Write" && toolName != "MultiEdit" {
		return Ok("", ""), nil
	}
	toolInput := Dict{}
	if d, ok := payload["tool_input"].(map[string]any); ok {
		toolInput = d
	}
	filePath := ""
	if Truthy(toolInput["file_path"]) {
		filePath = Str(toolInput["file_path"])
	}
	if filePath == "" {
		return Ok("", ""), nil
	}

	rules, err := ListRules(io)
	if err != nil {
		return ScriptResult{}, err
	}
	violations := EvalPostEdit(io, rules, filePath)
	if len(violations) == 0 {
		return Ok("", ""), nil
	}

	for _, v := range violations {
		LogViolation(io, v.Rule, v.Count, v.Severity, v.Event, v.Detail)
	}
	notes := CountBumpNotes(io.Lang(), AutoBumpCounts(io, rules, violations, payload["session_id"]))

	warnings, blocking := []Violation{}, []Violation{}
	for _, v := range violations {
		if v.Severity == "warn" {
			warnings = append(warnings, v)
		} else {
			blocking = append(blocking, v)
		}
	}

	var stderr strings.Builder
	for _, v := range warnings {
		stderr.WriteString("[feedback-post-edit] warn: " + v.Rule + " (count: " + strconv.Itoa(v.Count) + "): " + v.Message + "\n")
	}
	if len(blocking) == 0 {
		return Ok("", stderr.String()+fbJoinLines(notes)), nil
	}

	lines := make([]string, 0, len(blocking)+len(notes))
	for _, v := range blocking {
		lines = append(lines, "[feedback-post-edit] "+v.Rule+" (count: "+strconv.Itoa(v.Count)+"): "+v.Message+" ("+v.Detail+")")
	}
	lines = append(lines, notes...)
	stderr.WriteString(fbJoinLines(lines))
	stdout := JSONStringify(OMap{{"decision", "block"}, {"reason", strings.Join(lines, "\n")}}) + "\n"
	return Ok(stdout, stderr.String()), nil
}

// FeedbackPostEdit は PostToolUse hook の本体。
func FeedbackPostEdit(io Io, payload Dict) ScriptResult {
	res, err := fbCatchResult(func() (ScriptResult, error) { return feedbackPostEditMain(io, payload) })
	if err != nil {
		// hook のバグで作業を止めない（黙って全ルールが無効にならないよう .errors.jsonl に残す）
		LogError(io, "feedback-post-edit", ErrorText(err))
		return Ok("", "[feedback-post-edit] internal error (ignored): "+ErrorText(err)+"\n")
	}
	return res
}
