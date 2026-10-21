package hookgate

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func ran(exitCode int, rest ...string) ScriptResult {
	r := ScriptResult{ExitCode: exitCode}
	if len(rest) > 0 {
		r.Stdout = rest[0]
	}
	if len(rest) > 1 {
		r.Stderr = rest[1]
	}
	return r
}

func TestToOutcome(t *testing.T) {
	s := StrPtr

	t.Run("exit 2 blocks (deny for PreToolUse) with stderr as the reason", func(t *testing.T) {
		assert.Equal(t, Outcome{Block: s("no")}, ToOutcome("Stop", ran(2, "", " no \n")))
		assert.Equal(t, Outcome{Deny: s("forbidden")}, ToOutcome("PreToolUse", ran(2, "", "forbidden")))
		assert.Equal(t, Outcome{Block: s("hook exited with code 2")}, ToOutcome("Stop", ran(2)))
	})

	t.Run("other non-zero exit codes are ignored", func(t *testing.T) {
		assert.Equal(t, Outcome{}, ToOutcome("Stop", ran(1, `{"decision":"block","reason":"x"}`, "boom")))
	})

	t.Run("JSON stdout is interpreted", func(t *testing.T) {
		assert.Equal(t, Outcome{PreventContinuation: true, StopReason: s("s"), Block: s("r")},
			ToOutcome("Stop", ran(0, `{"continue":false,"stopReason":"s","decision":"block","reason":"r"}`)))
		ask := `{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"c"}}`
		assert.Equal(t, Outcome{Ask: s("c")}, ToOutcome("PreToolUse", ran(0, ask)))
		assert.Equal(t, Outcome{}, ToOutcome("Stop", ran(0, ask)))
	})

	t.Run("a deny with an empty reason is still a deny", func(t *testing.T) {
		o := ToOutcome("PreToolUse", ran(0, `{"hookSpecificOutput":{"permissionDecision":"deny"}}`))
		require.NotNil(t, o.Deny)
		assert.Equal(t, "", *o.Deny)
		assert.True(t, Decided(o))
	})

	t.Run("plain text becomes context only for UserPromptSubmit / SessionStart", func(t *testing.T) {
		assert.Equal(t, Outcome{AdditionalContext: []string{"reset done"}}, ToOutcome("SessionStart", ran(0, "reset done\n")))
		assert.Equal(t, Outcome{}, ToOutcome("Stop", ran(0, "text")))
	})
}

func TestMerge(t *testing.T) {
	t.Run("the first decision wins and contexts are concatenated", func(t *testing.T) {
		assert.Equal(t,
			Outcome{Block: StrPtr("first"), AdditionalContext: []string{"a", "b"}},
			Merge(Outcome{Block: StrPtr("first"), AdditionalContext: []string{"a"}}, Outcome{Block: StrPtr("second"), AdditionalContext: []string{"b"}}))
		assert.Equal(t, Outcome{}, Merge(Outcome{}, Outcome{}))
	})
}

func TestOutcomeToClassic(t *testing.T) {
	s := StrPtr
	jsonOf := func(t *testing.T, event string, o Outcome) map[string]any {
		t.Helper()
		var m map[string]any
		require.NoError(t, json.Unmarshal([]byte(OutcomeToClassic(event, o, "").Stdout), &m))
		return m
	}
	specificOf := func(m map[string]any) map[string]any { return m["hookSpecificOutput"].(map[string]any) }

	t.Run("PreToolUse: deny / ask become permissionDecision, deny first, allow is never returned", func(t *testing.T) {
		assert.Equal(t, map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "no"}},
			jsonOf(t, "PreToolUse", Outcome{Deny: s("no")}))
		assert.Equal(t, "ask", specificOf(jsonOf(t, "PreToolUse", Outcome{Ask: s("sure?")}))["permissionDecision"])
		assert.Equal(t, "deny", specificOf(jsonOf(t, "PreToolUse", Outcome{Ask: s("a"), Deny: s("d")}))["permissionDecision"])
		assert.Equal(t, "", OutcomeToClassic("PreToolUse", Outcome{Allow: true}, "").Stdout)
	})

	t.Run("PostToolUse: block becomes decision block, context goes to hookSpecificOutput", func(t *testing.T) {
		assert.Equal(t, map[string]any{
			"decision": "block", "reason": "fix",
			"hookSpecificOutput": map[string]any{"hookEventName": "PostToolUse", "additionalContext": "a\n\nb"},
		}, jsonOf(t, "PostToolUse", Outcome{Block: s("fix"), AdditionalContext: []string{"a", "b"}}))
	})

	t.Run("keys keep the order of the TS object", func(t *testing.T) {
		out := OutcomeToClassic("PostToolUse", Outcome{Block: s("fix"), AdditionalContext: []string{"a"}, PreventContinuation: true, StopReason: s("s")}, "").Stdout
		assert.Equal(t, `{"decision":"block","reason":"fix","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"a"},"continue":false,"stopReason":"s"}`+"\n", out)
	})

	t.Run("UserPromptSubmit / SessionStart: additionalContext, and decision block for a block", func(t *testing.T) {
		assert.Equal(t, map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": "UserPromptSubmit", "additionalContext": "x"}},
			jsonOf(t, "UserPromptSubmit", Outcome{AdditionalContext: []string{"x"}}))
		assert.Equal(t, "block", jsonOf(t, "UserPromptSubmit", Outcome{Block: s("no")})["decision"])
		assert.Equal(t, "SessionStart", specificOf(jsonOf(t, "SessionStart", Outcome{AdditionalContext: []string{"x"}}))["hookEventName"])
	})

	t.Run("Stop / SubagentStop: decision block and reason only; continue false keeps its stopReason", func(t *testing.T) {
		assert.Equal(t, map[string]any{"decision": "block", "reason": "r"}, jsonOf(t, "Stop", Outcome{Block: s("r"), AdditionalContext: []string{"ignored"}}))
		assert.Equal(t, map[string]any{"continue": false, "stopReason": "s"}, jsonOf(t, "SubagentStop", Outcome{PreventContinuation: true, StopReason: s("s")}))
	})

	t.Run("nothing to say prints nothing; stderr is passed through", func(t *testing.T) {
		assert.Equal(t, ScriptResult{ExitCode: 0}, OutcomeToClassic("Stop", Outcome{}, ""))
		assert.Equal(t, "warn\n", OutcomeToClassic("Stop", Outcome{}, "warn\n").Stderr)
	})

	t.Run("the Outcome survives a round trip through ToOutcome", func(t *testing.T) {
		for _, c := range []struct {
			event string
			o     Outcome
		}{
			{"PreToolUse", Outcome{Deny: s("d")}},
			{"PreToolUse", Outcome{Ask: s("a")}},
			{"PostToolUse", Outcome{Block: s("b"), AdditionalContext: []string{"c"}}},
			{"UserPromptSubmit", Outcome{AdditionalContext: []string{"c"}}},
			{"Stop", Outcome{Block: s("b")}},
			{"SubagentStop", Outcome{Block: s("b"), PreventContinuation: true, StopReason: s("s")}},
		} {
			assert.Equal(t, c.o, ToOutcome(c.event, OutcomeToClassic(c.event, c.o, "")), c.event)
		}
	})
}
