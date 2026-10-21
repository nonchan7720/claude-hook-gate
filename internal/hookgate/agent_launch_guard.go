package hookgate

// PreToolUse(Agent|SendMessage): サブエージェントへ作業指示を送る前に、送信内容そのものを見せて ask を返す。
//
// サブエージェントはメインエージェントの会話コンテキストを持たないため、指示が雑だと別解釈で実装が進み
// 手戻りになる。確認ダイアログに本文を載せないと確認の意味がないので、permissionDecisionReason に
// prompt / message をそのまま入れる。
//
// - Agent: AskAgentTypes に列挙した subagent_type の起動を ask
// - SendMessage: AllowRecipients 以外の宛先への送信を ask
//
// どちらにも該当しなければ何も出力せず、通常のパーミッション判定に委ねる。
//
// 一覧は環境変数で差し替えられる（AgentLaunchLists）: FEEDBACK_GATE_ASK_AGENT_TYPES と FEEDBACK_GATE_ALLOW_RECIPIENTS に
// `,` か `;` 区切りで並べる（前後の空白は無視、空の要素は捨てる）。未設定なら既定の一覧。

import "strings"

// AskAgentTypes は起動前に確認する subagent_type の既定。
var AskAgentTypes = []string{"code-implementer"}

// AllowRecipients は確認なしで送ってよい宛先（エージェント名）の既定。
var AllowRecipients = []string{"git-operator"}

// ParseAgentList は `,` / `;` 区切りの一覧を要素に分ける。前後の空白は落とし、空の要素は捨てる。
func ParseAgentList(s string) []string {
	var out []string
	for _, item := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' }) {
		if v := strings.TrimSpace(item); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// AgentLaunchLists は環境変数から [確認する subagent_type, 確認なしで送ってよい宛先] を決める。未設定（または空の一覧）なら既定。
func AgentLaunchLists(env EnvVars) ([]string, []string) {
	askAgentTypes := ParseAgentList(env.FeedbackGateAskAgentTypes)
	if len(askAgentTypes) == 0 {
		askAgentTypes = AskAgentTypes
	}
	allowRecipients := ParseAgentList(env.FeedbackGateAllowRecipients)
	if len(allowRecipients) == 0 {
		allowRecipients = AllowRecipients
	}
	return askAgentTypes, allowRecipients
}

func fbAskLaunch(reason string) ScriptResult {
	return Ok(JSONStringify(OMap{{"hookSpecificOutput", OMap{
		{"hookEventName", "PreToolUse"},
		{"permissionDecision", "ask"},
		{"permissionDecisionReason", reason},
	}}})+"\n", "")
}

// AgentLaunchGuard はサブエージェントへの作業指示の送信前に、本文を見せて ask を返す（既定の一覧）。
func AgentLaunchGuard(payload Dict, lang Lang) ScriptResult {
	return AgentLaunchGuardWith(payload, lang, AskAgentTypes, AllowRecipients)
}

// AgentLaunchGuardWith は AgentLaunchGuard の、確認する subagent_type と確認なしの宛先を指定する形。
func AgentLaunchGuardWith(payload Dict, lang Lang, askAgentTypes, allowRecipients []string) ScriptResult {
	t := Tr(lang)
	tool := JqStr(payload["tool_name"])
	input := Dict{}
	if d, ok := payload["tool_input"].(map[string]any); ok {
		input = d
	}
	switch tool {
	case "Agent":
		agentType := JqStr(input["subagent_type"])
		if agentType == "" {
			return Ok("", "")
		}
		if fbContainsString(askAgentTypes, agentType) {
			return fbAskLaunch(t("launch.promptTo", map[string]any{"agentType": agentType}) + "\n\n" + JqStr(input["prompt"]) + "\n\n" + t("launch.checklist"))
		}
	case "SendMessage":
		recipient := JqStr(input["to"])
		if !fbContainsString(allowRecipients, recipient) {
			shown := recipient
			if shown == "" {
				shown = t("launch.unknownRecipient")
			}
			return fbAskLaunch(t("launch.messageTo", map[string]any{"recipient": shown}) + "\n\n" + JqStr(input["message"]) + "\n\n" + t("launch.checklist"))
		}
	}
	return Ok("", "")
}
