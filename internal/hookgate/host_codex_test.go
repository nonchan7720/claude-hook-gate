package hookgate

// tests/host-codex.spec.ts の移植。Codex 向けの Host（host_codex.go）: Claude Code との違い（apply_patch、PermissionRequest、
// ask が無いこと、warn の渡し方）を CodexNormalize / CodexRender で吸収し、中核（hooks.go）は共有する。中核の呼び出しは RunCore。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type codexEnv struct {
	proj     string
	feedback string
	io       Io
}

func withCodexEnv(t *testing.T, body func(env codexEnv)) {
	t.Helper()
	proj := TmpDir()
	feedback := TmpDir()
	defer RmTree(proj)
	defer RmTree(feedback)
	io := MakeIo(IoOpts{ProjectDir: proj, Env: EnvVars{ClaudeFeedbackDir: feedback, Path: "/nonexistent"}, AutoCount: BoolPtr(false)})
	body(codexEnv{proj: proj, feedback: feedback, io: io})
}

func hostWriteRule(dir, name string, count int, enforce string) {
	text := "---\nname: " + name + "\ndescription: desc " + name + "\ntype: feedback\ncount: " + strconv.Itoa(count) + "\n" + enforce + "---\n\n" + name + " の本文。\n"
	must(os.WriteFile(filepath.Join(dir, name+".md"), []byte(text), 0o644))
}

const (
	hostNoTodoPre  = "enforce:\n  - event: pre_edit\n    path: '**/*.py'\n    when: 'TODO'\n    message: 'TODO を書かない'\n    severity: ask\n"
	hostNoTodoPost = "enforce:\n  - event: post_edit\n    path: '**/*.py'\n    when: 'TODO'\n    message: 'TODO を残さない'\n"
	hostNoRm       = "enforce:\n  - event: pre_bash\n    when: 'rm -rf'\n    message: forbidden\n    severity: deny\n"
)

func hostPatch(proj string, body []string, session ...string) Dict {
	sess := "sess-1"
	if len(session) > 0 {
		sess = session[0]
	}
	lines := append(append([]string{"*** Begin Patch"}, body...), "*** End Patch")
	return Dict{
		"session_id":      sess,
		"cwd":             proj,
		"hook_event_name": "PreToolUse",
		"tool_name":       "apply_patch",
		"tool_input":      Dict{"command": strings.Join(lines, "\n")},
		"tool_use_id":     "t1",
	}
}

var hostOptions = PluginOptions{AgentLaunchGuard: false, AutoCount: BoolPtr(false)}

// runCodexHook は Codex の stdin の payload を CodexNormalize して中核に渡す（RunHostHook の Io 作成と Render を除いた部分）。
func runCodexHook(io Io, event, sessionID string, opts PluginOptions, payload Dict) HookRun {
	call, _ := CodexNormalize(event, payload, io)
	return RunCore(io, call, sessionID, opts)
}

func outcomeToCodex(io Io, event string, outcome Outcome, stderr ...string) ScriptResult {
	s := ""
	if len(stderr) > 0 {
		s = stderr[0]
	}
	return CodexRender(event, outcome, s, io)
}

func parseHookJSON(t *testing.T, stdout string) Dict {
	t.Helper()
	var d Dict
	require.NoError(t, json.Unmarshal([]byte(stdout), &d))
	return d
}

