package hookgate

// hooks.go（イベントごとの中核）と host.go（RunCore / CliMain）の直接のテスト。TS 版は tests/cli.spec.ts などの統合テストで確かめていた部分。

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGuardsTool(t *testing.T) {
	on := PluginOptions{AgentLaunchGuard: true}
	off := PluginOptions{AgentLaunchGuard: false}
	cases := []struct {
		tool       string
		off, on    bool
		descripton string
	}{
		{"Bash", true, true, "always"},
		{"Edit", true, true, "always"},
		{"Write", true, true, "always"},
		{"MultiEdit", true, true, "always"},
		{"Agent", false, true, "only with agentLaunchGuard"},
		{"SendMessage", false, true, "only with agentLaunchGuard"},
		{"Task", false, false, "never"},
		{"Read", false, false, "never"},
		{"NotebookEdit", false, false, "never"},
		{"apply_patch", false, false, "never (the Codex host rewrites it to Edit / Write)"},
		{"bash", false, false, "case-sensitive"},
		{"BashOutput", false, false, "exact match only"},
		{"", false, false, "never"},
	}
	for _, c := range cases {
		t.Run(c.tool+" ("+c.descripton+")", func(t *testing.T) {
			assert.Equal(t, c.off, GuardsTool(off, c.tool), "agentLaunchGuard off")
			assert.Equal(t, c.on, GuardsTool(on, c.tool), "agentLaunchGuard on")
		})
	}
}

func TestPluginOptionsAutoCount(t *testing.T) {
	t.Run("undefined means true", func(t *testing.T) {
		assert.True(t, PluginOptions{}.AutoCountEnabled())
		assert.True(t, PluginOptions{AutoCount: BoolPtr(true)}.AutoCountEnabled())
		assert.False(t, PluginOptions{AutoCount: BoolPtr(false)}.AutoCountEnabled())
	})
}

func hooksWrite(path, content string) Dict {
	return Dict{"session_id": "sess", "tool_name": "Write", "tool_input": Dict{"file_path": path, "content": content}, "tool_use_id": "t1"}
}

func TestPreToolUseEdits(t *testing.T) {
	askRule := "enforce:\n  - event: pre_edit\n    path: '**/*.py'\n    when: 'TODO'\n    message: 'TODO を書かない'\n    severity: ask\n"
	denyRule := "enforce:\n  - event: pre_edit\n    path: '**/*.py'\n    when: 'FIXME'\n    message: 'FIXME を書かない'\n    severity: deny\n"

	t.Run("no payloads, or tools that are not judged: nothing", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			assert.Equal(t, HookRun{}, PreToolUseEdits(e.io, "s", hostOptions, nil))
			r := PreToolUseEdits(e.io, "s", hostOptions, []Dict{{"tool_name": "Read"}, {"tool_name": "Grep"}})
			assert.Equal(t, HookRun{}, r)
		})
	})

	t.Run("only asks: joined with newlines as one ask", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			hostWriteRule(e.feedback, "no_todo", 4, askRule)
			r := PreToolUseEdits(e.io, "s1", hostOptions, []Dict{
				hooksWrite(filepath.Join(e.proj, "a.py"), "# TODO a"),
				hooksWrite(filepath.Join(e.proj, "b.py"), "# TODO b"),
			})
			assert.Nil(t, r.Outcome.Deny)
			require.NotNil(t, r.Outcome.Ask)
			assert.Equal(t, 2, strings.Count(*r.Outcome.Ask, "no_todo"), *r.Outcome.Ask)
			assert.Contains(t, *r.Outcome.Ask, "\n")
		})
	})

	t.Run("deny beats ask: the deny comes first, the asks are appended to it", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			hostWriteRule(e.feedback, "no_todo", 4, askRule)
			hostWriteRule(e.feedback, "no_fixme", 6, denyRule)
			r := PreToolUseEdits(e.io, "s2", hostOptions, []Dict{
				hooksWrite(filepath.Join(e.proj, "a.py"), "# TODO"),
				hooksWrite(filepath.Join(e.proj, "b.py"), "# FIXME"),
			})
			assert.Nil(t, r.Outcome.Ask)
			require.NotNil(t, r.Outcome.Deny)
			deny := *r.Outcome.Deny
			assert.Contains(t, deny, "no_fixme")
			assert.Contains(t, deny, "no_todo")
			assert.Less(t, strings.Index(deny, "no_fixme"), strings.Index(deny, "no_todo"))
		})
	})

	t.Run("stderr of every file is concatenated (the repeated ask of the same target becomes a warn)", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			hostWriteRule(e.feedback, "no_todo", 4, askRule)
			p := filepath.Join(e.proj, "a.py")
			r := PreToolUseEdits(e.io, "s3", hostOptions, []Dict{hooksWrite(p, "# TODO"), hooksWrite(p, "# TODO")})
			require.NotNil(t, r.Outcome.Ask)
			assert.Contains(t, r.Stderr, "no_todo")
			assert.Contains(t, r.Stderr, "[feedback-guard]")
			// 1 回目の ask は理由に、2 回目は warn（stderr）に。
			assert.Equal(t, 1, strings.Count(*r.Outcome.Ask, "no_todo"))
		})
	})
}

