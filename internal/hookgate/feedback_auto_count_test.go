package hookgate

// tests/feedback-auto-count.spec.ts の移植。

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 違反を検出したときの count の自動引き上げ（AutoBumpCounts）を、3 つの hook 経由で確かめる。
func TestFeedbackAutoCount(t *testing.T) {
	type env struct {
		feedbackDir, projectDir string
	}
	run := func(t *testing.T, body func(e env)) {
		t.Helper()
		WithTmp(func(feedbackDir string) {
			WithTmp(func(projectDir string) { body(env{feedbackDir, projectDir}) })
		})
	}

	// frontmatter の外（本文）にも count: 行や似たキーを置き、count 行以外が一切変わらないことを確かめる。
	ruleText := func(name string, count int, enforce []string) string {
		lines := append([]string{"---", "name: " + name, "description: test", "type: feedback", "count: " + strconv.Itoa(count), "max_count: 9"}, enforce...)
		return strings.Join(append(lines, "---", "", "本文", "count: 1", ""), "\n")
	}

	bashRule := func(count int, dir, name string) string {
		p := filepath.Join(dir, name+".md")
		require.NoError(t, os.MkdirAll(dir, 0o755))
		fbtWrite(p, ruleText(name, count, []string{
			"enforce:",
			"  - event: pre_bash",
			`    when: '\bgo test\b'`,
			"    message: 'hook に任せる'",
			"  - event: pre_bash",
			`    when: 'go test ./\.\.\.'`,
		}))
		return p
	}

	countOf := func(p string) int {
		n, ok := ReadCountLine(Read(p))
		require.True(t, ok, p)
		return n
	}

	type guardOpts struct {
		autoCount *bool
		lang      Lang
	}
	guard := func(e env, sessionID string, o guardOpts) ScriptResult {
		payload := Dict{"tool_name": "Bash", "tool_input": Dict{"command": "go test ./..."}}
		if sessionID != "" {
			payload["session_id"] = sessionID
		}
		return FeedbackGuard(MakeIo(IoOpts{ProjectDir: e.projectDir, Env: EnvVars{ClaudeFeedbackDir: e.feedbackDir}, AutoCount: o.autoCount, Lang: o.lang}), payload)
	}

	t.Run("違反を検出すると count を 1 上げ、frontmatter の count 行以外は変えない", func(t *testing.T) {
		run(t, func(e env) {
			p := bashRule(1, e.feedbackDir, "no_go_test")
			before := Read(p)
			r := guard(e, "s1", guardOpts{})
			assert.Contains(t, r.Stderr, "no_go_test (count: 1)")
			assert.Contains(t, r.Stderr, "count を 1 → 2 に上げました")
			after := Read(p)
			assert.Equal(t, strings.Replace(before, "\ncount: 1\n", "\ncount: 2\n", 1), after)
			// 本文の count: 1 は残る
			assert.True(t, strings.HasSuffix(after, "本文\ncount: 1\n"))
			// 一時ファイルを残さない
			entries, err := os.ReadDir(e.feedbackDir)
			require.NoError(t, err)
			for _, f := range entries {
				assert.False(t, strings.HasSuffix(f.Name(), ".tmp"), f.Name())
			}
		})
	})

	t.Run("同じセッションでは 2 回目以降は上げない（enforce が複数一致しても 1 回）", func(t *testing.T) {
		run(t, func(e env) {
			p := bashRule(1, e.feedbackDir, "no_go_test")
			guard(e, "s1", guardOpts{})
			r := guard(e, "s1", guardOpts{})
			assert.Equal(t, 2, countOf(p))
			assert.NotContains(t, r.Stderr, "上げました")
			io := MakeIo(IoOpts{ProjectDir: e.projectDir, Env: EnvVars{ClaudeFeedbackDir: e.feedbackDir}})
			assert.Equal(t, Dict{"bumped": []any{"no_go_test"}}, fbtParseJSON(t, Read(CountStatePath(io, "s1"))))
		})
	})

	t.Run("別のセッションではまた上がり、count に応じて強制力も上がる", func(t *testing.T) {
		run(t, func(e env) {
			p := bashRule(2, e.feedbackDir, "no_go_test")
			guard(e, "s1", guardOpts{})
			assert.Equal(t, 3, countOf(p))
			r := guard(e, "s2", guardOpts{})
			assert.Equal(t, 4, countOf(p))
			// s2 の判定は上げる前の count 3 で行う（ask）。理由に引き上げの旨が入る。
			hs := fbtParseJSON(t, r.Stdout)["hookSpecificOutput"].(Dict)
			assert.Equal(t, "ask", hs["permissionDecision"])
			assert.Contains(t, hs["permissionDecisionReason"], "no_go_test (count: 3)")
			assert.Contains(t, hs["permissionDecisionReason"], "count を 3 → 4 に上げました")
		})
	})

	t.Run("上限（deny になる count = AutoCountMax）で止まる", func(t *testing.T) {
		run(t, func(e env) {
			assert.Equal(t, 5, AutoCountMax)
			p := bashRule(4, e.feedbackDir, "no_go_test")
			guard(e, "s1", guardOpts{})
			assert.Equal(t, 5, countOf(p))
			before := Read(p)
			r := guard(e, "s2", guardOpts{})
			assert.Equal(t, before, Read(p))
			assert.Equal(t, "deny", fbtParseJSON(t, r.Stdout)["hookSpecificOutput"].(Dict)["permissionDecision"])
			assert.NotContains(t, r.Stdout, "上げました")
		})
	})

	t.Run("autoCount=false なら上げない", func(t *testing.T) {
		run(t, func(e env) {
			p := bashRule(1, e.feedbackDir, "no_go_test")
			off := false
			r := guard(e, "s1", guardOpts{autoCount: &off})
			assert.Equal(t, 1, countOf(p))
			assert.Contains(t, r.Stderr, "no_go_test (count: 1)")
			assert.NotContains(t, r.Stderr, "上げました")
		})
	})

	t.Run("session_id が無ければ上げない（セッション単位の抑制ができないため）", func(t *testing.T) {
		run(t, func(e env) {
			p := bashRule(1, e.feedbackDir, "no_go_test")
			guard(e, "", guardOpts{})
			assert.Equal(t, 1, countOf(p))
		})
	})

	t.Run("同名ルールがプロジェクトにもあれば、実際に使われたプロジェクト側を上げる", func(t *testing.T) {
		run(t, func(e env) {
			g := bashRule(1, e.feedbackDir, "no_go_test")
			proj := bashRule(2, filepath.Join(e.projectDir, ".claude", "feedback"), "no_go_test")
			guard(e, "s1", guardOpts{})
			assert.Equal(t, 1, countOf(g))
			assert.Equal(t, 3, countOf(proj))
		})
	})

	t.Run("英語のメッセージ", func(t *testing.T) {
		run(t, func(e env) {
			bashRule(1, e.feedbackDir, "no_go_test")
			r := guard(e, "s1", guardOpts{lang: LangEN})
			assert.Contains(t, r.Stderr, "raised the count of no_go_test from 1 to 2")
		})
	})

	t.Run("PostToolUse（post_edit）でも上げる", func(t *testing.T) {
		run(t, func(e env) {
			p := filepath.Join(e.feedbackDir, "no_console_log.md")
			fbtWrite(p, ruleText("no_console_log", 3, []string{
				"enforce:",
				"  - event: post_edit",
				"    path: 'src/**/*.ts'",
				`    when: '^\s*console\.log\('`,
				"    message: 'console.log を残さない'",
			}))
			file := filepath.Join(e.projectDir, "src", "a.ts")
			fbtWrite(file, "console.log(1)\n")
			r := FeedbackPostEdit(MakeIo(IoOpts{ProjectDir: e.projectDir, Env: EnvVars{ClaudeFeedbackDir: e.feedbackDir}}), Dict{
				"session_id": "s1", "tool_name": "Edit", "tool_input": Dict{"file_path": file},
			})
			assert.Equal(t, 4, countOf(p))
			assert.Contains(t, fbtParseJSON(t, r.Stdout)["reason"], "count を 3 → 4 に上げました")
		})
	})

	t.Run("Stop（stop_check）でも上げ、ブロックが続いても同じセッションでは 1 回だけ", func(t *testing.T) {
		run(t, func(e env) {
			p := filepath.Join(e.feedbackDir, "readme_bilingual.md")
			fbtWrite(p, ruleText("readme_bilingual", 1, []string{
				"enforce:",
				"  - event: stop_check",
				"    changed: '**/README.md'",
				"    require_sibling: 'README_ja.md'",
				"    message: '日英併記'",
			}))
			fbtWrite(filepath.Join(e.projectDir, "README.md"), "")
			fbtWrite(filepath.Join(e.projectDir, ".claude", ".gate-status", "changed_files.s1.txt"), "README.md\n")
			io := MakeIo(IoOpts{ProjectDir: e.projectDir, Env: EnvVars{ClaudeFeedbackDir: e.feedbackDir}})
			r := FeedbackStopCheck(io, Dict{"session_id": "s1"})
			assert.Contains(t, r.Stderr, "count を 1 → 2 に上げました")
			FeedbackStopCheck(io, Dict{"session_id": "s1"})
			assert.Equal(t, 2, countOf(p))
		})
	})
}