func TestCodexHostNormalize(t *testing.T) {
	io := MakeIo(IoOpts{ProjectDir: "/proj"})

	t.Run("ホストの名前とイベント", func(t *testing.T) {
		assert.Equal(t, "Codex", CodexHost.AppName())
		assert.Equal(t, []string{".agents", ".claude"}, CodexHost.ConfigDirNames())
		assert.Equal(t, []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SubagentStop"}, CodexHost.Events())
		assert.Equal(t, PluginOptions{Language: "", AgentLaunchGuard: true, AutoCount: BoolPtr(false), RulesFile: "/r.md"},
			CodexHost.Options(map[string]string{"FEEDBACK_GATE_AGENT_LAUNCH_GUARD": "true", "FEEDBACK_GATE_AUTO_COUNT": "false", "FEEDBACK_GATE_RULES_FILE": "/r.md"}))
		o := CodexHost.Options(map[string]string{"CLAUDE_PLUGIN_OPTION_agentLaunchGuard": "true", "CLAUDE_PLUGIN_OPTION_language": "en"})
		assert.Equal(t, "en", o.Language)
		assert.True(t, o.AgentLaunchGuard)
		assert.True(t, o.AutoCountEnabled())
	})

	t.Run("FEEDBACK_GATE_<KEY> wins over CLAUDE_PLUGIN_OPTION_<key>, even when empty", func(t *testing.T) {
		o := CodexHost.Options(map[string]string{
			"FEEDBACK_GATE_AGENT_LAUNCH_GUARD":      "false",
			"CLAUDE_PLUGIN_OPTION_agentLaunchGuard": "true",
			"FEEDBACK_GATE_RULES_FILE":              "",
			"CLAUDE_PLUGIN_OPTION_rulesFile":        "/c.md",
		})
		assert.False(t, o.AgentLaunchGuard)
		assert.Equal(t, "", o.RulesFile)
	})

	t.Run("apply_patch はファイルごとの Edit / Write に、PermissionRequest は Notification に、未知のイベントは undefined", func(t *testing.T) {
		pre, ok := CodexNormalize("PreToolUse", Dict{
			"cwd": "/proj", "tool_name": "apply_patch",
			"tool_input": Dict{"command": "*** Begin Patch\n*** Add File: a.py\n+x\n*** Update File: b.py\n+y\n*** End Patch"},
		}, io)
		require.True(t, ok)
		assert.Equal(t, "PreToolUse", pre.Event)
		type nameFile struct{ tool, file string }
		got := []nameFile{}
		for _, p := range pre.Payloads {
			got = append(got, nameFile{p["tool_name"].(string), p["tool_input"].(Dict)["file_path"].(string)})
		}
		assert.Equal(t, []nameFile{{"Write", "/proj/a.py"}, {"Edit", "/proj/b.py"}}, got)

		perm, ok := CodexNormalize("PermissionRequest", Dict{"tool_name": "Bash", "tool_input": Dict{"command": "rm x"}}, io)
		require.True(t, ok)
		assert.Equal(t, "Notification", perm.Event)
		assert.Equal(t, "rm x", perm.Payloads[0]["message"])

		stop, ok := CodexNormalize("Stop", Dict{"stop_hook_active": false}, io)
		require.True(t, ok)
		assert.Equal(t, CoreCall{Event: "Stop", Payloads: []Dict{{"stop_hook_active": false}}}, stop)

		none, ok := CodexNormalize("SessionEnd", Dict{}, io)
		assert.False(t, ok)
		assert.Equal(t, CoreCall{}, none)
	})

	t.Run("PermissionRequest: description beats command; with neither, the payload is passed as is", func(t *testing.T) {
		perm, _ := CodexNormalize("PermissionRequest", Dict{"tool_input": Dict{"description": "d", "command": "c"}}, io)
		assert.Equal(t, "d", perm.Payloads[0]["message"])
		bare := Dict{"tool_name": "Bash"}
		perm, _ = CodexNormalize("PermissionRequest", bare, io)
		assert.Equal(t, bare, perm.Payloads[0])
	})

	t.Run("spawn_agent / send_input are renamed and their fields read as Agent / SendMessage ones", func(t *testing.T) {
		spawn, _ := CodexNormalize("PreToolUse", Dict{"tool_name": "spawn_agent", "tool_input": Dict{"agent_type": "worker", "message": "do it"}}, io)
		require.Len(t, spawn.Payloads, 1)
		assert.Equal(t, "Agent", spawn.Payloads[0]["tool_name"])
		assert.Equal(t, Dict{"agent_type": "worker", "message": "do it", "subagent_type": "worker", "prompt": "do it"}, spawn.Payloads[0]["tool_input"])
		// 既にある subagent_type / prompt は上書きしない。
		keep, _ := CodexNormalize("PreToolUse", Dict{"tool_name": "spawn_agent", "tool_input": Dict{"agent_type": "a", "subagent_type": "b", "message": "m", "prompt": "p"}}, io)
		assert.Equal(t, "b", keep.Payloads[0]["tool_input"].(Dict)["subagent_type"])
		assert.Equal(t, "p", keep.Payloads[0]["tool_input"].(Dict)["prompt"])
		send, _ := CodexNormalize("PreToolUse", Dict{"tool_name": "send_input", "tool_input": Dict{"agent_id": "ag9", "message": "hi"}}, io)
		assert.Equal(t, "SendMessage", send.Payloads[0]["tool_name"])
		assert.Equal(t, "ag9", send.Payloads[0]["tool_input"].(Dict)["to"])
	})

	t.Run("PostToolUse spawn_agent: the response (an object or a JSON string) gets agentId", func(t *testing.T) {
		fromString, _ := CodexNormalize("PostToolUse", Dict{"tool_name": "spawn_agent", "tool_response": `{"agent_id":"ag1"}`}, io)
		assert.Equal(t, "Agent", fromString.Payloads[0]["tool_name"])
		assert.Equal(t, Dict{"agent_id": "ag1", "agentId": "ag1"}, fromString.Payloads[0]["tool_response"])
		fromObject, _ := CodexNormalize("PostToolUse", Dict{"tool_name": "spawn_agent", "tool_response": Dict{"agentId": "ag2"}}, io)
		assert.Equal(t, Dict{"agentId": "ag2"}, fromObject.Payloads[0]["tool_response"])
		// 解釈できない / agent id が無い応答はそのまま。
		broken, _ := CodexNormalize("PostToolUse", Dict{"tool_name": "spawn_agent", "tool_response": "not json"}, io)
		assert.Equal(t, "not json", broken.Payloads[0]["tool_response"])
		noID, _ := CodexNormalize("PostToolUse", Dict{"tool_name": "spawn_agent", "tool_response": Dict{"x": 1.0}}, io)
		assert.Equal(t, Dict{"x": 1.0}, noID.Payloads[0]["tool_response"])
	})
}

func TestClaudeToolName(t *testing.T) {
	t.Run("spawn_agent → Agent、send_input → SendMessage、それ以外はそのまま", func(t *testing.T) {
		assert.Equal(t, "Agent", ClaudeToolName("spawn_agent"))
		assert.Equal(t, "SendMessage", ClaudeToolName("send_input"))
		assert.Equal(t, "Bash", ClaudeToolName("Bash"))
		assert.Equal(t, "apply_patch", ClaudeToolName("apply_patch"))
	})
}

func TestRunCodexHookPreToolUse(t *testing.T) {
	t.Run("Bash はそのまま pre_bash で判定する", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			hostWriteRule(e.feedback, "no_rm", 6, hostNoRm)
			r := runCodexHook(e.io, "PreToolUse", "sess-1", hostOptions, Dict{"tool_name": "Bash", "tool_input": Dict{"command": "rm -rf x"}, "tool_use_id": "t1"})
			require.NotNil(t, r.Outcome.Deny)
			assert.Contains(t, *r.Outcome.Deny, "no_rm (count: 6): forbidden")
		})
	})

	t.Run("apply_patch はファイルごとに pre_edit で判定し、deny が ask に勝つ", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			hostWriteRule(e.feedback, "no_todo", 4, hostNoTodoPre)
			hostWriteRule(e.feedback, "no_fixme", 6, strings.Replace(strings.Replace(hostNoTodoPre, "'TODO'", "'FIXME'", 1), "severity: ask", "severity: deny", 1))
			ask := runCodexHook(e.io, "PreToolUse", "sess-1", hostOptions, hostPatch(e.proj, []string{"*** Add File: a.py", "+# TODO"}))
			require.NotNil(t, ask.Outcome.Ask)
			assert.Contains(t, *ask.Outcome.Ask, "no_todo")
			assert.Nil(t, ask.Outcome.Deny)
			both := runCodexHook(e.io, "PreToolUse", "sess-2", hostOptions,
				hostPatch(e.proj, []string{"*** Add File: a.py", "+# TODO", "*** Update File: b.py", "+# FIXME"}, "sess-2"))
			require.NotNil(t, both.Outcome.Deny)
			assert.Contains(t, *both.Outcome.Deny, "no_fixme")
			assert.Contains(t, *both.Outcome.Deny, "no_todo")
			assert.Nil(t, both.Outcome.Ask)
			clean := runCodexHook(e.io, "PreToolUse", "sess-1", hostOptions, hostPatch(e.proj, []string{"*** Add File: a.py", "+x = 1", "*** Delete File: z.py"}))
			assert.Equal(t, Outcome{}, clean.Outcome)
		})
	})

	t.Run("spawn_agent は Agent として agentLaunchGuard の対象になる（agent_type / message を読み替える）", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			newPayload := func() Dict {
				return Dict{"tool_name": "spawn_agent", "tool_input": Dict{"agent_type": "code-implementer", "message": "do it"}, "tool_use_id": "t2"}
			}
			assert.Equal(t, Outcome{}, runCodexHook(e.io, "PreToolUse", "sess-1", hostOptions, newPayload()).Outcome)
			guard := hostOptions
			guard.AgentLaunchGuard = true
			r := runCodexHook(e.io, "PreToolUse", "sess-1", guard, newPayload())
			require.NotNil(t, r.Outcome.Ask)
			assert.Contains(t, *r.Outcome.Ask, "code-implementer に送るプロンプト:\n\ndo it")
		})
	})
}

