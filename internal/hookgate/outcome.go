package hookgate

// classic コマンド hook の結果（終了コード + stdout の JSON）を、function hook の戻り値へ変換する。

import (
	"encoding/json"
	"strings"
)

// Outcome は hook の判定。TS の undefined と ” を区別するため、文字列は *string（nil が undefined）。
type Outcome struct {
	Block *string
	// BlockReason は exit 2 の step が stdout に出した JSON の reason（Block = stderr 全体 の要約版）。Codex は reason が
	// 会話に載るので、全出力の stderr ではなくこちらを使う。無ければ nil。
	BlockReason         *string
	Deny                *string
	Ask                 *string
	Allow               bool
	PreventContinuation bool
	StopReason          *string
	AdditionalContext   []string
}

// StrPtr は *string を作る。
func StrPtr(s string) *string { return &s }

var textContextEvents = map[string]bool{"UserPromptSubmit": true, "SessionStart": true}

func parseJSONDict(text string) (Dict, bool) {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "{") {
		return nil, false
	}
	var v any
	if err := json.Unmarshal([]byte(t), &v); err != nil {
		return nil, false
	}
	return AsDict(v)
}

func strOrEmpty(v any) string {
	if v == nil {
		return ""
	}
	return Str(v)
}

func outcomeFromJSON(event string, j Dict) Outcome {
	var out Outcome
	if j["decision"] == "block" {
		out.Block = StrPtr(strOrEmpty(j["reason"]))
	}
	if b, ok := j["continue"].(bool); ok && !b {
		out.PreventContinuation = true
		if s, ok := j["stopReason"].(string); ok {
			out.StopReason = StrPtr(s)
		}
	}
	if specific, ok := AsDict(j["hookSpecificOutput"]); ok {
		if s, ok := specific["additionalContext"].(string); ok && s != "" {
			out.AdditionalContext = []string{s}
		}
		if event == "PreToolUse" {
			reason := strOrEmpty(specific["permissionDecisionReason"])
			switch specific["permissionDecision"] {
			case "allow":
				out.Allow = true
			case "ask":
				out.Ask = StrPtr(reason)
			case "deny":
				out.Deny = StrPtr(reason)
			}
		}
	}
	return out
}

// exit2Summary は exit 2 の step が stdout に出した JSON の要約済みの reason（PreToolUse は permissionDecisionReason）。
// JSON でない、または reason が空なら nil。
func exit2Summary(event, stdout string) *string {
	j, ok := parseJSONDict(stdout)
	if !ok {
		return nil
	}
	reason := ""
	if event == "PreToolUse" {
		if specific, ok := AsDict(j["hookSpecificOutput"]); ok {
			reason = strOrEmpty(specific["permissionDecisionReason"])
		}
	} else if j["decision"] == "block" {
		reason = strOrEmpty(j["reason"])
	}
	if strings.TrimSpace(reason) == "" {
		return nil
	}
	return StrPtr(reason)
}

// ToOutcome は classic コマンド hook の規約: exit 0 は stdout を解釈、exit 2 はブロック、他の非 0 は無視。
func ToOutcome(event string, ran ScriptResult) Outcome {
	if ran.ExitCode == 2 {
		reason := strings.TrimSpace(ran.Stderr)
		if reason == "" {
			reason = "hook exited with code 2"
		}
		summary := exit2Summary(event, ran.Stdout)
		if event == "PreToolUse" {
			return Outcome{Deny: StrPtr(reason), BlockReason: summary}
		}
		return Outcome{Block: StrPtr(reason), BlockReason: summary}
	}
	if ran.ExitCode != 0 {
		return Outcome{}
	}
	if j, ok := parseJSONDict(ran.Stdout); ok {
		return outcomeFromJSON(event, j)
	}
	text := strings.TrimSpace(ran.Stdout)
	if text != "" && textContextEvents[event] {
		return Outcome{AdditionalContext: []string{text}}
	}
	return Outcome{}
}

// Merge は先に出たものを優先し、AdditionalContext は連結する。
func Merge(first, second Outcome) Outcome {
	out := second
	if first.Block != nil {
		out.Block = first.Block
	}
	if first.Block != nil || first.Deny != nil {
		// 要約版は Block / Deny と同じ step のものを使う（先の step が要約を持たないのに、後の step の要約が混ざらないように）。
		out.BlockReason = first.BlockReason
	}
	if first.Deny != nil {
		out.Deny = first.Deny
	}
	if first.Ask != nil {
		out.Ask = first.Ask
	}
	if first.Allow {
		out.Allow = true
	}
	if first.PreventContinuation {
		out.PreventContinuation = true
	}
	if first.StopReason != nil {
		out.StopReason = first.StopReason
	}
	var ctx []string
	ctx = append(ctx, first.AdditionalContext...)
	ctx = append(ctx, second.AdditionalContext...)
	if len(ctx) > 0 {
		out.AdditionalContext = ctx
	} else {
		out.AdditionalContext = nil
	}
	return out
}

// Decided は判定（block / deny / ask / allow）が出ているか。
func Decided(o Outcome) bool {
	return o.Block != nil || o.Deny != nil || o.Ask != nil || o.Allow
}

// OutcomeToClassic は Outcome を classic コマンド hook の出力（終了コード 0 + stdout の JSON）へ戻す。settings hook の CLI が使う。
// ToOutcome の逆変換で、exit 2 の block / deny は JSON の判定（decision: block / permissionDecision: deny）で同じ効果になる
// （exit 2 は stderr を理由にするだけで、stdout の JSON は無視される規約なので、情報は reason に移す）。
// stderr は warn など正常終了時の出力で、そのまま stderr へ出す。
func OutcomeToClassic(event string, outcome Outcome, stderr string) ScriptResult {
	var j OMap
	var specific OMap
	var ctxParts []string
	for _, c := range outcome.AdditionalContext {
		if strings.TrimSpace(c) != "" {
			ctxParts = append(ctxParts, c)
		}
	}
	context := strings.Join(ctxParts, "\n\n")
	if event == "PreToolUse" {
		// 返す判定は deny / ask だけ（allow は返さず、ユーザーの判断に委ねる）。deny が先。
		switch {
		case outcome.Deny != nil:
			specific = append(specific, KV{"permissionDecision", "deny"}, KV{"permissionDecisionReason", *outcome.Deny})
		case outcome.Ask != nil:
			specific = append(specific, KV{"permissionDecision", "ask"}, KV{"permissionDecisionReason", *outcome.Ask})
		}
	} else if outcome.Block != nil {
		j = append(j, KV{"decision", "block"}, KV{"reason", *outcome.Block})
	}
	if context != "" && event != "Stop" && event != "SubagentStop" && event != "Notification" {
		specific = append(specific, KV{"additionalContext", context})
	}
	if len(specific) > 0 {
		j = append(j, KV{"hookSpecificOutput", append(OMap{{"hookEventName", event}}, specific...)})
	}
	if outcome.PreventContinuation {
		j = append(j, KV{"continue", false})
		if outcome.StopReason != nil {
			j = append(j, KV{"stopReason", *outcome.StopReason})
		}
	}
	stdout := ""
	if len(j) > 0 {
		stdout = JSONStringify(j) + "\n"
	}
	return ScriptResult{ExitCode: 0, Stdout: stdout, Stderr: stderr}
}
