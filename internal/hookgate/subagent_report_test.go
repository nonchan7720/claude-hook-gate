package hookgate

// src/subagent-report.ts のテスト。TS 版には専用の spec が無い（register.spec.ts が mod 越しに触れるだけ）ので、
// README「Results of subagents」の仕様どおりに状態ファイルの書き込み・引き渡し・削除を検証する。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func subagentReportFile(proj, session, agent string) string {
	return filepath.Join(proj, ".claude", ".gate-status", "subagent_report."+session+"--"+agent+".json")
}

func subagentTestIo(t *testing.T) (Io, string) {
	t.Helper()
	proj := TmpDir()
	t.Cleanup(func() { RmTree(proj) })
	return MakeIo(IoOpts{ProjectDir: proj}), proj
}

func writeSubagentReportFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSaveSubagentReport(t *testing.T) {
	stopPayload := Dict{"session_id": "S1", "agent_id": "a1b2c3", "agent_type": "code-implementer"}

	t.Run("saves the gate summary and the stop_check block reason", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		gate := &ScriptResult{Report: "  [gate] All checks passed: lint ✓ / test ✓\n", HasReport: true}
		fb := &ScriptResult{ExitCode: 2, Stdout: "not json\n{\"decision\":\"block\",\"reason\":\"  fix the rule  \"}\n", Stderr: "ignored"}
		r := SaveSubagentReport(io, stopPayload, gate, fb)
		if r != Ok("", "") {
			t.Fatalf("got %+v", r)
		}
		got := Read(subagentReportFile(proj, "S1", "a1b2c3"))
		want := `{"agentType":"code-implementer","gate":"[gate] All checks passed: lint ✓ / test ✓","feedback":"fix the rule"}` + "\n"
		if got != want {
			t.Fatalf("got %q want %q", got, want)
		}
	})

	t.Run("saves a warn (exit 0) stderr as feedback; gate absent", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		SaveSubagentReport(io, Dict{"session_id": "S1", "agent_id": "x"}, nil, &ScriptResult{ExitCode: 0, Stderr: "warn: something\n"})
		got := Read(subagentReportFile(proj, "S1", "x"))
		if got != `{"feedback":"warn: something"}`+"\n" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("exit 2 without a parsable block reason falls back to stderr", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		fb := &ScriptResult{ExitCode: 2, Stdout: "{\"decision\":\"approve\"}\n{\"decision\":\"block\",\"reason\":5}\n", Stderr: "stderr text\n"}
		SaveSubagentReport(io, Dict{"session_id": "S1", "agent_id": "x"}, nil, fb)
		if got := Read(subagentReportFile(proj, "S1", "x")); got != `{"feedback":"stderr text"}`+"\n" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("saves only the gate summary when stop_check found nothing", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		SaveSubagentReport(io, Dict{"session_id": "S1", "agent_id": "x"}, &ScriptResult{Report: "[gate] ok"}, &ScriptResult{})
		if got := Read(subagentReportFile(proj, "S1", "x")); got != `{"gate":"[gate] ok"}`+"\n" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("nothing to report: no file is written", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		path := subagentReportFile(proj, "S1", "a1b2c3")
		cases := map[string][2]*ScriptResult{
			"both undefined":      {nil, nil},
			"empty report":        {{Report: "  \n"}, {Stderr: " \n"}},
			"gate without report": {{}, nil},
			"consumed, no prior":  {{ReportConsumed: true}, nil},
		}
		for name, c := range cases {
			if r := SaveSubagentReport(io, stopPayload, c[0], c[1]); r != Ok("", "") {
				t.Fatalf("%s: got %+v", name, r)
			}
			if Exists(path) {
				t.Fatalf("%s: file was written", name)
			}
		}
		if Exists(filepath.Dir(path)) {
			t.Fatal("state dir was created")
		}
	})

	t.Run("nothing to report removes a report left by an earlier round", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		path := subagentReportFile(proj, "S1", "a1b2c3")
		writeSubagentReportFile(t, path, `{"gate":"old"}`+"\n")
		SaveSubagentReport(io, stopPayload, &ScriptResult{}, &ScriptResult{})
		if Exists(path) {
			t.Fatal("old report was kept")
		}
	})

	t.Run("a later round overwrites the earlier one", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		SaveSubagentReport(io, stopPayload, &ScriptResult{Report: "round 1"}, nil)
		SaveSubagentReport(io, stopPayload, &ScriptResult{Report: "round 2"}, nil)
		if got := Read(subagentReportFile(proj, "S1", "a1b2c3")); got != `{"agentType":"code-implementer","gate":"round 2"}`+"\n" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("the stop right after a success report keeps the previous gate result", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		path := subagentReportFile(proj, "S1", "a1b2c3")
		SaveSubagentReport(io, stopPayload, &ScriptResult{Report: "[gate] All checks passed"}, nil)
		SaveSubagentReport(io, stopPayload, &ScriptResult{ReportConsumed: true, Report: "ignored"}, nil)
		if got := Read(path); got != `{"agentType":"code-implementer","gate":"[gate] All checks passed"}`+"\n" {
			t.Fatalf("got %q", got)
		}
		// stop_check の結果は新しい回のものが加わる
		SaveSubagentReport(io, stopPayload, &ScriptResult{ReportConsumed: true}, &ScriptResult{Stderr: "later warn"})
		if got := Read(path); got != `{"agentType":"code-implementer","gate":"[gate] All checks passed","feedback":"later warn"}`+"\n" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("without agent_id nothing is written; without session_id the name uses unknown", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		SaveSubagentReport(io, Dict{"session_id": "S1"}, &ScriptResult{Report: "x"}, nil)
		if Exists(filepath.Join(proj, ".claude")) {
			t.Fatal("something was written without agent_id")
		}
		SaveSubagentReport(io, Dict{"agent_id": "zz"}, &ScriptResult{Report: "x"}, nil)
		if got := Read(subagentReportFile(proj, "unknown", "zz")); got != `{"gate":"x"}`+"\n" {
			t.Fatalf("got %q", got)
		}
	})
}

func TestSubagentReport(t *testing.T) {
	response := func(agentID string) Dict { return Dict{"agentId": agentID} }

	t.Run("hands the file content to additionalContext and removes it", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		path := subagentReportFile(proj, "S1", "a1b2c3")
		writeSubagentReportFile(t, path, `{"agentType":"code-implementer","gate":"[gate] All checks passed: lint ✓","feedback":"warn text"}`+"\n")
		r := SubagentReport(io, Dict{"session_id": "S1", "tool_response": response("a1b2c3")})
		if r.ExitCode != 0 || r.Stderr != "" {
			t.Fatalf("got %+v", r)
		}
		header := Tr(LangJA)("subagentReport.header", map[string]any{"agent": "code-implementer (a1b2c3)"})
		body := header + "\n[gate] All checks passed: lint ✓\nwarn text"
		want := JSONStringify(OMap{{"hookSpecificOutput", OMap{{"hookEventName", "PostToolUse"}, {"additionalContext", body}}}}) + "\n"
		if r.Stdout != want {
			t.Fatalf("stdout:\n got %q\nwant %q", r.Stdout, want)
		}
		if !strings.HasPrefix(r.Stdout, `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"[feedback-gate] `) {
			t.Fatalf("key order / prefix: %q", r.Stdout)
		}
		if Exists(path) {
			t.Fatal("report was not removed")
		}
	})

	t.Run("header uses the language of the io and the bare agent id without agentType", func(t *testing.T) {
		proj := TmpDir()
		defer RmTree(proj)
		io := MakeIo(IoOpts{ProjectDir: proj, Lang: LangEN})
		writeSubagentReportFile(t, subagentReportFile(proj, "S9", "zz"), `{"gate":"G"}`+"\n")
		r := SubagentReport(io, Dict{"session_id": "S9", "tool_response": response("zz")})
		if !strings.Contains(r.Stdout, "Results of the hooks run when subagent zz stopped") || !strings.Contains(r.Stdout, `\nG"`) {
			t.Fatalf("got %q", r.Stdout)
		}
	})

	t.Run("an unknown agentId does nothing and leaves other reports alone", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		other := subagentReportFile(proj, "S1", "other")
		writeSubagentReportFile(t, other, `{"gate":"G"}`+"\n")
		r := SubagentReport(io, Dict{"session_id": "S1", "tool_response": response("unknown-agent")})
		if r != Ok("", "") {
			t.Fatalf("got %+v", r)
		}
		if !Exists(other) {
			t.Fatal("other report was removed")
		}
	})

	t.Run("a report of another session is not taken", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		path := subagentReportFile(proj, "S1", "a")
		writeSubagentReportFile(t, path, `{"gate":"G"}`+"\n")
		if r := SubagentReport(io, Dict{"session_id": "S2", "tool_response": response("a")}); r != Ok("", "") {
			t.Fatalf("got %+v", r)
		}
		if !Exists(path) {
			t.Fatal("report of S1 was removed")
		}
	})

	t.Run("missing session_id looks up the unknown session", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		path := subagentReportFile(proj, "unknown", "a")
		writeSubagentReportFile(t, path, `{"feedback":"F"}`+"\n")
		r := SubagentReport(io, Dict{"tool_response": response("a")})
		if !strings.Contains(r.Stdout, `\nF"`) || Exists(path) {
			t.Fatalf("got %q, exists=%v", r.Stdout, Exists(path))
		}
	})

	t.Run("tool_response as a JSON string is not read (the host normalizes it to an object)", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		path := subagentReportFile(proj, "S1", "a1b2c3")
		writeSubagentReportFile(t, path, `{"gate":"G"}`+"\n")
		r := SubagentReport(io, Dict{"session_id": "S1", "tool_response": `{"agentId":"a1b2c3"}`})
		if r != Ok("", "") {
			t.Fatalf("got %+v", r)
		}
		if !Exists(path) {
			t.Fatal("report was removed although the agent id was not read")
		}
		// 正規化後（オブジェクト）なら引き取られる
		r = SubagentReport(io, Dict{"session_id": "S1", "tool_response": Dict{"agentId": "a1b2c3"}})
		if r.Stdout == "" || Exists(path) {
			t.Fatalf("object response was not handled: %+v", r)
		}
	})

	t.Run("missing or non-string agentId does nothing", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		path := subagentReportFile(proj, "S1", "a")
		writeSubagentReportFile(t, path, `{"gate":"G"}`+"\n")
		for _, p := range []Dict{
			{"session_id": "S1"},
			{"session_id": "S1", "tool_response": Dict{}},
			{"session_id": "S1", "tool_response": Dict{"agentId": nil}},
			{"session_id": "S1", "tool_response": []any{"a"}},
		} {
			if r := SubagentReport(io, p); r != Ok("", "") {
				t.Fatalf("%v: got %+v", p, r)
			}
		}
		if !Exists(path) {
			t.Fatal("report was removed")
		}
	})

	t.Run("an empty, unreadable or non-object report is removed and adds nothing", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		for name, content := range map[string]string{"only agentType": `{"agentType":"x"}`, "broken": "{nope", "array": "[1]", "empty fields": `{"gate":"","feedback":""}`} {
			path := subagentReportFile(proj, "S1", "a")
			writeSubagentReportFile(t, path, content)
			if r := SubagentReport(io, Dict{"session_id": "S1", "tool_response": response("a")}); r != Ok("", "") {
				t.Fatalf("%s: got %+v", name, r)
			}
			if Exists(path) {
				t.Fatalf("%s: report was not removed", name)
			}
		}
	})

	t.Run("save then report round trip", func(t *testing.T) {
		io, proj := subagentTestIo(t)
		SaveSubagentReport(io, Dict{"session_id": "S1", "agent_id": "rt", "agent_type": "reviewer"}, &ScriptResult{Report: "[gate] ok"}, &ScriptResult{Stderr: "w"})
		r := SubagentReport(io, Dict{"session_id": "S1", "tool_response": response("rt")})
		if !strings.Contains(r.Stdout, "reviewer (rt)") || !strings.Contains(r.Stdout, `\n[gate] ok\nw"`) {
			t.Fatalf("got %q", r.Stdout)
		}
		if Exists(subagentReportFile(proj, "S1", "rt")) {
			t.Fatal("report was not removed")
		}
	})
}
