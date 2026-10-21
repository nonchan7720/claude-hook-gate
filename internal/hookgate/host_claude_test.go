package hookgate

// tests/host-claude.spec.ts の移植。Claude Code の settings hook 向けの Host（host_claude.go）: classic の payload は中核の形そのものなので
// 素通し、出力は OutcomeToClassic。

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClaudeHost(t *testing.T) {
	io := MakeIo(IoOpts{ProjectDir: "/proj"})

	t.Run("名前・イベント・設定", func(t *testing.T) {
		assert.Equal(t, "Claude Code", ClaudeHost.AppName())
		assert.Equal(t, []string{".claude", ".agents"}, ClaudeHost.ConfigDirNames())
		assert.Equal(t, []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop"}, ClaudeHost.Events())
		assert.Equal(t, PluginOptions{Language: "ja", AgentLaunchGuard: true, AutoCount: BoolPtr(false), RulesFile: "/r.md"},
			ClaudeHost.Options(map[string]string{
				"CLAUDE_PLUGIN_OPTION_language":         "ja",
				"CLAUDE_PLUGIN_OPTION_agentLaunchGuard": "true",
				"CLAUDE_PLUGIN_OPTION_autoCount":        "false",
				"CLAUDE_PLUGIN_OPTION_rulesFile":        "/r.md",
			}))
		empty := ClaudeHost.Options(map[string]string{})
		assert.Equal(t, PluginOptions{Language: "", AgentLaunchGuard: false, AutoCount: BoolPtr(true), RulesFile: ""}, empty)
		assert.True(t, empty.AutoCountEnabled())
		assert.False(t, ClaudeHost.Options(map[string]string{"CLAUDE_PLUGIN_OPTION_autoCount": "false"}).AutoCountEnabled())
		assert.True(t, PluginOptions{}.AutoCountEnabled())
	})

	t.Run("normalize は素通し、render は classic の JSON", func(t *testing.T) {
		payload := Dict{"session_id": "s", "tool_name": "Bash", "tool_input": Dict{"command": "ls"}}
		call, ok := ClaudeHost.Normalize("PreToolUse", payload, io)
		assert.True(t, ok)
		assert.Equal(t, CoreCall{Event: "PreToolUse", Payloads: []Dict{payload}}, call)

		ask := ClaudeHost.Render("PreToolUse", Outcome{Ask: StrPtr("sure?")}, "warn\n", io)
		var got Dict
		require.NoError(t, json.Unmarshal([]byte(ask.Stdout), &got))
		assert.Equal(t, Dict{"hookSpecificOutput": Dict{"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": "sure?"}}, got)
		assert.Equal(t, "warn\n", ask.Stderr)
		assert.Equal(t, "{\"decision\":\"block\",\"reason\":\"no\"}\n", ClaudeHost.Render("Stop", Outcome{Block: StrPtr("no")}, "", io).Stdout)
		assert.Equal(t, "", ClaudeHost.Render("PostToolUse", Outcome{}, "", io).Stdout)
	})
}