func TestRunCodexHookPostToolUse(t *testing.T) {
	t.Run("apply_patch は各ファイルを記録して post_edit で検査し、gate の rules を 1 回走らせる", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			hostWriteRule(e.feedback, "no_todo", 4, hostNoTodoPost)
			WriteGateYaml(e.proj, Dict{"rules": []any{Dict{"match": "**/*.py", "run": []any{"echo ran >> ran.txt"}}}})
			must(os.WriteFile(filepath.Join(e.proj, "a.py"), []byte("# TODO\n"), 0o644))
			must(os.WriteFile(filepath.Join(e.proj, "b.py"), []byte("x = 1\n"), 0o644))
			payload := hostPatch(e.proj, []string{"*** Update File: a.py", "+# TODO", "*** Update File: b.py", "+x = 1"})
			payload["hook_event_name"] = "PostToolUse"
			payload["tool_response"] = Dict{}
			r := runCodexHook(e.io, "PostToolUse", "sess-1", hostOptions, payload)
			require.NotNil(t, r.Outcome.Block)
			assert.Contains(t, *r.Outcome.Block, "no_todo")
			// 記録した変更ファイルは rules フェーズが消費するので、gate のコマンドが 1 回だけ走ったことで確かめる。
			assert.Equal(t, "ran\n", Read(filepath.Join(e.proj, "ran.txt")))
		})
	})

	t.Run("パッチでない apply_patch は何もしない", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			r := runCodexHook(e.io, "PostToolUse", "sess-1", hostOptions, Dict{"tool_name": "apply_patch", "tool_input": Dict{"command": "nope"}, "tool_response": Dict{}})
			assert.Equal(t, Outcome{}, r.Outcome)
		})
	})

	t.Run("spawn_agent の結果（文字列 JSON の agent_id）からサブエージェントの報告を引く", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			report := filepath.Join(e.proj, ".claude", ".gate-status", "subagent_report.sess-1--ag1.json")
			must(os.MkdirAll(filepath.Dir(report), 0o755))
			must(os.WriteFile(report, []byte(JSONStringify(Dict{"agentType": "worker", "gate": "[gate] NG"})), 0o644))
			r := runCodexHook(e.io, "PostToolUse", "sess-1", hostOptions, Dict{
				"session_id":    "sess-1",
				"tool_name":     "spawn_agent",
				"tool_input":    Dict{"message": "p"},
				"tool_response": JSONStringify(Dict{"agent_id": "ag1"}),
				"tool_use_id":   "t9",
			})
			ctx := strings.Join(r.Outcome.AdditionalContext, "")
			assert.Contains(t, ctx, "worker (ag1)")
			assert.Contains(t, ctx, "[gate] NG")
			assert.False(t, Exists(report))
		})
	})
}

