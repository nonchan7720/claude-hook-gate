package hookgate

// tests/feedback-bash-edit.spec.ts の移植（FeedbackBashEdits を直接呼ぶ部分）。
//
// 元のテストの大半は src/bash-changes.ts の bashStarted / bashChanges（Bash が書き換えたファイルの検出）を通して
// feedbackBashEdits を呼ぶ。それらは bash_changes.go とともに feedback_bash_edit_steps_test.go に移植してある。
// ここには、bashChanges を通さずに FeedbackBashEdits を直接呼ぶ元のテスト（'an internal error is logged...'、addedLines）と、
// 同じ挙動を FeedbackBashEdits の直接呼び出しで確かめる追加のテスト（TS 版には無い）を置く。

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const fbtT0 int64 = 1_700_000_000_000

// fbtBoomRunIo は Run が例外を投げる Io（内部エラーのテスト用）。
type fbtBoomRunIo struct{ Io }

func (fbtBoomRunIo) Run([]string, RunOptions) RunResult { panic("boom") }

func TestBashEditsCheckedByFeedbackRules(t *testing.T) {
	type env struct{ proj, fb string }
	run := func(t *testing.T, body func(e env)) {
		t.Helper()
		WithTmp(func(proj string) {
			WithTmp(func(fb string) { body(env{proj, fb}) })
		})
	}
	ioOf := func(e env, autoCount *bool) Io {
		return MakeIo(IoOpts{ProjectDir: e.proj, Now: func() int64 { return fbtT0 }, Env: EnvVars{ClaudeFeedbackDir: e.fb}, AutoCount: autoCount})
	}
	payload := func(extra Dict) Dict {
		p := Dict{"session_id": "sess-1", "tool_name": "Bash", "tool_input": Dict{"command": "cat > src/a.ts <<'EOF' ... EOF"}, "tool_use_id": "tu1", "cwd": ""}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}
	writeRule := func(e env, name string, count int, enforce []string) {
		content := strings.Join(append(append([]string{"---", "name: " + name, "description: test", "type: feedback", "count: " + strconv.Itoa(count), "enforce:"}, enforce...), "---", "", "body", ""), "\n")
		fbtWrite(filepath.Join(e.fb, name+".md"), content)
	}
	consoleLogPost := func(e env, count int) {
		writeRule(e, "no_console_log", count, []string{
			"  - event: post_edit",
			"    path: 'src/**/*.ts'",
			`    when: '^\s*console\.log\('`,
			"    message: 'console.log を残さない'",
		})
	}
	noAnyPre := func(e env, count int) {
		writeRule(e, "no_any", count, []string{"  - event: pre_edit", "    path: 'src/**/*.ts'", `    when: ':\s*any\b'`, "    message: 'any を書かない'"})
	}
	countOf := func(e env, name string) int {
		n, ok := ReadCountLine(Read(filepath.Join(e.fb, name+".md")))
		require.True(t, ok)
		return n
	}
	write := func(e env, rel, text string) string {
		abs := filepath.Join(e.proj, rel)
		fbtWrite(abs, text)
		return abs
	}

	t.Run("an internal error is logged to .errors.jsonl and does not stop the work", func(t *testing.T) {
		run(t, func(e env) {
			noAnyPre(e, 4)
			abs := write(e, "src/a.ts", "export const y: any = 2\n")
			broken := fbtBoomRunIo{ioOf(e, nil)}
			r := FeedbackBashEdits(broken, payload(nil), []string{abs}, fbtT0)
			assert.Equal(t, "", r.Stdout)
			assert.Equal(t, "[feedback-bash-edit] internal error (ignored): boom\n", r.Stderr)
			assert.Contains(t, Read(filepath.Join(e.fb, ".errors.jsonl")), `"source":"feedback-bash-edit"`)
		})
	})

	// ---- 追加: bashChanges を通さずに FeedbackBashEdits を直接呼ぶ ----

	t.Run("direct: a file written by Bash is blocked by a post_edit rule, like Edit / Write", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogPost(e, 4)
			abs := write(e, "src/a.ts", "console.log(1)\n")
			r := FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{abs}, fbtT0)
			out := fbtParseJSON(t, r.Stdout)
			assert.Equal(t, "block", out["decision"])
			assert.Contains(t, out["reason"], "[feedback] Bash が書き換えたファイルが feedback ルールに違反しています")
			assert.Contains(t, out["reason"], "[feedback-post-edit] no_console_log (count: 4): console.log を残さない (src/a.ts: content matched")
		})
	})

	t.Run("direct: a relative file is resolved against the project dir; clean files and files outside path are ignored", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogPost(e, 4)
			write(e, "src/a.ts", "console.log(1)\n")
			write(e, "src/b.ts", "export {}\n")
			write(e, "other/c.ts", "console.log(1)\n")
			r := FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{"src/b.ts", "other/c.ts"}, fbtT0)
			assert.Equal(t, ScriptResult{}, r)
			r = FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{"src/a.ts"}, fbtT0)
			assert.Equal(t, "block", fbtParseJSON(t, r.Stdout)["decision"])
		})
	})

	t.Run("direct: violations in several files are merged into one block (sorted by path)", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogPost(e, 4)
			a := write(e, "src/a.ts", "console.log(1)\n")
			b := write(e, "src/b.ts", "console.log(2)\n")
			r := FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{b, a}, fbtT0)
			reason := Str(fbtParseJSON(t, r.Stdout)["reason"])
			assert.Contains(t, reason, "(src/a.ts: ")
			assert.Contains(t, reason, "(src/b.ts: ")
			assert.Less(t, strings.Index(reason, "(src/a.ts: "), strings.Index(reason, "(src/b.ts: "))
		})
	})

	t.Run("direct: count 1 only warns, and the count is raised once per session", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogPost(e, 1)
			abs := write(e, "src/a.ts", "console.log(1)\n")
			r := FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{abs}, fbtT0)
			assert.Equal(t, "", r.Stdout)
			lines := strings.Split(strings.TrimRight(r.Stderr, "\n"), "\n")
			require.Len(t, lines, 2)
			assert.Equal(t, "[feedback-post-edit] warn: no_console_log (count: 1): console.log を残さない (src/a.ts)", lines[0])
			assert.Contains(t, lines[1], "no_console_log の count を 1 → 2 に上げました")
			assert.Equal(t, 2, countOf(e, "no_console_log"))
			// 同じセッションでは上げない
			FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{abs}, fbtT0)
			assert.Equal(t, 2, countOf(e, "no_console_log"))
		})
	})

	t.Run("direct: autoCount=false leaves the count alone", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogPost(e, 4)
			abs := write(e, "src/a.ts", "console.log(1)\n")
			off := false
			r := FeedbackBashEdits(ioOf(e, &off), payload(nil), []string{abs}, fbtT0)
			assert.Equal(t, "block", fbtParseJSON(t, r.Stdout)["decision"])
			assert.NotContains(t, r.Stdout, "上げました")
			assert.Equal(t, 4, countOf(e, "no_console_log"))
		})
	})

	t.Run("direct: a new file whose content matches a pre_edit when is blocked, saying it was detected after the command", func(t *testing.T) {
		run(t, func(e env) {
			noAnyPre(e, 5)
			abs := write(e, "src/a.ts", "export const y: any = 2\n")
			r := FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{abs}, fbtT0)
			reason := Str(fbtParseJSON(t, r.Stdout)["reason"])
			assert.Contains(t, reason, "[feedback-guard] no_any (count: 5): any を書かない (src/a.ts: content matched")
			assert.Contains(t, reason, "実行後に検知しました")
		})
	})

	t.Run("direct: absent_sibling: an implementation written without its test is blocked; with the test it passes", func(t *testing.T) {
		run(t, func(e env) {
			writeRule(e, "tdd", 4, []string{"  - event: pre_edit", "    path: 'src/**/*.ts'", "    absent_sibling: '{stem}.test.ts'", "    message: 'テストを先に書く'"})
			bad := write(e, "src/foo.ts", "export {}\n")
			r := FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{bad}, fbtT0)
			assert.Contains(t, fbtParseJSON(t, r.Stdout)["reason"], "tdd (count: 4): テストを先に書く (src/foo.ts: missing test file: foo.test.ts)")
			good := write(e, "src/bar.ts", "export {}\n")
			write(e, "src/bar.test.ts", "test\n")
			r = FeedbackBashEdits(ioOf(e, nil), payload(map[string]any{"session_id": "sess-2"}), []string{good}, fbtT0)
			assert.Equal(t, "", r.Stdout)
		})
	})

	t.Run("direct: an ask already answered for the same file in this session is downgraded to warn", func(t *testing.T) {
		run(t, func(e env) {
			noAnyPre(e, 3)
			abs := write(e, "src/a.ts", "export const y: any = 2\n")
			first := FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{abs}, fbtT0)
			assert.Equal(t, "block", fbtParseJSON(t, first.Stdout)["decision"])
			second := FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{abs}, fbtT0)
			assert.Equal(t, "", second.Stdout)
			// 1 回目の違反で count は 4 に上がっている（4 でもまだ ask なので、承認済みとして warn に落ちる）
			assert.Contains(t, second.Stderr, "[feedback-guard] warn: no_any (count: 4)")
		})
	})

	t.Run("direct: no rule with post_edit / pre_edit means no work", func(t *testing.T) {
		run(t, func(e env) {
			writeRule(e, "bash_only", 5, []string{"  - event: pre_bash", "    when: 'rm'", "    message: 'x'"})
			abs := write(e, "src/a.ts", "console.log(1)\n")
			assert.Equal(t, ScriptResult{}, FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{abs}, fbtT0))
		})
	})

	t.Run("direct: lines added to a tracked file are matched, not the old ones", func(t *testing.T) {
		run(t, func(e env) {
			noAnyPre(e, 5)
			fbtInitRepo(t, e.proj)
			old := write(e, "src/old.ts", "export const x: any = 1\n")
			fbtGit(t, e.proj, "add", ".")
			fbtGit(t, e.proj, "commit", "-q", "-m", "init")
			// 元からある ": any" ではなく、足した行だけを見る
			require.NoError(t, os.WriteFile(old, []byte("export const x: any = 1\nexport const z = 3\n"), 0o644))
			assert.Equal(t, "export const z = 3", WrittenContent(ioOf(e, nil), old, fbtT0))
			assert.Equal(t, ScriptResult{}, FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{old}, fbtT0))
			require.NoError(t, os.WriteFile(old, []byte("export const x: any = 1\nexport const z = 3\nexport const w: any = 4\n"), 0o644))
			r := FeedbackBashEdits(ioOf(e, nil), payload(nil), []string{old}, fbtT0)
			assert.Contains(t, fbtParseJSON(t, r.Stdout)["reason"], "no_any")
		})
	})
}

func TestAddedLines(t *testing.T) {
	t.Run("takes only the added lines inside hunks", func(t *testing.T) {
		diff := strings.Join([]string{
			"diff --git a/x b/x",
			"--- a/x",
			"+++ b/x",
			"@@ -1 +1,2 @@",
			"-old",
			"+new",
			"+++ starts with pluses",
			"diff --git a/y b/y",
			"+++ b/y",
			"@@ -0,0 +1 @@",
			"+y",
		}, "\n")
		assert.Equal(t, []string{"new", "++ starts with pluses", "y"}, AddedLines(diff))
	})
}
