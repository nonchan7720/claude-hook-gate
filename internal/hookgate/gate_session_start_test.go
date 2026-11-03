package hookgate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func ssIo(proj string) Io { return MakeIo(IoOpts{ProjectDir: proj, Lang: LangEN}) }

func ssStart(proj string, extra Dict) ScriptResult {
	p := Dict{"session_id": "s1", "source": "startup"}
	for k, v := range extra {
		if v == nil {
			delete(p, k)
		} else {
			p[k] = v
		}
	}
	return SessionStartGate(ssIo(proj), p)
}

func ssLogs(proj string) []string {
	dir := filepath.Join(proj, ".claude", ".gate-status", "logs", "s1")
	entries, _ := os.ReadDir(dir)
	var out []string
	for _, e := range entries {
		out = append(out, filepath.Join(dir, e.Name()))
	}
	return out
}

func ssLog(proj, prefix string) string {
	for _, l := range ssLogs(proj) {
		if strings.HasPrefix(filepath.Base(l), prefix) {
			return l
		}
	}
	return ""
}

func TestSessionStartGate(t *testing.T) {
	t.Run("labelled stdout in declaration order; empty stdout injects nothing", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{
			Dict{"name": "slow", "cmd": "sleep 0.3; echo first"}, Dict{"name": "quiet", "cmd": "true"}, "echo second", Dict{"name": "last", "cmd": `echo "  third  "`},
		}})
		r := ssStart(proj, nil)
		assert.Equal(t, 0, r.ExitCode)
		assert.Empty(t, r.Stderr)
		assert.Equal(t, "[gate] session_start: slow\nfirst\n\n[gate] session_start: echo_second\nsecond\n\n[gate] session_start: last\nthird\n", r.Stdout)
		assert.Len(t, ssLogs(proj), 4)
	})

	t.Run("no gate.yaml, no session_start, or empty list: nothing", func(t *testing.T) {
		proj := tmpProj(t)
		assert.Equal(t, "", ssStart(proj, nil).Stdout)
		WriteGateYaml(proj, Dict{"rules": []any{}})
		assert.Equal(t, "", ssStart(proj, nil).Stdout)
		WriteGateYaml(proj, Dict{"session_start": []any{}})
		assert.Equal(t, "", ssStart(proj, nil).Stdout)
	})

	t.Run("total output is capped with a truncation note", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{Dict{"name": "big", "cmd": "yes xxxxxxxxxx | head -n 3000"}}})
		r := ssStart(proj, nil)
		assert.Contains(t, r.Stdout, "output was truncated")
		assert.Less(t, len(r.Stdout), SessionStartMaxChars+200)
	})

	t.Run("a failing command is reported once on stderr, exit 0, and others still run", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{Dict{"name": "bad", "cmd": "echo oops; echo err >&2; exit 3"}, Dict{"name": "good", "cmd": "echo fine"}}})
		r := ssStart(proj, nil)
		assert.Equal(t, 0, r.ExitCode)
		assert.Equal(t, "[gate] session_start: good\nfine\n", r.Stdout)
		assert.Contains(t, r.Stderr, "session_start: bad failed (exit status 3)")
		assert.Equal(t, 1, strings.Count(r.Stderr, "bad failed"))
		log := ssLog(proj, "bad.")
		require.NotEmpty(t, log)
		assert.Contains(t, r.Stderr, log)
		b, _ := os.ReadFile(log)
		assert.Contains(t, string(b), "err")
	})

	t.Run("a timed-out command is a failure, not a block", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{Dict{"name": "hang", "cmd": "sleep 5", "timeout": 1}, Dict{"name": "ok", "cmd": "echo up"}}})
		r := ssStart(proj, nil)
		assert.Equal(t, 0, r.ExitCode)
		assert.Contains(t, r.Stdout, "up")
		assert.Contains(t, r.Stderr, "hang failed (timed out after 1s)")
	})

	t.Run("on: filters by source (string and list); unknown values never match", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{
			Dict{"name": "a", "cmd": "echo A:$CLAUDE_SESSION_SOURCE", "on": "startup"},
			Dict{"name": "b", "cmd": "echo B", "on": []any{"resume", "compact"}},
			Dict{"name": "c", "cmd": "echo C", "on": []any{"bogus"}},
			Dict{"name": "d", "cmd": "echo D"},
		}})
		assert.Equal(t, "[gate] session_start: a\nA:startup\n\n[gate] session_start: d\nD\n", ssStart(proj, Dict{"source": "startup"}).Stdout)
		assert.Equal(t, "[gate] session_start: b\nB\n\n[gate] session_start: d\nD\n", ssStart(proj, Dict{"source": "compact"}).Stdout)
		assert.Equal(t, "[gate] session_start: d\nD\n", ssStart(proj, Dict{"source": nil}).Stdout)
	})

	t.Run("skipped when the payload has agent_id", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{Dict{"name": "a", "cmd": "echo A"}}})
		assert.Equal(t, Ok("", ""), ssStart(proj, Dict{"agent_id": "sub1"}))
		assert.Empty(t, ssLogs(proj))
	})

	t.Run("environment: project dir, session id, source; agent id unset; files empty", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{Dict{"name": "env", "cmd": `echo "$CLAUDE_PROJECT_DIR|$CLAUDE_SESSION_ID|$CLAUDE_SESSION_SOURCE|${CLAUDE_AGENT_ID-unset}|[$CLAUDE_GATE_FILES]|$PWD"`}}})
		r := ssStart(proj, Dict{"source": "clear"})
		assert.Equal(t, "[gate] session_start: env\n"+proj+"|s1|clear|unset|[]|"+proj+"\n", r.Stdout)
	})

	t.Run("background: returns immediately, injects nothing, output reaches the log", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{
			Dict{"name": "bg", "cmd": `sleep 2; echo done > "$CLAUDE_PROJECT_DIR/bg.out"; echo hello`, "background": true},
			Dict{"name": "fg", "cmd": "echo now"},
		}})
		t0 := time.Now()
		r := ssStart(proj, nil)
		assert.Less(t, time.Since(t0), 1500*time.Millisecond)
		assert.Equal(t, "[gate] session_start: fg\nnow\n", r.Stdout)
		assert.Empty(t, r.Stderr)
		log := ssLog(proj, "bg.")
		require.NotEmpty(t, log)
		_, err := os.Stat(filepath.Join(proj, "bg.out"))
		assert.Error(t, err)
		assert.Eventually(t, func() bool { _, e := os.Stat(filepath.Join(proj, "bg.out")); return e == nil }, 6*time.Second, 100*time.Millisecond)
		assert.Eventually(t, func() bool { b, _ := os.ReadFile(log); return strings.Contains(string(b), "hello") }, 3*time.Second, 50*time.Millisecond)
	})

	t.Run("rules and checks phases still work when rules is absent", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{Dict{"cmd": "echo x"}}})
		requireExit0(t, rules(proj))
		requireExit0(t, checks(proj))
	})

	t.Run("SessionStart carries the output as additionalContext", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{Dict{"name": "ctx", "cmd": "echo hi"}}})
		r := SessionStart(ssIo(proj), "s1", Dict{"session_id": "s1", "source": "startup"})
		require.Len(t, r.Outcome.AdditionalContext, 1)
		assert.Contains(t, r.Outcome.AdditionalContext[0], "[gate] session_start: ctx\nhi")
	})
}