func TestPostToolUseEdits(t *testing.T) {
	postRule := "enforce:\n  - event: post_edit\n    path: '**/*.py'\n    when: 'TODO'\n    message: 'TODO を残さない'\n"

	t.Run("no payloads: nothing", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			assert.Equal(t, HookRun{}, PostToolUseEdits(e.io, "s", nil))
		})
	})

	t.Run("each file is recorded and checked, the gate rules run once", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			hostWriteRule(e.feedback, "no_todo", 4, postRule)
			WriteGateYaml(e.proj, Dict{"rules": []any{Dict{"match": "**/*.py", "run": []any{"echo ran >> ran.txt"}}}})
			a, b := filepath.Join(e.proj, "a.py"), filepath.Join(e.proj, "b.py")
			must(os.WriteFile(a, []byte("# TODO\n"), 0o644))
			must(os.WriteFile(b, []byte("x = 1\n"), 0o644))
			r := PostToolUseEdits(e.io, "sess-1", []Dict{
				{"session_id": "sess-1", "cwd": e.proj, "tool_name": "Edit", "tool_input": Dict{"file_path": a, "old_string": "", "new_string": "# TODO"}},
				{"session_id": "sess-1", "cwd": e.proj, "tool_name": "Edit", "tool_input": Dict{"file_path": b, "old_string": "", "new_string": "x = 1"}},
			})
			require.NotNil(t, r.Outcome.Block)
			assert.Contains(t, *r.Outcome.Block, "no_todo")
			assert.Equal(t, "ran\n", Read(filepath.Join(e.proj, "ran.txt")))
		})
	})
}

func TestPreAndPostToolUseSkipUnjudgedTools(t *testing.T) {
	t.Run("PreToolUse: a tool outside the target does nothing; PostToolUse: only Write / Edit / MultiEdit / Bash / Agent / Task do something", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			assert.Equal(t, HookRun{}, PreToolUse(e.io, "s", hostOptions, Dict{"tool_name": "Read"}))
			assert.Equal(t, HookRun{}, PostToolUse(e.io, "s", Dict{"tool_name": "Read"}))
			assert.Equal(t, HookRun{}, PostToolUse(e.io, "s", Dict{}))
		})
	})
}