func TestReadCountLineReplaceCountLine(t *testing.T) {
	t.Run("frontmatter の数値の count 行だけを扱う", func(t *testing.T) {
		text := "---\nname: a\ncount: 2\n---\ncount: 7\n"
		n, ok := ReadCountLine(text)
		assert.True(t, ok)
		assert.Equal(t, 2, n)
		got, ok := ReplaceCountLine(text, 3)
		assert.True(t, ok)
		assert.Equal(t, "---\nname: a\ncount: 3\n---\ncount: 7\n", got)
	})

	t.Run("count 行が無い・数値でない・frontmatter が無いときは扱わない", func(t *testing.T) {
		_, ok := ReadCountLine("---\nname: a\n---\ncount: 7\n")
		assert.False(t, ok)
		_, ok = ReplaceCountLine("---\nname: a\ncount: \"2\"\n---\n", 3)
		assert.False(t, ok)
		_, ok = ReplaceCountLine("count: 2\n", 3)
		assert.False(t, ok)
	})

	t.Run("CRLF の改行を保つ", func(t *testing.T) {
		got, ok := ReplaceCountLine("---\r\nname: a\r\ncount: 2\r\n---\r\nbody\r\n", 3)
		assert.True(t, ok)
		assert.Equal(t, "---\r\nname: a\r\ncount: 3\r\n---\r\nbody\r\n", got)
	})
}
