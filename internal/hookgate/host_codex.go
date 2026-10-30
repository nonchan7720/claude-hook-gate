package hookgate

// Codex（plugins/codex）向けの Host。Codex の hook は Claude Code の classic コマンド hook と同じイベント名・JSON・出力規約で、
// 違い（apply_patch、PermissionRequest、spawn_agent、ask が無いこと、stderr が見えないこと）だけをここで吸収する。

import (
	"encoding/json"
	"strings"
)

// CodexEvents は Codex の command hook が受けるイベント名。
var CodexEvents = []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SubagentStop"}

// CodexConfigDirs は設定ディレクトリ名の候補。Codex は .agents を使う。.claude は Claude Code と共用するプロジェクトのため。
var CodexConfigDirs = []string{".agents", ".claude"}

// CodexOptionsFromEnv は Codex の設定。Codex に userConfig は無いので FEEDBACK_GATE_<KEY> で受ける。CLAUDE_PLUGIN_OPTION_<key> も読む。
func CodexOptionsFromEnv(env map[string]string) PluginOptions {
	// TS の `a ?? b`: a が設定されていれば（空文字でも）a。
	pick := func(codexKey, claudeKey string) string {
		if v, ok := env["FEEDBACK_GATE_"+codexKey]; ok {
			return v
		}
		return env["CLAUDE_PLUGIN_OPTION_"+claudeKey]
	}
	return PluginOptions{
		// FEEDBACK_GATE_LANG は ResolveLang（i18n.go）が直接読む。
		Language:         env["CLAUDE_PLUGIN_OPTION_language"],
		AgentLaunchGuard: pick("AGENT_LAUNCH_GUARD", "agentLaunchGuard") == "true",
		AutoCount:        BoolPtr(pick("AUTO_COUNT", "autoCount") != "false"),
		RulesFile:        pick("RULES_FILE", "rulesFile"),
	}
}

// ClaudeToolName は Codex のツール名を Claude Code のものに読み替える（spawn_agent → Agent、send_input → SendMessage）。
func ClaudeToolName(tool string) string {
	switch tool {
	case "spawn_agent":
		return "Agent"
	case "send_input":
		return "SendMessage"
	}
	return tool
}

func copyDict(d Dict) Dict {
	out := make(Dict, len(d)+2)
	for k, v := range d {
		out[k] = v
	}
	return out
}

func agentPayload(payload Dict, tool string) Dict {
	input, _ := AsDict(payload["tool_input"])
	toolInput := copyDict(input)
	switch tool {
	case "Agent":
		if _, has := toolInput["subagent_type"]; !has {
			if s, ok := input["agent_type"].(string); ok {
				toolInput["subagent_type"] = s
			}
		}
		if _, has := toolInput["prompt"]; !has {
			if s, ok := input["message"].(string); ok {
				toolInput["prompt"] = s
			}
		}
	case "SendMessage":
		if _, has := toolInput["to"]; !has {
			if s, ok := input["agent_id"].(string); ok {
				toolInput["to"] = s
			}
		}
	}
	out := copyDict(payload)
	out["tool_name"] = tool
	out["tool_input"] = toolInput
	return out
}

func agentResponse(payload Dict) Dict {
	response := payload["tool_response"]
	if s, ok := response.(string); ok {
		var parsed any
		if err := json.Unmarshal([]byte(s), &parsed); err != nil {
			return payload
		}
		response = parsed
	}
	d, ok := AsDict(response)
	if !ok {
		return payload
	}
	agentID := strOf(d["agentId"])
	if agentID == "" {
		agentID = strOf(d["agent_id"])
	}
	if agentID == "" {
		return payload
	}
	resp := copyDict(d)
	resp["agentId"] = agentID
	out := copyDict(payload)
	out["tool_response"] = resp
	return out
}

// CodexPluginSeenDir はプラグイン層の hook が走った印のマーカーの置き場（<feedbackDir>/.codex_plugin_seen/<session_id>）。
const CodexPluginSeenDir = ".codex_plugin_seen"