func TestRunSteps(t *testing.T) {
	ok := func(stdout, stderr string) Step { return func(Io) ScriptResult { return Ok(stdout, stderr) } }

	t.Run("a panicking step is skipped, the others still run (the TS .catch(() => undefined))", func(t *testing.T) {
		io := MakeIo(IoOpts{ProjectDir: TmpDir()})
		r := RunSteps(io, "s", "UserPromptSubmit", []Step{
			ok("a", ""),
			func(Io) ScriptResult { panic("boom") },
			ok("b", "warn\n"),
		}, Outcome{})
		assert.Equal(t, []string{"a", "b"}, r.Outcome.AdditionalContext)
		assert.Equal(t, "warn\n", r.Stderr)
	})

	t.Run("exit 2 becomes block (deny for PreToolUse) and its stderr is not passed on; other non-zero exits are ignored", func(t *testing.T) {
		io := MakeIo(IoOpts{ProjectDir: TmpDir()})
		stop := RunSteps(io, "s", "Stop", []Step{
			func(Io) ScriptResult { return ScriptResult{ExitCode: 2, Stderr: "reason\n"} },
			func(Io) ScriptResult { return ScriptResult{ExitCode: 1, Stderr: "ignored\n"} },
		}, Outcome{})
		require.NotNil(t, stop.Outcome.Block)
		assert.Equal(t, "reason", *stop.Outcome.Block)
		assert.Equal(t, "", stop.Stderr)
		pre := RunSteps(io, "s", "PreToolUse", []Step{func(Io) ScriptResult { return ScriptResult{ExitCode: 2, Stderr: "no\n"} }}, Outcome{})
		require.NotNil(t, pre.Outcome.Deny)
		assert.Equal(t, "no", *pre.Outcome.Deny)
	})

	t.Run("the first outcome and the first decision win; contexts are concatenated", func(t *testing.T) {
		io := MakeIo(IoOpts{ProjectDir: TmpDir()})
		r := RunSteps(io, "s", "SessionStart", []Step{ok("x", ""), ok("y", "")}, Outcome{AdditionalContext: []string{"first"}})
		assert.Equal(t, []string{"first", "x", "y"}, r.Outcome.AdditionalContext)
	})

	t.Run("progress is shown only when the step outlasts the delay, and the status line is cleaned up afterwards", func(t *testing.T) {
		var log []string
		var fire func()
		stopped := 0
		var gotMs int64
		io := MakeIo(IoOpts{ProjectDir: TmpDir(), ProgressLog: &log, Every: func(ms int64, fn func()) func() {
			gotMs, fire = ms, fn
			return func() { stopped++ }
		}})
		RunSteps(io, "s", "Stop", []Step{func(i Io) ScriptResult {
			i.Progress("evaluating")
			return Ok("", "")
		}}, Outcome{})
		assert.Equal(t, int64(ProgressDelayMs), gotMs)
		assert.Equal(t, int64(3000), gotMs)
		assert.Empty(t, log, "finished before the delay: nothing is shown")
		assert.Equal(t, 1, stopped)

		log, stopped = nil, 0
		RunSteps(io, "s", "Stop", []Step{func(i Io) ScriptResult {
			i.Progress("evaluating")
			fire() // 3 秒経った
			i.Progress("still evaluating")
			return Ok("", "")
		}}, Outcome{})
		// 表示を始めた後は素通し、終わりに完了サマリ（無ければ消去）へ戻す。
		assert.Equal(t, []string{"evaluating", "still evaluating", ""}, log)
		assert.GreaterOrEqual(t, stopped, 1)
	})

	t.Run("a Progress that is cleared before the delay shows nothing", func(t *testing.T) {
		var log []string
		var fire func()
		io := MakeIo(IoOpts{ProjectDir: TmpDir(), ProgressLog: &log, Every: func(_ int64, fn func()) func() {
			fire = fn
			return func() {}
		}})
		RunSteps(io, "s", "Stop", []Step{func(i Io) ScriptResult {
			i.Progress("evaluating")
			i.Progress("")
			fire()
			return Ok("", "")
		}}, Outcome{})
		assert.Empty(t, log)
	})
}

