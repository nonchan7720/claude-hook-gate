package hookgate

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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

	t.Run("truncation never splits a surrogate pair", func(t *testing.T) {
		proj := tmpProj(t)
		header := "[gate] session_start: big\n"
		pad := SessionStartMaxChars - len(header) - 1
		WriteGateYaml(proj, Dict{"session_start": []any{Dict{"name": "big", "cmd": fmt.Sprintf(`head -c %d /dev/zero | tr '\0' a; printf '\360\237\230\200 tail'`, pad)}}})
		r := ssStart(proj, nil)
		body, _, _ := strings.Cut(r.Stdout, "\n[gate] session_start output")
		assert.Contains(t, r.Stdout, "output was truncated")
		assert.LessOrEqual(t, gateJSLen(body), SessionStartMaxChars)
		assert.NotContains(t, body, "\ufffd")
		assert.True(t, utf8.ValidString(body))
		assert.True(t, strings.HasSuffix(body, "a"))
		assert.Equal(t, "ab", sessionStartCut("ab😀", 3))
		assert.Equal(t, "ab😀", sessionStartCut("ab😀", 4))
	})

	t.Run("hook JSON output: additionalContext is taken, systemMessage is surfaced, no usable context injects nothing; plain text stays", func(t *testing.T) {
		proj := tmpProj(t)
		js := func(o any) string { return "printf '%s' '" + JSONStringify(o) + "'" }
		WriteGateYaml(proj, Dict{"session_start": []any{
			Dict{"name": "j1", "cmd": js(Dict{"hookSpecificOutput": Dict{"hookEventName": "SessionStart", "additionalContext": "from json"}, "systemMessage": "hello user"})},
			Dict{"name": "j2", "cmd": js(Dict{"hookSpecificOutput": Dict{"additionalContext": ""}, "other": 1})},
			Dict{"name": "j3", "cmd": js(Dict{"foo": "bar"})},
			Dict{"name": "plain", "cmd": "echo [1,2]"},
		}})
		r := ssStart(proj, nil)
		assert.Equal(t, "[gate] session_start: j1\nfrom json\n\n[gate] session_start: plain\n[1,2]\n", r.Stdout)
		assert.Equal(t, "hello user", r.SystemMessage)
	})

	t.Run("a timeout above 600 is capped to 600", func(t *testing.T) {
		it, ok := parseSessionStartItem(Dict{"cmd": "x", "timeout": float64(9999)})
		require.True(t, ok)
		assert.InDelta(t, 600, it.timeout, 0)
		it, _ = parseSessionStartItem(Dict{"cmd": "x"})
		assert.InDelta(t, 10, it.timeout, 0)
	})

	t.Run("a failing command is reported once on stderr, exit 0, and others still run", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{Dict{"name": "bad", "cmd": "echo oops; echo err >&2; exit 3"}, Dict{"name": "good", "cmd": "echo fine"}}})
		r := ssStart(proj, nil)
		assert.Equal(t, 0, r.ExitCode)
		assert.Equal(t, "[gate] session_start: good\nfine\n", r.Stdout)
		assert.Contains(t, r.Stderr, "session_start: bad failed (exit status 3)")
		assert.Equal(t, strings.TrimRight(r.Stderr, "\n"), r.SystemMessage)
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

	t.Run("on: works unquoted, although YAML 1.1 reads the key on as true", func(t *testing.T) {
		proj := tmpProj(t)
		writeText(filepath.Join(proj, ".claude", "gate.yaml"), "session_start:\n  - name: a\n    cmd: echo A\n    on: [startup, clear]\n  - name: b\n    cmd: echo B\n    on: resume\n")
		assert.Equal(t, "[gate] session_start: a\nA\n", ssStart(proj, Dict{"source": "startup"}).Stdout)
		assert.Equal(t, "[gate] session_start: b\nB\n", ssStart(proj, Dict{"source": "resume"}).Stdout)
		assert.Equal(t, "", ssStart(proj, Dict{"source": "compact"}).Stdout)
		// 引用した "on" が空でも、引用しない on: の値を使う。
		writeText(filepath.Join(proj, ".claude", "gate.yaml"), "session_start:\n  - name: a\n    cmd: echo A\n    on: [resume]\n    \"on\":\n")
		assert.Equal(t, "", ssStart(proj, Dict{"source": "startup"}).Stdout)
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
		assert.Nil(t, r.Outcome.SystemMessage)
	})

	t.Run("SessionStart carries failure notes as Outcome.SystemMessage", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"session_start": []any{Dict{"name": "bad", "cmd": "exit 2"}, Dict{"name": "good", "cmd": "echo ok"}}})
		r := SessionStart(ssIo(proj), "s1", Dict{"session_id": "s1", "source": "startup"})
		require.NotNil(t, r.Outcome.SystemMessage)
		assert.Contains(t, *r.Outcome.SystemMessage, "session_start: bad failed (exit status 2)")
		assert.Contains(t, *r.Outcome.SystemMessage, filepath.Join(".gate-status", "logs", "s1", "bad."))
		assert.Nil(t, r.Outcome.Block)
		assert.Contains(t, r.Outcome.AdditionalContext[0], "good")
		assert.Contains(t, OutcomeToClassic("SessionStart", r.Outcome, "").Stdout, `"systemMessage":`)
	})
}
