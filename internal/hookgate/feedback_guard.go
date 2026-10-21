package hookgate

// PreToolUse hook: feedback ルールの enforce (pre_bash / pre_edit) を評価し、
// count に応じた強制力（deny / ask / warn）を適用する。
//
// - Bash: command を pre_bash の enforce と照合する
// - Edit / Write / MultiEdit: file_path と変更後の内容を pre_edit の enforce と照合する
//
// severity が deny/ask（block は防御的に deny 扱い）の違反があれば stdout に hookSpecificOutput を出して
// 該当ツール呼び出しを止める。warn のみなら stderr に書いて exit 0（ツールは実行させる）。違反が無ければ
// 何も出さず exit 0。
//
// hook 自身のバグで作業を止めないよう、例外は必ず握りつぶして exit 0 にする（stderr に1行だけ出し、~/.claude/feedback/.errors.jsonl に残す）。

import (
	"strconv"
	"strings"
)

var fbSeverityOrder = map[string]int{"warn": 0, "ask": 1, "block": 2, "deny": 3}

// DecisionFor は PreToolUse の permissionDecision（allow/deny/ask のみ。block は防御的に deny 扱い）。
func DecisionFor(severity string) string {
	if severity == "deny" || severity == "block" {
		return "deny"
	}
	return "ask"
}

// BuildReason は違反の一覧を permissionDecisionReason の本文にする。
func BuildReason(violations []Violation) string {
	lines := make([]string, len(violations))
	for i, v := range violations {
		lines[i] = v.Rule + " (count: " + strconv.Itoa(v.Count) + "): " + v.Message
	}
	return strings.Join(lines, "\n")
}

// AskStatePath は同一セッションで ask 済みの対象を持つ状態ファイル。
func AskStatePath(io Io, sessionID string) string {
	return Join(FeedbackDir(io), ".ask_state", fbNonSessionCharRe.ReplaceAllString(sessionID, "")+".json")
}

// LoadAskedKeys は ask 済みのキーを読む。壊れた状態ファイルは空扱い。
func LoadAskedKeys(io Io, sessionID string) map[string]bool {
	return fbLoadNameSet(io, AskStatePath(io, sessionID), "asked")
}

// SaveAskedKeys は ask 済みのキーを保存する。状態の保存失敗で hook を止めない。
func SaveAskedKeys(io Io, sessionID string, askedKeys map[string]bool) {
	_ = io.WriteFile(AskStatePath(io, sessionID), JSONStringify(OMap{{"asked", fbSortedKeys(askedKeys)}}))
}

// AskKey は違反を ask 済みか判定するキー（ルール・イベント・対象ファイル）。
func AskKey(v Violation, toolInput Dict) string {
	target := ""
	if v.Event == "pre_edit" && Truthy(toolInput["file_path"]) {
		target = Str(toolInput["file_path"])
	}
	return v.Rule + "|" + v.Event + "|" + target
}

// DowngradeRepeatedAsks は同一セッション・同一対象で 2 回目以降の ask を warn に落とす（violations を書き換える）。
// deny/block は対象外。
func DowngradeRepeatedAsks(io Io, violations []Violation, sessionID any, toolInput Dict) {
	if !Truthy(sessionID) {
		return
	}
	sid := Str(sessionID)
	asked := LoadAskedKeys(io, sid)
	newlyAsked := map[string]bool{}
	for i := range violations {
		if violations[i].Severity != "ask" {
			continue
		}
		key := AskKey(violations[i], toolInput)
		if asked[key] {
			violations[i].Severity = "warn"
		} else {
			newlyAsked[key] = true
		}
	}
	if len(newlyAsked) > 0 {
		for k := range newlyAsked {
			asked[k] = true
		}
		SaveAskedKeys(io, sid, asked)
	}
}

func feedbackGuardMain(io Io, payload Dict) (ScriptResult, error) {
	toolName := ""
	if Truthy(payload["tool_name"]) {
		toolName = Str(payload["tool_name"])
	}
	toolInput := Dict{}
	if d, ok := payload["tool_input"].(map[string]any); ok {
		toolInput = d
	}

	rules, err := ListRules(io)
	if err != nil {
		return ScriptResult{}, err
	}
	var violations []Violation
	switch toolName {
	case "Bash":
		command := ""
		if Truthy(toolInput["command"]) {
			command = Str(toolInput["command"])
		}
		violations = EvalPreBash(io, rules, command)
	case "Edit", "Write", "MultiEdit":
		filePath := ""
		if Truthy(toolInput["file_path"]) {
			filePath = Str(toolInput["file_path"])
		}
		if filePath == "" {
			return Ok("", ""), nil
		}
		violations = EvalPreEdit(io, rules, filePath, ExtractPreEditContent(toolName, toolInput))
	default:
		return Ok("", ""), nil
	}

	if len(violations) == 0 {
		return Ok("", ""), nil
	}

	DowngradeRepeatedAsks(io, violations, payload["session_id"], toolInput)

	for _, v := range violations {
		LogViolation(io, v.Rule, v.Count, v.Severity, v.Event, v.Detail)
	}
	// 今回の判定は上げる前の count で行い、次回以降の強制力を上げる。
	notes := CountBumpNotes(io.Lang(), AutoBumpCounts(io, rules, violations, payload["session_id"]))

	blocking, warnings := []Violation{}, []Violation{}
	for _, v := range violations {
		if v.Severity == "warn" {
			warnings = append(warnings, v)
		} else {
			blocking = append(blocking, v)
		}
	}

	stdout := ""
	if len(blocking) > 0 {
		top := blocking[0]
		for _, b := range blocking[1:] {
			if fbSeverityOrder[b.Severity] > fbSeverityOrder[top.Severity] {
				top = b
			}
		}
		reason := strings.Join(append([]string{BuildReason(blocking)}, notes...), "\n")
		stdout = JSONStringify(OMap{{"hookSpecificOutput", OMap{
			{"hookEventName", "PreToolUse"},
			{"permissionDecision", DecisionFor(top.Severity)},
			{"permissionDecisionReason", reason},
		}}}) + "\n"
	}
	lines := make([]string, 0, len(warnings)+len(notes))
	for _, v := range warnings {
		lines = append(lines, "[feedback-guard] warn: "+v.Rule+" (count: "+strconv.Itoa(v.Count)+"): "+v.Message)
	}
	lines = append(lines, notes...)
	return Ok(stdout, fbJoinLines(lines)), nil
}

// fbJoinLines は各行の後ろに改行を付けて連結する（lines.map((l) => `${l}\n`).join(”)）。
func fbJoinLines(lines []string) string {
	var b strings.Builder
	for _, l := range lines {
		b.WriteString(l)
		b.WriteByte('\n')
	}
	return b.String()
}

// FeedbackGuard は PreToolUse hook の本体。
func FeedbackGuard(io Io, payload Dict) ScriptResult {
	res, err := fbCatchResult(func() (ScriptResult, error) { return feedbackGuardMain(io, payload) })
	if err != nil {
		// hook のバグで作業を止めない（黙って全ルールが無効にならないよう .errors.jsonl に残す）
		LogError(io, "feedback-guard", ErrorText(err))
		return Ok("", "[feedback-guard] internal error (ignored): "+ErrorText(err)+"\n")
	}
	return res
}