func TestRunCore(t *testing.T) {
	t.Run("the zero CoreCall, an empty payload list and an unknown event do nothing", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			assert.Equal(t, HookRun{}, RunCore(e.io, CoreCall{}, "s", hostOptions))
			assert.Equal(t, HookRun{}, RunCore(e.io, CoreCall{Event: "Stop"}, "s", hostOptions))
			assert.Equal(t, HookRun{}, RunCore(e.io, CoreCall{Event: "Bogus", Payloads: []Dict{{}}}, "s", hostOptions))
		})
	})

	t.Run("UserPromptSubmit carries the bundled rules", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			r := RunCore(e.io, CoreCall{Event: "UserPromptSubmit", Payloads: []Dict{{}}}, "s", hostOptions)
			assert.NotEmpty(t, r.Outcome.AdditionalContext)
		})
	})
}

func TestCliMain(t *testing.T) {
	run := func(t *testing.T, host Host, args []string, stdin string) (int, string, string) {
		t.Helper()
		proj := TmpDir()
		home := TmpDir()
		t.Cleanup(func() { RmTree(proj); RmTree(home) })
		t.Setenv("HOME", home)
		t.Setenv("CLAUDE_PROJECT_DIR", proj)
		t.Setenv("CLAUDE_PLUGIN_ROOT", RepoRoot)
		t.Setenv("CLAUDE_FEEDBACK_DIR", filepath.Join(proj, "fb"))
		t.Setenv("DOGWOOD_BIN", MissingDogwoodBin)
		var out, errOut bytes.Buffer
		code := CliMain(host, args, strings.NewReader(stdin), &out, &errOut)
		return code, out.String(), errOut.String()
	}

	t.Run("an unknown or missing event is a usage error (exit 1)", func(t *testing.T) {
		code, out, errOut := run(t, ClaudeHost, []string{"Bogus"}, "{}")
		assert.Equal(t, 1, code)
		assert.Equal(t, "", out)
		assert.Equal(t, "usage: feedback-gate <claude|codex> <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Notification|Stop|SubagentStop>\n", errOut)
		code, _, errOut = run(t, CodexHost, nil, "{}")
		assert.Equal(t, 1, code)
		assert.Contains(t, errOut, "<SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|PermissionRequest|Stop|SubagentStop>")
		// Codex に Notification は無く、Claude Code に PermissionRequest は無い。
		code, _, _ = run(t, CodexHost, []string{"Notification"}, "{}")
		assert.Equal(t, 1, code)
		code, _, _ = run(t, ClaudeHost, []string{"PermissionRequest"}, "{}")
		assert.Equal(t, 1, code)
	})

	t.Run("broken or non-object JSON on stdin is treated as {} and exits 0", func(t *testing.T) {
		for _, stdin := range []string{"not json", "", "[1,2]", "null", `"str"`} {
			code, out, _ := run(t, ClaudeHost, []string{"SessionStart"}, stdin)
			assert.Equal(t, 0, code, stdin)
			assert.Equal(t, "", out, stdin)
		}
	})

	t.Run("UserPromptSubmit prints the bundled rules as additionalContext (Claude Code)", func(t *testing.T) {
		code, out, errOut := run(t, ClaudeHost, []string{"UserPromptSubmit"}, `{"session_id":"s"}`)
		assert.Equal(t, 0, code)
		assert.Equal(t, "", errOut)
		j := parseHookJSON(t, out)
		specific := j["hookSpecificOutput"].(Dict)
		assert.Equal(t, "UserPromptSubmit", specific["hookEventName"])
		assert.NotEmpty(t, specific["additionalContext"])
	})

	t.Run("PreToolUse with a tool outside the target prints nothing (Codex)", func(t *testing.T) {
		code, out, errOut := run(t, CodexHost, []string{"PreToolUse"}, `{"session_id":"s","tool_name":"Read"}`)
		assert.Equal(t, 0, code)
		assert.Equal(t, "", out)
		assert.Equal(t, "", errOut)
	})
}
