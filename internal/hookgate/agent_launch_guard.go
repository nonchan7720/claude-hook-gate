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

// AskAgentTypes は起動前に確認する subagent_type。
var AskAgentTypes = []string{"code-implementer"}

// AllowRecipients は確認なしで送ってよい宛先（エージェント名）。
var AllowRecipients = []string{"git-operator"}

func fbAskLaunch(reason string) ScriptResult {
	return Ok(JSONStringify(OMap{{"hookSpecificOutput", OMap{
		{"hookEventName", "PreToolUse"},
		{"permissionDecision", "ask"},
		{"permissionDecisionReason", reason},
	}}})+"\n", "")
}

// AgentLaunchGuard はサブエージェントへの作業指示の送信前に、本文を見せて ask を返す。
func AgentLaunchGuard(payload Dict, lang Lang) ScriptResult {
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
		if fbContainsString(AskAgentTypes, agentType) {
			return fbAskLaunch(t("launch.promptTo", map[string]any{"agentType": agentType}) + "\n\n" + JqStr(input["prompt"]) + "\n\n" + t("launch.checklist"))
		}
	case "SendMessage":
		recipient := JqStr(input["to"])
		if !fbContainsString(AllowRecipients, recipient) {
			shown := recipient
			if shown == "" {
				shown = t("launch.unknownRecipient")
			}
			return fbAskLaunch(t("launch.messageTo", map[string]any{"recipient": shown}) + "\n\n" + JqStr(input["message"]) + "\n\n" + t("launch.checklist"))
		}
	}
	return Ok("", "")
}
