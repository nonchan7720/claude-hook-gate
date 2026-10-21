package hookgate

// Claude Code の settings hook（hooks/hooks.json）向けの Host。classic の JSON は中核の形そのものなので Normalize は素通し。

// ClaudeOptionsFromEnv はプラグイン設定。CLAUDE_PLUGIN_OPTION_<key>（boolean は "true" / "false" の文字列）で届く。
func ClaudeOptionsFromEnv(env map[string]string) PluginOptions {
	opt := func(key string) string { return env["CLAUDE_PLUGIN_OPTION_"+key] }
	return PluginOptions{
		Language:         opt("language"),
		AgentLaunchGuard: opt("agentLaunchGuard") == "true",
		AutoCount:        BoolPtr(opt("autoCount") != "false"),
		RulesFile:        opt("rulesFile"),
	}
}

type claudeHost struct{}

// ClaudeHost は Claude Code の settings hook 向けの Host。
var ClaudeHost Host = claudeHost{}

func (claudeHost) AppName() string          { return "Claude Code" }
func (claudeHost) Events() []string         { return CoreEvents }
func (claudeHost) ConfigDirNames() []string { return ClaudeConfigDirs }

func (claudeHost) Options(env map[string]string) PluginOptions { return ClaudeOptionsFromEnv(env) }

func (claudeHost) Normalize(event string, payload Dict, _ Io) (CoreCall, bool) {
	return CoreCall{Event: event, Payloads: []Dict{payload}}, true
}

func (claudeHost) Render(event string, outcome Outcome, stderr string, _ Io) ScriptResult {
	return OutcomeToClassic(event, outcome, stderr)
}
