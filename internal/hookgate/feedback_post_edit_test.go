package hookgate

// tests/feedback-post-edit.spec.ts の移植。

import (
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFeedbackPostEdit(t *testing.T) {
	type env struct {
		feedbackDir, projectDir string
	}
	run := func(t *testing.T, body func(e env)) {
		t.Helper()
		WithTmp(func(feedbackDir string) {
			WithTmp(func(projectDir string) { body(env{feedbackDir, projectDir}) })
		})
	}
	writeRule := func(e env, name string, count int, enforce []string) {
		content := strings.Join(append(append([]string{"---", "name: " + name, "description: test", "type: feedback", "count: " + strconv.Itoa(count), "enforce:"}, enforce...), "---", "", "本文", ""), "\n")
		fbtWrite(filepath.Join(e.feedbackDir, name+".md"), content)
	}
	writeFile := func(e env, rel, content string) string {
		abs := filepath.Join(e.projectDir, rel)
		fbtWrite(abs, content)
		return abs
	}
	runHook := func(e env, payload Dict) ScriptResult {
		return FeedbackPostEdit(MakeIo(IoOpts{ProjectDir: e.projectDir, Env: EnvVars{ClaudeFeedbackDir: e.feedbackDir}}), payload)
	}
	edit := func(e env, filePath string, toolName ...string) ScriptResult {
		name := "Edit"
		if len(toolName) > 0 {
			name = toolName[0]
		}
		return runHook(e, Dict{"tool_name": name, "tool_input": Dict{"file_path": filePath}})
	}
	consoleLogRule := func(e env, count int, extra ...string) {
		writeRule(e, "no_console_log", count, append([]string{
			"  - event: post_edit",
			"    path: 'src/**/*.ts'",
			`    when: '^\s*console\.log\('`,
			"    message: 'console.log を残さない'",
		}, extra...))
	}

	t.Run("blocks when the edited file as a whole matches when (count 4 -> block)", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogRule(e, 4)
			file := writeFile(e, "src/a.ts", "const x = 1\nconsole.log(x)\n")
			r := edit(e, file)
			assert.Equal(t, 0, r.ExitCode)
			out := fbtParseJSON(t, r.Stdout)
			assert.Equal(t, "block", out["decision"])
			reason := Str(out["reason"])
			assert.Contains(t, reason, "[feedback-post-edit] no_console_log (count: 4): console.log を残さない")
			assert.Contains(t, reason, "content matched")
			assert.Contains(t, r.Stderr, reason)
		})
	})

	t.Run("accepts a project-relative file_path", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogRule(e, 5)
			writeFile(e, "src/a.ts", "console.log(1)\n")
			r := edit(e, "src/a.ts", "Write")
			assert.Equal(t, "block", fbtParseJSON(t, r.Stdout)["decision"])
		})
	})

	t.Run("unless avoids the violation", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogRule(e, 4, "    unless: 'eslint-disable'")
			file := writeFile(e, "src/a.ts", "// eslint-disable-next-line\nconsole.log(1)\n")
			r := edit(e, file)
			assert.Equal(t, 0, r.ExitCode)
			assert.Equal(t, "", r.Stdout)
			assert.Equal(t, "", r.Stderr)
		})
	})

	t.Run("count 1 only warns on stderr", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogRule(e, 1)
			file := writeFile(e, "src/a.ts", "console.log(1)\n")
			r := edit(e, file, "MultiEdit")
			assert.Equal(t, 0, r.ExitCode)
			assert.Equal(t, "", r.Stdout)
			assert.Equal(t, "[feedback-post-edit] warn: no_console_log (count: 1): console.log を残さない\n", r.Stderr)
		})
	})

	t.Run("exclude_path skips the file", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogRule(e, 5, "    exclude_path: '**/*.test.ts'")
			file := writeFile(e, "src/a.test.ts", "console.log(1)\n")
			r := edit(e, file)
			assert.Equal(t, "", r.Stdout)
			assert.Equal(t, "", r.Stderr)
		})
	})

	t.Run("a file outside path is ignored", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogRule(e, 5)
			file := writeFile(e, "lib/a.ts", "console.log(1)\n")
			assert.Equal(t, "", edit(e, file).Stdout)
		})
	})

	t.Run("check failing (non-zero) is a violation", func(t *testing.T) {
		run(t, func(e env) {
			writeRule(e, "has_header", 4, []string{
				"  - event: post_edit",
				"    path: '**/*.ts'",
				`    check: 'head -1 "$FILE" | grep -q HEADER'`,
				"    message: 'ヘッダを付ける'",
			})
			file := writeFile(e, "a.ts", "no header\n")
			r := edit(e, file)
			out := fbtParseJSON(t, r.Stdout)
			assert.Equal(t, "block", out["decision"])
			assert.Contains(t, out["reason"], "has_header")
			assert.Contains(t, out["reason"], "check failed")
		})
	})

	t.Run("check passing (zero) is not a violation", func(t *testing.T) {
		run(t, func(e env) {
			writeRule(e, "has_header", 5, []string{
				"  - event: post_edit",
				"    path: '**/*.ts'",
				`    check: 'head -1 "$FILE" | grep -q HEADER'`,
				"    message: 'ヘッダを付ける'",
			})
			file := writeFile(e, "a.ts", "HEADER\nbody\n")
			r := edit(e, file)
			assert.Equal(t, "", r.Stdout)
			assert.Equal(t, "", r.Stderr)
		})
	})

	t.Run("when and check are ANDed: when not matching skips the check", func(t *testing.T) {
		run(t, func(e env) {
			writeRule(e, "both", 5, []string{"  - event: post_edit", "    path: '**/*.ts'", "    when: 'TODO'", "    check: 'false'", "    message: 'x'"})
			clean := writeFile(e, "a.ts", "ok\n")
			assert.Equal(t, "", edit(e, clean).Stdout)
			dirty := writeFile(e, "b.ts", "TODO\n")
			assert.Equal(t, "block", fbtParseJSON(t, edit(e, dirty).Stdout)["decision"])
		})
	})

	t.Run("an entry with neither when nor check is ignored", func(t *testing.T) {
		run(t, func(e env) {
			writeRule(e, "empty", 5, []string{"  - event: post_edit", "    path: '**/*.ts'", "    message: 'x'"})
			file := writeFile(e, "a.ts", "anything\n")
			r := edit(e, file)
			assert.Equal(t, "", r.Stdout)
			assert.Equal(t, "", r.Stderr)
		})
	})

	t.Run("explicit severity overrides count", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogRule(e, 1, "    severity: block")
			file := writeFile(e, "src/a.ts", "console.log(1)\n")
			assert.Equal(t, "block", fbtParseJSON(t, edit(e, file).Stdout)["decision"])
		})
	})

	t.Run("violations are logged", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogRule(e, 4)
			file := writeFile(e, "src/a.ts", "console.log(1)\n")
			edit(e, file)
			lines := fbtJSONLines(t, filepath.Join(e.feedbackDir, ".violations.jsonl"))
			require.Len(t, lines, 1)
			assert.Equal(t, "no_console_log", lines[0]["rule"])
			assert.EqualValues(t, 4, lines[0]["count"])
			assert.Equal(t, "block", lines[0]["severity"])
			assert.Equal(t, "post_edit", lines[0]["event"])
		})
	})

	t.Run("ok when file_path is missing", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogRule(e, 5)
			r := runHook(e, Dict{"tool_name": "Edit", "tool_input": Dict{}})
			assert.Equal(t, ScriptResult{ExitCode: 0, Stdout: "", Stderr: ""}, r)
		})
	})

	t.Run("ok when the file does not exist", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogRule(e, 5)
			r := edit(e, filepath.Join(e.projectDir, "src", "missing.ts"))
			assert.Equal(t, ScriptResult{ExitCode: 0, Stdout: "", Stderr: ""}, r)
		})
	})

	t.Run("ok for tools other than Write/Edit/MultiEdit", func(t *testing.T) {
		run(t, func(e env) {
			consoleLogRule(e, 5)
			file := writeFile(e, "src/a.ts", "console.log(1)\n")
			r := edit(e, file, "Read")
			assert.Equal(t, ScriptResult{ExitCode: 0, Stdout: "", Stderr: ""}, r)
		})
	})
}
