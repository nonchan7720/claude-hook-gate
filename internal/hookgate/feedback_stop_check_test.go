package hookgate

// tests/feedback-stop-check.spec.ts の移植。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestFeedbackStopCheck(t *testing.T) {
	type env struct {
		feedbackDir, projectDir string
	}
	run := func(t *testing.T, body func(e env)) {
		t.Helper()
		WithTmp(func(feedbackDir string) {
			WithTmp(func(projectDir string) {
				content := strings.Join([]string{
					"---",
					"name: readme_bilingual",
					"description: test",
					"type: feedback",
					"count: 4",
					"enforce:",
					"  - event: stop_check",
					"    changed: '**/README.md'",
					"    require_sibling: 'README_ja.md'",
					"    message: '日英併記のこと'",
					"    severity: block",
					"---",
					"",
					"本文",
					"",
				}, "\n")
				fbtWrite(filepath.Join(feedbackDir, "readme_bilingual.md"), content)
				body(env{feedbackDir, projectDir})
			})
		})
	}
	runStopCheck := func(e env, payload Dict) ScriptResult {
		p := Dict{"session_id": "sess1"}
		for k, v := range payload {
			p[k] = v
		}
		return FeedbackStopCheck(MakeIo(IoOpts{ProjectDir: e.projectDir, Env: EnvVars{ClaudeFeedbackDir: e.feedbackDir}}), p)
	}
	stateDir := func(e env) string { return filepath.Join(e.projectDir, ".claude", ".gate-status") }
	touch := func(e env, name string) { fbtWrite(filepath.Join(e.projectDir, name), "") }
	writeMemo := func(e env, rels ...string) {
		var b strings.Builder
		for _, p := range rels {
			b.WriteString(p + "\n")
		}
		fbtWrite(filepath.Join(stateDir(e), "changed_files.sess1.txt"), b.String())
	}
	writeAgentMemo := func(e env, sessionID, agentID string, rels ...string) {
		var b strings.Builder
		for _, p := range rels {
			b.WriteString(p + "\n")
		}
		fbtWrite(filepath.Join(stateDir(e), "changed_files."+sessionID+"--"+agentID+".txt"), b.String())
	}

	t.Run("blocks when README_ja is missing", func(t *testing.T) {
		run(t, func(e env) {
			touch(e, "README.md")
			writeMemo(e, "README.md")
			r := runStopCheck(e, nil)
			assert.Equal(t, 2, r.ExitCode)
			assert.Contains(t, r.Stderr, "readme_bilingual")
		})
	})

	t.Run("passes when README_ja is present", func(t *testing.T) {
		run(t, func(e env) {
			touch(e, "README.md")
			touch(e, "README_ja.md")
			writeMemo(e, "README.md")
			assert.Equal(t, 0, runStopCheck(e, nil).ExitCode)
		})
	})

	t.Run("no changed files passes", func(t *testing.T) {
		run(t, func(e env) {
			assert.Equal(t, 0, runStopCheck(e, nil).ExitCode)
		})
	})

	t.Run("gives up after max attempts", func(t *testing.T) {
		run(t, func(e env) {
			touch(e, "README.md")
			writeMemo(e, "README.md")
			r := runStopCheck(e, nil)
			for i := 0; i < 2; i++ {
				r = runStopCheck(e, nil)
			}
			// 3回連続ブロック後は諦めて exit 0 になる
			assert.Equal(t, 0, r.ExitCode)
		})
	})

	t.Run("agent_id from payload is used for changed files and attempts", func(t *testing.T) {
		run(t, func(e env) {
			touch(e, "README.md")
			writeAgentMemo(e, "sess1", "agent1", "README.md")
			r := runStopCheck(e, Dict{"agent_id": "agent1"})
			assert.Equal(t, 2, r.ExitCode)
			assert.True(t, Exists(filepath.Join(stateDir(e), "feedback_gate_attempts.sess1--agent1.txt")))
			assert.False(t, Exists(filepath.Join(stateDir(e), "feedback_gate_attempts.sess1.txt")))
		})
	})

	t.Run("main stop picks up agent suffixed memo via merge", func(t *testing.T) {
		run(t, func(e env) {
			touch(e, "README.md")
			writeAgentMemo(e, "sess1", "agent1", "README.md")
			r := runStopCheck(e, nil)
			assert.Equal(t, 2, r.ExitCode)
			assert.True(t, Exists(filepath.Join(stateDir(e), "feedback_gate_attempts.sess1.txt")))
		})
	})

	t.Run("blocking emits block json with reason and attempt count", func(t *testing.T) {
		run(t, func(e env) {
			touch(e, "README.md")
			writeMemo(e, "README.md")
			r := runStopCheck(e, nil)
			assert.Equal(t, 2, r.ExitCode)
			payload := fbtParseJSON(t, r.Stdout)
			assert.Equal(t, "block", payload["decision"])
			assert.Contains(t, payload["reason"], "readme_bilingual")
			assert.Contains(t, payload["reason"], "試行")
		})
	})

	t.Run("stdout is exactly one json object", func(t *testing.T) {
		run(t, func(e env) {
			touch(e, "README.md")
			writeMemo(e, "README.md")
			r := runStopCheck(e, nil)
			assert.Equal(t, 2, r.ExitCode)
			assert.Len(t, strings.Split(strings.TrimSpace(r.Stdout), "\n"), 1)
			fbtParseJSON(t, r.Stdout)
		})
	})

	t.Run("success stdout has no block json", func(t *testing.T) {
		run(t, func(e env) {
			touch(e, "README.md")
			touch(e, "README_ja.md")
			writeMemo(e, "README.md")
			r := runStopCheck(e, nil)
			assert.Equal(t, 0, r.ExitCode)
			assert.Equal(t, "", strings.TrimSpace(r.Stdout))
		})
	})

	t.Run("max attempts giveup has no block json", func(t *testing.T) {
		run(t, func(e env) {
			touch(e, "README.md")
			writeMemo(e, "README.md")
			r := runStopCheck(e, nil)
			for i := 0; i < 2; i++ {
				r = runStopCheck(e, nil)
			}
			assert.Equal(t, 0, r.ExitCode)
			assert.Equal(t, "", strings.TrimSpace(r.Stdout))
		})
	})

	t.Run("warn only violation has no block json", func(t *testing.T) {
		run(t, func(e env) {
			content := strings.Join([]string{
				"---",
				"name: warn_rule",
				"description: test",
				"type: feedback",
				"count: 1",
				"enforce:",
				"  - event: stop_check",
				"    changed: '**/*.txt'",
				"    check: 'false'",
				"    message: 'warn only'",
				"    severity: warn",
				"---",
				"",
				"本文",
				"",
			}, "\n")
			fbtWrite(filepath.Join(e.feedbackDir, "warn_rule.md"), content)
			touch(e, "x.txt")
			writeMemo(e, "x.txt")
			r := runStopCheck(e, nil)
			assert.Equal(t, 0, r.ExitCode)
			assert.Equal(t, "", strings.TrimSpace(r.Stdout))
			assert.Contains(t, r.Stderr, "warn_rule")
		})
	})

	t.Run("never fails hard on a missing feedback directory or an empty payload", func(t *testing.T) {
		run(t, func(e env) {
			io := MakeIo(IoOpts{ProjectDir: e.projectDir, Env: EnvVars{ClaudeFeedbackDir: filepath.Join(os.TempDir(), "no-such-feedback-dir")}})
			r := FeedbackStopCheck(io, Dict{})
			assert.Equal(t, 0, r.ExitCode)
		})
	})
}