func TestRunCodexHookPermissionRequestAndSessionStart(t *testing.T) {
	t.Run("PermissionRequest は何も返さない（通知だけ）", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			r := runCodexHook(e.io, "PermissionRequest", "sess-1", hostOptions, Dict{"tool_name": "Bash", "tool_input": Dict{"command": "ls"}})
			assert.Equal(t, HookRun{}, r)
		})
	})

	t.Run("SessionStart startup は自セッションの状態を消す", func(t *testing.T) {
		withCodexEnv(t, func(e codexEnv) {
			WriteGateYaml(e.proj, Dict{"rules": []any{}})
			changed := filepath.Join(e.proj, ".claude", ".gate-status", "changed_files.sess-1.txt")
			must(os.MkdirAll(filepath.Dir(changed), 0o755))
			must(os.WriteFile(changed, []byte("a.py\n"), 0o644))
			runCodexHook(e.io, "SessionStart", "sess-1", hostOptions, Dict{"session_id": "sess-1", "source": "startup"})
			assert.False(t, Exists(changed))
		})
	})
}

func TestOutcomeToCodex(t *testing.T) {
	io := MakeIo(IoOpts{ProjectDir: "/proj"})

	t.Run("PreToolUse: deny はそのまま、ask は deny に落として理由に添える", func(t *testing.T) {
		deny := parseHookJSON(t, outcomeToCodex(io, "PreToolUse", Outcome{Deny: StrPtr("no")}).Stdout)
		assert.Equal(t, Dict{"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "no"}, deny["hookSpecificOutput"])
		ask := parseHookJSON(t, outcomeToCodex(io, "PreToolUse", Outcome{Ask: StrPtr("sure?")}).Stdout)
		specific := ask["hookSpecificOutput"].(Dict)
		assert.Equal(t, "deny", specific["permissionDecision"])
		assert.Contains(t, specific["permissionDecisionReason"], "sure?\n[feedback-gate] Codex の PreToolUse には ask が無い")
		// ask を含む出力に ask という判定は出さない（Codex では hook の失敗になる）。
		assert.NotContains(t, outcomeToCodex(io, "PreToolUse", Outcome{Ask: StrPtr("sure?")}).Stdout, `"ask"`)
	})

	t.Run("PreToolUse: 判定が無く warn だけなら additionalContext、何も無ければ空", func(t *testing.T) {
		r := outcomeToCodex(io, "PreToolUse", Outcome{}, "[feedback-guard] warn: x\n")
		assert.Equal(t, Dict{"hookEventName": "PreToolUse", "additionalContext": "[feedback-guard] warn: x"}, parseHookJSON(t, r.Stdout)["hookSpecificOutput"])
		assert.Equal(t, "[feedback-guard] warn: x\n", r.Stderr)
		assert.Equal(t, "", outcomeToCodex(io, "PreToolUse", Outcome{}).Stdout)
	})

	t.Run("PostToolUse: block は decision、warn と additionalContext は additionalContext にまとめる", func(t *testing.T) {
		block := parseHookJSON(t, outcomeToCodex(io, "PostToolUse", Outcome{Block: StrPtr("fix it")}, "warn\n").Stdout)
		assert.Equal(t, "block", block["decision"])
		assert.Equal(t, "fix it", block["reason"])
		assert.NotContains(t, block, "hookSpecificOutput")
		ctx := parseHookJSON(t, outcomeToCodex(io, "PostToolUse", Outcome{AdditionalContext: []string{"report"}}, "warn\n").Stdout)
		assert.NotContains(t, ctx, "decision")
		assert.Equal(t, Dict{"hookEventName": "PostToolUse", "additionalContext": "report\n\nwarn"}, ctx["hookSpecificOutput"])
	})

	t.Run("Stop / SubagentStop: block は decision、warn は systemMessage、continue: false は残す", func(t *testing.T) {
		block := parseHookJSON(t, outcomeToCodex(io, "Stop", Outcome{Block: StrPtr("not yet")}, "warn\n").Stdout)
		assert.Equal(t, Dict{"decision": "block", "reason": "not yet"}, block)
		warn := parseHookJSON(t, outcomeToCodex(io, "SubagentStop", Outcome{}, "warn\n").Stdout)
		assert.Equal(t, Dict{"systemMessage": "warn"}, warn)
		stop := parseHookJSON(t, outcomeToCodex(io, "Stop", Outcome{PreventContinuation: true, StopReason: StrPtr("bye")}).Stdout)
		assert.Equal(t, Dict{"continue": false, "stopReason": "bye"}, stop)
		assert.Equal(t, "", outcomeToCodex(io, "Stop", Outcome{AdditionalContext: []string{"x"}}).Stdout)
	})

	t.Run("UserPromptSubmit / SessionStart: additionalContext をつなぐ。PermissionRequest は常に空", func(t *testing.T) {
		r := parseHookJSON(t, outcomeToCodex(io, "UserPromptSubmit", Outcome{AdditionalContext: []string{"a", "", "b"}}).Stdout)
		assert.Equal(t, Dict{"hookEventName": "UserPromptSubmit", "additionalContext": "a\n\nb"}, r["hookSpecificOutput"])
		assert.Equal(t, "", outcomeToCodex(io, "SessionStart", Outcome{}).Stdout)
		assert.Equal(t, "", outcomeToCodex(io, "PermissionRequest", Outcome{Deny: StrPtr("x"), AdditionalContext: []string{"y"}}, "z").Stdout)
	})

	t.Run("the JSON keys follow the construction order of the TS object", func(t *testing.T) {
		assert.Equal(t, "{\"decision\":\"block\",\"reason\":\"r\",\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"c\"}}\n",
			outcomeToCodex(io, "PostToolUse", Outcome{Block: StrPtr("r"), AdditionalContext: []string{"c"}}).Stdout)
		assert.Equal(t, "{\"decision\":\"block\",\"reason\":\"r\",\"continue\":false,\"stopReason\":\"s\"}\n",
			outcomeToCodex(io, "Stop", Outcome{Block: StrPtr("r"), PreventContinuation: true, StopReason: StrPtr("s")}).Stdout)
		assert.Equal(t, "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"d\"}}\n",
			outcomeToCodex(io, "PreToolUse", Outcome{Deny: StrPtr("d")}).Stdout)
	})
}

// CodexHookSourceAllows（host_codex.go）: プラグイン層（FEEDBACK_GATE_HOOK_SOURCE=plugin）の呼び出しがセッションのマーカーを書き、
// 設定層への写し（それ以外）の呼び出しはマーカーがあれば黙る。Claude Code の .classic_seen と同じ仕組み。
func TestCodexHookSource(t *testing.T) {
	withCodexEnv(t, func(env codexEnv) {
		marker := filepath.Join(env.feedback, CodexPluginSeenDir, "sess-1")
		copyIo := MakeIo(IoOpts{ProjectDir: env.proj, Env: EnvVars{ClaudeFeedbackDir: env.feedback, Path: "/nonexistent", FeedbackGateHookSource: "config"}})
		bareIo := env.io
		pluginIo := MakeIo(IoOpts{ProjectDir: env.proj, Env: EnvVars{ClaudeFeedbackDir: env.feedback, Path: "/nonexistent", FeedbackGateHookSource: CodexHookSourcePlugin}})
		payload := Dict{"session_id": "sess-1", "cwd": env.proj, "hook_event_name": "Stop"}

		t.Run("without a marker every source runs, and a config-layer call writes none", func(t *testing.T) {
			assert.True(t, CodexHookSourceAllows(copyIo, payload))
			assert.True(t, CodexHookSourceAllows(bareIo, payload))
			_, ok := CodexNormalize("Stop", payload, copyIo)
			assert.True(t, ok)
			assert.False(t, Exists(marker))
		})

		t.Run("a plugin-layer call writes the marker of its session; from then on the copies of that session are silent", func(t *testing.T) {
			call, ok := CodexNormalize("Stop", payload, pluginIo)
			assert.True(t, ok)
			assert.Equal(t, "Stop", call.Event)
			assert.True(t, Exists(marker))
			assert.False(t, CodexHookSourceAllows(copyIo, payload))
			assert.False(t, CodexHookSourceAllows(bareIo, payload))
			_, ok = CodexNormalize("Stop", payload, copyIo)
			assert.False(t, ok)
			_, ok = CodexNormalize("PreToolUse", Dict{"session_id": "sess-1", "cwd": env.proj, "tool_name": "Bash", "tool_input": Dict{"command": "rm -rf /"}}, copyIo)
			assert.False(t, ok)
			// プラグイン層は引き続き走る（マーカーを書き直す）。
			assert.True(t, CodexHookSourceAllows(pluginIo, payload))
			// 別のセッションの写しは影響を受けない。
			assert.True(t, CodexHookSourceAllows(copyIo, Dict{"session_id": "sess-2"}))
			// 出力は空（CodexRender はゼロ値の Outcome で何も出さない）。
			r := CodexRender("Stop", Outcome{}, "", copyIo)
			assert.Equal(t, ScriptResult{ExitCode: 0, Stdout: "", Stderr: ""}, r)
		})

		t.Run("no session_id: nothing is written and nothing is skipped; unsafe characters are dropped from the file name", func(t *testing.T) {
			assert.True(t, CodexHookSourceAllows(pluginIo, Dict{}))
			assert.True(t, CodexHookSourceAllows(copyIo, Dict{}))
			assert.True(t, CodexHookSourceAllows(pluginIo, Dict{"session_id": "../x/y"}))
			assert.True(t, Exists(filepath.Join(env.feedback, CodexPluginSeenDir, "xy")))
			assert.False(t, CodexHookSourceAllows(copyIo, Dict{"session_id": "../x/y"}))
		})
	})
}

func TestCodexRenderUsesSummarizedReason(t *testing.T) {
	io := MakeIo(IoOpts{ProjectDir: "/proj"})
	full := "=== [gate] log ===\n" + strings.Repeat("line\n", 500)
	t.Run("Stop / PostToolUse の block は要約版の reason を使い、無ければ stderr 全体", func(t *testing.T) {
		for _, event := range []string{"Stop", "SubagentStop", "PostToolUse"} {
			r := parseHookJSON(t, outcomeToCodex(io, event, Outcome{Block: StrPtr(full), BlockReason: StrPtr("summary")}).Stdout)
			assert.Equal(t, "summary", r["reason"], event)
			r = parseHookJSON(t, outcomeToCodex(io, event, Outcome{Block: StrPtr(full)}).Stdout)
			assert.Equal(t, full, r["reason"], event)
		}
	})
	t.Run("PreToolUse の deny も要約版を使う", func(t *testing.T) {
		r := parseHookJSON(t, outcomeToCodex(io, "PreToolUse", Outcome{Deny: StrPtr(full), BlockReason: StrPtr("summary")}).Stdout)
		assert.Equal(t, "summary", r["hookSpecificOutput"].(Dict)["permissionDecisionReason"])
	})
	t.Run("ToOutcome は exit 2 の stdout の JSON から要約版を取り、Merge は先に出た step のものを残す", func(t *testing.T) {
		stdout := JSONStringify(Dict{"decision": "block", "reason": "summary"}) + "\n"
		o := ToOutcome("Stop", ScriptResult{ExitCode: 2, Stdout: stdout, Stderr: full})
		require.NotNil(t, o.BlockReason)
		assert.Equal(t, "summary", *o.BlockReason)
		assert.Equal(t, strings.TrimSpace(full), *o.Block)
		assert.Nil(t, ToOutcome("Stop", ScriptResult{ExitCode: 2, Stdout: "not json", Stderr: full}).BlockReason)
		merged := Merge(ToOutcome("Stop", ScriptResult{ExitCode: 2, Stderr: "plain"}), o)
		assert.Equal(t, "plain", *merged.Block)
		assert.Nil(t, merged.BlockReason)
	})
}