// CodexHookSourcePlugin は FEEDBACK_GATE_HOOK_SOURCE の、プラグイン同梱の hooks.json から呼ばれたことを表す値。
const CodexHookSourcePlugin = "plugin"

// codexPluginSeenMarker はセッションのマーカーのパス。session_id が空（か安全な文字を含まない）なら ""。
func codexPluginSeenMarker(io Io, payload Dict) string {
	sessionID := fbNonSessionCharRe.ReplaceAllString(strOf(payload["session_id"]), "")
	if sessionID == "" {
		return ""
	}
	return Join(FeedbackDir(io), CodexPluginSeenDir, sessionID)
}

// CodexHookSourceAllows は、同じ hook がプラグイン層（plugins/codex/hooks/hooks.json）と設定層（~/.codex/hooks.json や
// プロジェクトの .codex/hooks.json、管理者の hooks への写し。install-hooks が書く）の両方に登録されていても二重に走らせないための判定。
// Codex は一致した hook を全部走らせるので、プラグイン同梱の hook が動く環境（plugin_hooks が有効）で写しも残っていると、
// 各イベントが 2 回ずつ走ってしまう。Claude Code の .classic_seen と同じく、プラグイン層の呼び出し（hook.sh が Codex の PLUGIN_ROOT を
// 見て FEEDBACK_GATE_HOOK_SOURCE=plugin にする）が <feedbackDir>/.codex_plugin_seen/<session_id> を毎回書き、それ以外の呼び出しは
// マーカーがあれば何もしない（false）。プラグイン層が走らない環境（plugin_hooks が無効、allow_managed_hooks_only、未信頼）では
// マーカーが無いので写しが働く。初回の SessionStart は両方が同時に走りうるが、reset は冪等。
func CodexHookSourceAllows(io Io, payload Dict) bool {
	marker := codexPluginSeenMarker(io, payload)
	if marker == "" {
		return true
	}
	if io.Env().FeedbackGateHookSource == CodexHookSourcePlugin {
		// マーカーを書けなくても作業は止めない（写しが二重に動きうるだけ）。
		_ = io.WriteFile(marker, "1\n")
		return true
	}
	return !io.Exists(marker)
}

// CodexNormalize は Codex のイベントと stdin の JSON を中核の呼び出しに直す。未知のイベントは ok=false。
// 設定層への写しからの呼び出しで、プラグイン層の hook が同じセッションで走っているときも ok=false（何も出さない）。
func CodexNormalize(event string, payload Dict, io Io) (CoreCall, bool) {
	if !CodexHookSourceAllows(io, payload) {
		return CoreCall{}, false
	}
	base := strOf(payload["cwd"])
	if base == "" {
		base = io.Cwd()
	}
	rawTool := strOf(payload["tool_name"])
	tool := ClaudeToolName(rawTool)
	switch event {
	case "SessionStart", "UserPromptSubmit", "Stop", "SubagentStop":
		return CoreCall{Event: event, Payloads: []Dict{payload}}, true
	case "PreToolUse":
		if rawTool == "apply_patch" {
			return CoreCall{Event: event, Payloads: PatchPayloads(payload, base)}, true
		}
		if tool == "Agent" || tool == "SendMessage" {
			return CoreCall{Event: event, Payloads: []Dict{agentPayload(payload, tool)}}, true
		}
		return CoreCall{Event: event, Payloads: []Dict{payload}}, true
	case "PostToolUse":
		if rawTool == "apply_patch" {
			return CoreCall{Event: event, Payloads: PatchPayloads(payload, base)}, true
		}
		if tool == "Agent" {
			p := copyDict(payload)
			p["tool_name"] = tool
			return CoreCall{Event: event, Payloads: []Dict{agentResponse(p)}}, true
		}
		return CoreCall{Event: event, Payloads: []Dict{payload}}, true
	case "PermissionRequest":
		// Codex に Notification は無い。承認待ちを「確認待ち」の通知にし、判定は返さない（CodexRender が PermissionRequest では何も出さない）。
		input, _ := AsDict(payload["tool_input"])
		message := strOf(input["description"])
		if message == "" {
			message = strOf(input["command"])
		}
		p := payload
		if message != "" {
			p = copyDict(payload)
			p["message"] = message
		}
		return CoreCall{Event: "Notification", Payloads: []Dict{p}}, true
	}
	return CoreCall{}, false
}

