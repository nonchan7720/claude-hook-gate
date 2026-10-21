package hookgate

// tests/feedback-guard.spec.ts の移植。

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

// fbtBoomListIo は List が例外を投げる Io（内部エラーのテスト用）。
type fbtBoomListIo struct{ Io }

func (fbtBoomListIo) List(string) []DirEntry { panic("boom") }

func fbtParseJSON(t *testing.T, text string) Dict {
	t.Helper()
	var d Dict
	require.NoError(t, json.Unmarshal([]byte(text), &d), text)
	return d
}

func fbtJSONLines(t *testing.T, path string) []Dict {
	t.Helper()
	out := []Dict{}
	for _, l := range strings.Split(Read(path), "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, fbtParseJSON(t, l))
		}
	}
	return out
}

func TestFeedbackGuard(t *testing.T) {
	// 各テストは自分用のルールディレクトリを持つ（beforeEach / afterEach の代わり）。
	withRules := func(t *testing.T, body func(tmp string, writeRule func(filename string, count int, enforce string))) {
		t.Helper()
		WithTmp(func(tmp string) {
			writeRule := func(filename string, count int, enforce string) {
				content := "---\nname: " + strings.TrimSuffix(filename, ".md") + "\ndescription: test\ntype: feedback\ncount: " + strconv.Itoa(count) + "\n" + enforce + "---\n\n本文\n"
				fbtWrite(filepath.Join(tmp, filename), content)
			}
			writeRule("dont_run_tests_manually.md", 6, strings.Join([]string{
				"enforce:",
				"  - event: pre_bash",
				`    when: '(^|&&|\|\||;)\s*go test\b'`,
				"    message: 'hookに任せてBashで手動実行しない'",
				"    severity: deny",
				"",
			}, "\n"))
			writeRule("tdd.md", 6, strings.Join([]string{
				"enforce:",
				"  - event: pre_edit",
				"    path: '**/*.go'",
				"    absent_sibling: '{stem}_test.go'",
				"    message: '先にテストファイルを書くこと'",
				"    severity: ask",
				"",
			}, "\n"))
			body(tmp, writeRule)
		})
	}
	runGuard := func(payload Dict, feedbackDir string, projectDir ...string) ScriptResult {
		proj, _ := os.Getwd()
		if len(projectDir) > 0 {
			proj = projectDir[0]
		}
		return FeedbackGuard(MakeIo(IoOpts{ProjectDir: proj, Env: EnvVars{ClaudeFeedbackDir: feedbackDir}}), payload)
	}
	decision := func(t *testing.T, stdout string) Dict {
		t.Helper()
		return fbtParseJSON(t, stdout)["hookSpecificOutput"].(Dict)
	}
	bash := func(command string, extra ...Dict) Dict {
		p := Dict{"tool_name": "Bash", "tool_input": Dict{"command": command}}
		for _, e := range extra {
			for k, v := range e {
				p[k] = v
			}
		}
		return p
	}
	write := func(proj, content string) Dict {
		return Dict{"tool_name": "Write", "tool_input": Dict{"file_path": filepath.Join(proj, "foo.go"), "content": content}}
	}

	t.Run("deny for manual go test", func(t *testing.T) {
		withRules(t, func(tmp string, _ func(string, int, string)) {
			r := runGuard(bash("go test ./..."), tmp)
			assert.Equal(t, 0, r.ExitCode)
			hs := decision(t, r.Stdout)
			assert.Equal(t, "PreToolUse", hs["hookEventName"])
			assert.Equal(t, "deny", hs["permissionDecision"])
			assert.Contains(t, hs["permissionDecisionReason"], "dont_run_tests_manually")
			assert.Contains(t, hs["permissionDecisionReason"], "count: 6")
		})
	})

	t.Run("passes for unrelated bash command", func(t *testing.T) {
		withRules(t, func(tmp string, _ func(string, int, string)) {
			r := runGuard(bash("ls -la"), tmp)
			assert.Equal(t, 0, r.ExitCode)
			assert.Equal(t, "", strings.TrimSpace(r.Stdout))
		})
	})

	t.Run("ask for missing test sibling on write", func(t *testing.T) {
		withRules(t, func(tmp string, _ func(string, int, string)) {
			WithTmp(func(proj string) {
				r := runGuard(write(proj, "package main"), tmp, proj)
				assert.Equal(t, 0, r.ExitCode)
				assert.Equal(t, "ask", decision(t, r.Stdout)["permissionDecision"])
			})
		})
	})

	t.Run("passes when test sibling exists", func(t *testing.T) {
		withRules(t, func(tmp string, _ func(string, int, string)) {
			WithTmp(func(proj string) {
				fbtWrite(filepath.Join(proj, "foo_test.go"), "")
				r := runGuard(write(proj, "package main"), tmp, proj)
				assert.Equal(t, 0, r.ExitCode)
				assert.Equal(t, "", strings.TrimSpace(r.Stdout))
			})
		})
	})

	t.Run("second ask in same session and file downgrades to warn", func(t *testing.T) {
		withRules(t, func(tmp string, _ func(string, int, string)) {
			WithTmp(func(proj string) {
				payload := write(proj, "package main")
				payload["session_id"] = "sess-ask-dedup"
				r1 := runGuard(payload, tmp, proj)
				assert.Equal(t, "ask", decision(t, r1.Stdout)["permissionDecision"])

				r2 := runGuard(payload, tmp, proj)
				assert.Equal(t, "", strings.TrimSpace(r2.Stdout))
				assert.Contains(t, r2.Stderr, "tdd")
				assert.Contains(t, r2.Stderr, "warn")

				tdd := []Dict{}
				for _, e := range fbtJSONLines(t, filepath.Join(tmp, ".violations.jsonl")) {
					if e["rule"] == "tdd" {
						tdd = append(tdd, e)
					}
				}
				require.NotEmpty(t, tdd)
				assert.Equal(t, "warn", tdd[len(tdd)-1]["severity"])
			})
		})
	})

	t.Run("ask for different file in same session is not suppressed", func(t *testing.T) {
		withRules(t, func(tmp string, _ func(string, int, string)) {
			WithTmp(func(proj string) {
				mk := func(name string) Dict {
					return Dict{"session_id": "sess-ask-dedup-2", "tool_name": "Write", "tool_input": Dict{"file_path": filepath.Join(proj, name), "content": "package main"}}
				}
				r1 := runGuard(mk("foo.go"), tmp, proj)
				r2 := runGuard(mk("bar.go"), tmp, proj)
				for _, r := range []ScriptResult{r1, r2} {
					assert.Equal(t, "ask", decision(t, r.Stdout)["permissionDecision"])
				}
			})
		})
	})

	t.Run("ask without session id is not suppressed", func(t *testing.T) {
		withRules(t, func(tmp string, _ func(string, int, string)) {
			WithTmp(func(proj string) {
				payload := write(proj, "package main")
				r1 := runGuard(payload, tmp, proj)
				r2 := runGuard(payload, tmp, proj)
				for _, r := range []ScriptResult{r1, r2} {
					assert.Equal(t, "ask", decision(t, r.Stdout)["permissionDecision"])
				}
			})
		})
	})

	t.Run("deny violation is not downgraded and repeats", func(t *testing.T) {
		withRules(t, func(tmp string, _ func(string, int, string)) {
			payload := bash("go test ./...", Dict{"session_id": "sess-deny-repeat"})
			r1 := runGuard(payload, tmp)
			r2 := runGuard(payload, tmp)
			for _, r := range []ScriptResult{r1, r2} {
				assert.Equal(t, "deny", decision(t, r.Stdout)["permissionDecision"])
			}
		})
	})

	t.Run("never fails hard on an empty payload or a broken rule", func(t *testing.T) {
		withRules(t, func(tmp string, writeRule func(string, int, string)) {
			empty := runGuard(Dict{}, tmp)
			assert.Equal(t, 0, empty.ExitCode)
			assert.Equal(t, "", empty.Stdout)

			// 壊れたルール（不正な正規表現）はその要素だけが無効になり、他のルールは効き続ける
			writeRule("broken.md", 6, strings.Join([]string{"enforce:", "  - event: pre_bash", "    when: '(unclosed'", "    message: 'x'", ""}, "\n"))
			r := runGuard(bash("ls"), tmp)
			assert.Equal(t, 0, r.ExitCode)
			assert.Equal(t, "", r.Stdout)
			assert.Equal(t, "", r.Stderr)
			denied := runGuard(bash("go test ./..."), tmp)
			assert.Equal(t, "deny", decision(t, denied.Stdout)["permissionDecision"])
			assert.Contains(t, Read(filepath.Join(tmp, ".errors.jsonl")), "broken.md")
		})
	})

	t.Run("an internal error is ignored but recorded in .errors.jsonl", func(t *testing.T) {
		withRules(t, func(tmp string, _ func(string, int, string)) {
			cwd, _ := os.Getwd()
			io := fbtBoomListIo{MakeIo(IoOpts{ProjectDir: cwd, Env: EnvVars{ClaudeFeedbackDir: tmp}})}
			r := FeedbackGuard(io, bash("go test ./..."))
			assert.Equal(t, 0, r.ExitCode)
			assert.Equal(t, "[feedback-guard] internal error (ignored): boom\n", r.Stderr)
			entries := fbtJSONLines(t, filepath.Join(tmp, ".errors.jsonl"))
			require.Len(t, entries, 1)
			assert.Equal(t, "feedback-guard", entries[0]["source"])
			assert.Equal(t, "boom", entries[0]["error"])
		})
	})
}
