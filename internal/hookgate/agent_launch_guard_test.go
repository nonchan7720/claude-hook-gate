package hookgate

// tests/agent-launch-guard.spec.ts の移植。

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestAgentLaunchGuard(t *testing.T) {
	guard := func(payload Dict) ScriptResult { return AgentLaunchGuard(payload, LangJA) }
	decision := func(r ScriptResult) Dict {
		return fbtParseJSON(t, r.Stdout)["hookSpecificOutput"].(Dict)
	}

	t.Run("the reason is English when lang is en", func(t *testing.T) {
		d := decision(AgentLaunchGuard(Dict{"tool_name": "Agent", "tool_input": Dict{"subagent_type": "code-implementer", "prompt": "P"}}, LangEN))
		assert.Equal(t,
			"Prompt to send to code-implementer:\n\nP\n\n--- Check: what to do / background / current state of the code / what not to do / done criteria",
			d["permissionDecisionReason"])
		m := decision(AgentLaunchGuard(Dict{"tool_name": "SendMessage", "tool_input": Dict{"message": "M"}}, LangEN))
		assert.Contains(t, m["permissionDecisionReason"], "Message to send to unknown recipient:\n\nM")
	})

	t.Run("asks for code-implementer with the prompt in the reason", func(t *testing.T) {
		d := decision(guard(Dict{"tool_name": "Agent", "tool_input": Dict{"subagent_type": "code-implementer", "prompt": "P"}}))
		assert.Equal(t, "ask", d["permissionDecision"])
		assert.Equal(t,
			"code-implementer に送るプロンプト:\n\nP\n\n--- チェック: やること / 背景 / 既存コードの現状 / やらないこと / 完了条件",
			d["permissionDecisionReason"])
	})

	t.Run("other agent types pass through", func(t *testing.T) {
		assert.Equal(t, "", guard(Dict{"tool_name": "Agent", "tool_input": Dict{"subagent_type": "general-purpose", "prompt": "P"}}).Stdout)
		assert.Equal(t, "", guard(Dict{"tool_name": "Agent", "tool_input": Dict{}}).Stdout)
	})

	t.Run("SendMessage asks for everyone except git-operator", func(t *testing.T) {
		assert.Contains(t, decision(guard(Dict{"tool_name": "SendMessage", "tool_input": Dict{"to": "x", "message": "M"}}))["permissionDecisionReason"], "x に送るメッセージ:\n\nM")
		assert.Contains(t, decision(guard(Dict{"tool_name": "SendMessage", "tool_input": Dict{"message": "M"}}))["permissionDecisionReason"], "宛先不明 に送るメッセージ")
		assert.Equal(t, "", guard(Dict{"tool_name": "SendMessage", "tool_input": Dict{"to": "git-operator", "message": "M"}}).Stdout)
	})

	t.Run("other tools pass through", func(t *testing.T) {
		assert.Equal(t, "", guard(Dict{"tool_name": "Bash", "tool_input": Dict{}}).Stdout)
	})
}