// CodexRender は中核の結果（Outcome と warn の stderr）を Codex の出力にする。
func CodexRender(event string, outcome Outcome, stderr string, io Io) ScriptResult {
	var j, specific OMap
	warnings := strings.TrimFunc(stderr, isJSSpace)
	var parts []string
	for _, c := range outcome.AdditionalContext {
		if strings.TrimFunc(c, isJSSpace) != "" {
			parts = append(parts, c)
		}
	}
	context := strings.Join(parts, "\n\n")
	switch event {
	case "PreToolUse":
		switch {
		case outcome.Deny != nil:
			specific = append(specific, KV{"permissionDecision", "deny"}, KV{"permissionDecisionReason", *outcome.Deny})
		case outcome.Ask != nil:
			// Codex の PreToolUse に ask は無い（返すと hook が失敗扱いになりツールが動く）。同じ対象の 2 回目は中核が warn に落とす。
			specific = append(specific, KV{"permissionDecision", "deny"}, KV{"permissionDecisionReason", *outcome.Ask + "\n" + Tr(io.Lang())("codex.askAsDeny")})
		case warnings != "":
			// exit 0 の stderr は Codex では見えないので、warn はモデルの context に載せる（PostToolUse も同じ、Stop は systemMessage）。
			specific = append(specific, KV{"additionalContext", warnings})
		}
	case "PostToolUse":
		if outcome.Block != nil {
			j = append(j, KV{"decision", "block"}, KV{"reason", *outcome.Block})
		}
		var ctxParts []string
		if context != "" {
			ctxParts = append(ctxParts, context)
		}
		if outcome.Block == nil && warnings != "" {
			ctxParts = append(ctxParts, warnings)
		}
		if len(ctxParts) > 0 {
			specific = append(specific, KV{"additionalContext", strings.Join(ctxParts, "\n\n")})
		}
	case "Stop", "SubagentStop":
		if outcome.Block != nil {
			j = append(j, KV{"decision", "block"}, KV{"reason", *outcome.Block})
		} else if warnings != "" {
			j = append(j, KV{"systemMessage", warnings})
		}
		if outcome.PreventContinuation {
			j = append(j, KV{"continue", false})
			if outcome.StopReason != nil {
				j = append(j, KV{"stopReason", *outcome.StopReason})
			}
		}
	case "UserPromptSubmit", "SessionStart":
		if outcome.Block != nil {
			j = append(j, KV{"decision", "block"}, KV{"reason", *outcome.Block})
		}
		if context != "" {
			specific = append(specific, KV{"additionalContext", context})
		}
	}
	if len(specific) > 0 {
		j = append(j, KV{"hookSpecificOutput", append(OMap{{"hookEventName", event}}, specific...)})
	}
	stdout := ""
	if len(j) > 0 {
		stdout = JSONStringify(j) + "\n"
	}
	return ScriptResult{ExitCode: 0, Stdout: stdout, Stderr: stderr}
}

type codexHost struct{}

// CodexHost は Codex の command hook 向けの Host。
var CodexHost Host = codexHost{}

func (codexHost) AppName() string          { return "Codex" }
func (codexHost) Events() []string         { return CodexEvents }
func (codexHost) ConfigDirNames() []string { return CodexConfigDirs }

func (codexHost) Options(env map[string]string) PluginOptions { return CodexOptionsFromEnv(env) }

func (codexHost) Normalize(event string, payload Dict, io Io) (CoreCall, bool) {
	return CodexNormalize(event, payload, io)
}

func (codexHost) Render(event string, outcome Outcome, stderr string, io Io) ScriptResult {
	return CodexRender(event, outcome, stderr, io)
}
