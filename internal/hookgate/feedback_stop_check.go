package hookgate

// Stop hook: feedback ルールの stop_check enforce を評価する。
//
// 変更ファイルの一覧は record-changes が書く
// ${projectDir}/.claude/.gate-status/changed_files.${sessionId}[--${agentId}].txt を優先して読む
// （gate.yaml を持つプロジェクトでしか作られないため、無ければ GetChangedFiles() が git diff / git status で
// フォールバックする）。payload に agent_id があれば SubagentStop（サブエージェントの Stop）とみなし、
// そのエージェント別メモ・attempts ファイル（feedback_gate_attempts.${sessionId}--${agentId}.txt）だけを見る。
//
// severity が warn 以外（block/ask/deny）の違反があれば stderr に出して exit 2（修正を継続させる）。
// warn のみなら stderr に出して exit 0。
//
// 無限ループ防止のため、FeedbackMaxAttempts 回連続でブロックしたら諦めて exit 0 にする。

import (
	"regexp"
	"strconv"
	"strings"
)

// FeedbackMaxAttempts は連続でブロックする上限。
const FeedbackMaxAttempts = 3

// AttemptsPath は連続ブロック回数を持つファイル。agentID が空なら本体の Stop 用。
func FeedbackAttemptsPath(io Io, sessionID string, agentID string) string {
	id := sessionID
	if agentID != "" {
		id = sessionID + "--" + agentID
	}
	return Join(GateStatusDir(io), "feedback_gate_attempts."+id+".txt")
}

var fbAttemptsTextRe = regexp.MustCompile(`^[` + fbJsSpaceClass + `]*[+-]?\d+[` + fbJsSpaceClass + `]*$`)

func fbBumpAttempts(io Io, path string) int {
	attempts := 0
	if text, ok := io.ReadFile(path); ok && fbAttemptsTextRe.MatchString(text) {
		attempts = ToCount(fbJsTrim(text))
	}
	attempts++
	_ = io.WriteFile(path, strconv.Itoa(attempts)) // 書けなくても続ける
	return attempts
}

func feedbackStopCheckMain(io Io, payload Dict) (ScriptResult, error) {
	projectDir := fbFirstNonEmpty(io.ProjectDir(), io.Cwd())
	sessionID := "unknown"
	if Truthy(payload["session_id"]) {
		sessionID = Str(payload["session_id"])
	}
	agentID := ""
	if Truthy(payload["agent_id"]) {
		agentID = Str(payload["agent_id"])
	}
	ap := FeedbackAttemptsPath(io, sessionID, agentID)

	files := GetChangedFiles(io, projectDir, sessionID, agentID)
	if len(files) == 0 {
		io.RemoveFiles([]string{ap})
		return Ok("", ""), nil
	}

	rules, err := ListRules(io)
	if err != nil {
		return ScriptResult{}, err
	}
	violations := EvalStopCheck(io, rules, projectDir, files)
	if len(violations) == 0 {
		io.RemoveFiles([]string{ap})
		return Ok("", ""), nil
	}

	for _, v := range violations {
		LogViolation(io, v.Rule, v.Count, v.Severity, v.Event, v.Detail)
	}
	notes := CountBumpNotes(io.Lang(), AutoBumpCounts(io, rules, violations, payload["session_id"]))
	noteText := fbJoinLines(notes)

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
		stderr.WriteString("[feedback-stop-check] warn: " + v.Rule + " (count: " + strconv.Itoa(v.Count) + "): " + v.Message + "\n")
	}

	t := Tr(io.Lang())
	if len(blocking) == 0 {
		io.RemoveFiles([]string{ap})
		return Ok("", stderr.String()+noteText), nil
	}

	attempts := fbBumpAttempts(io, ap)
	if attempts >= FeedbackMaxAttempts {
		stderr.WriteString(t("stopCheck.gaveUp", map[string]any{"max": FeedbackMaxAttempts}) + "\n")
		io.RemoveFiles([]string{ap})
		return Ok("", stderr.String()+noteText), nil
	}

	lines := make([]string, 0, len(blocking)+len(notes)+1)
	for _, v := range blocking {
		lines = append(lines, "[feedback-stop-check] "+v.Rule+" (count: "+strconv.Itoa(v.Count)+"): "+v.Message+" ("+v.Detail+")")
	}
	lines = append(lines, notes...)
	lines = append(lines, t("stopCheck.fixAbove", map[string]any{"attempt": attempts, "max": FeedbackMaxAttempts}))
	stderr.WriteString(fbJoinLines(lines))
	stdout := JSONStringify(OMap{{"decision", "block"}, {"reason", strings.Join(lines, "\n")}}) + "\n"
	return ScriptResult{ExitCode: 2, Stdout: stdout, Stderr: stderr.String()}, nil
}

// FeedbackStopCheck は Stop hook の本体。
func FeedbackStopCheck(io Io, payload Dict) ScriptResult {
	res, err := fbCatchResult(func() (ScriptResult, error) { return feedbackStopCheckMain(io, payload) })
	if err != nil {
		// hook のバグで作業を止めない（黙って全ルールが無効にならないよう .errors.jsonl に残す）
		LogError(io, "feedback-stop-check", ErrorText(err))
		return Ok("", "[feedback-stop-check] internal error (ignored): "+ErrorText(err)+"\n")
	}
	return res
}
