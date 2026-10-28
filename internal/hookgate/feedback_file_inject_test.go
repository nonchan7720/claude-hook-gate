package hookgate

// tests/feedback-file-inject.spec.ts の移植。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func fbtFileRule(dir, name string, count int, extra string) {
	fbtWrite(filepath.Join(dir, name+".md"), "---\nname: "+name+"\ndescription: desc "+name+"\ntype: feedback\ncount: "+itoa(count)+"\n"+extra+"---\n\n"+name+" の本文の第一段落。\n\n**Why:** 理由。\n")
}

func itoa(n int) string { return JSNumber(float64(n)) }

// fbtContext は stdout の JSON から additionalContext を取り出す（空なら ""）。
func fbtContext(t *testing.T, stdout string) string {
	t.Helper()
	if strings.TrimSpace(stdout) == "" {
		return ""
	}
	var d struct {
		HookSpecificOutput struct {
			HookEventName     string `json:"hookEventName"`
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
	}
	require.NoError(t, json.Unmarshal([]byte(stdout), &d), stdout)
	assert.Equal(t, "PostToolUse", d.HookSpecificOutput.HookEventName)
	return d.HookSpecificOutput.AdditionalContext
}

func fbtRead(file, session string, agent ...string) Dict {
	p := Dict{"session_id": session, "tool_name": "Read", "tool_input": Dict{"file_path": file}, "tool_response": Dict{}}
	if len(agent) > 0 {
		p["agent_id"] = agent[0]
	}
	return p
}

func fbtEdit(file, session string) Dict {
	return Dict{"session_id": session, "tool_name": "Edit", "tool_input": Dict{"file_path": file, "old_string": "a", "new_string": "b"}, "tool_response": Dict{}}
}

// withFileDirs は feedback ディレクトリとプロジェクトを作って body に渡す。
func withFileDirs(body func(proj, fb string)) {
	WithTmp(func(tmp string) {
		proj := filepath.Join(tmp, "proj")
		fb := filepath.Join(tmp, "fb")
		must(os.MkdirAll(proj, 0o755))
		must(os.MkdirAll(fb, 0o755))
		body(proj, fb)
	})
}

func fbtFileIo(proj, fb string, lang ...Lang) Io {
	opts := IoOpts{ProjectDir: proj, Env: EnvVars{ClaudeFeedbackDir: fb}}
	if len(lang) > 0 {
		opts.Lang = lang[0]
	}
	return MakeIo(opts)
}

func TestFilesKeyParsingAndMatching(t *testing.T) {
	t.Run("files / exclude_files are read as string or list; RulesForFile matches project-relative paths", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "go_errors", 3, "files: '**/*.go'\nexclude_files: ['**/*_test.go']\n")
			fbtFileRule(fb, "py_types", 3, "files: ['**/*.py', '**/*.pyi']\n")
			fbtFileRule(fb, "everywhere", 3, "")
			io := fbtFileIo(proj, fb)
			rules, err := ListRules(io)
			require.NoError(t, err)
			byName := map[string]Rule{}
			for _, r := range rules {
				byName[r.Name] = r
			}
			assert.Equal(t, []string{"**/*.go"}, byName["go_errors"].Files)
			assert.Equal(t, []string{"**/*_test.go"}, byName["go_errors"].ExcludeFiles)
			assert.Equal(t, []string{"**/*.py", "**/*.pyi"}, byName["py_types"].Files)
			assert.Empty(t, byName["everywhere"].Files)
			names := func(file string) []string { return fbtNames(RulesForFile(io, rules, file)) }
			assert.Equal(t, []string{"go_errors"}, names(filepath.Join(proj, "internal", "a.go")))
			assert.Equal(t, []string{"go_errors"}, names("internal/a.go"))
			assert.Empty(t, names(filepath.Join(proj, "internal", "a_test.go")))
			assert.Equal(t, []string{"py_types"}, names(filepath.Join(proj, "pkg", "x.pyi")))
			assert.Empty(t, names(filepath.Join(proj, "README.md")))
			// worktree の中はそのルート相対で判定する
			assert.Equal(t, []string{"go_errors"}, names(filepath.Join(proj, ".claude", "worktrees", "wt1", "cmd", "main.go")))
		})
	})

	t.Run("pre_edit / post_edit entries without path inherit files and exclude_files", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "go_errors", 3, strings.Join([]string{
				"files: '**/*.go'",
				"exclude_files: '**/*_test.go'",
				"enforce:",
				"  - event: pre_edit",
				"    when: 'return err$'",
				"    message: 'wrap'",
				"  - event: post_edit",
				"    path: 'cmd/**/*.go'",
				"    exclude_path: 'cmd/gen/**'",
				"    when: 'panic\\('",
				"    message: 'no panic'",
				"  - event: pre_bash",
				"    when: 'go test'",
				"    message: 'no manual tests'",
				"",
			}, "\n"))
			rules, err := ListRules(fbtFileIo(proj, fb))
			require.NoError(t, err)
			require.Len(t, rules, 1)
			e := rules[0].Enforce
			assert.Equal(t, []any{"**/*.go"}, e[0]["path"])
			assert.Equal(t, []any{"**/*_test.go"}, e[0]["exclude_path"])
			// 自分で path を書いた要素はそのまま
			assert.Equal(t, "cmd/**/*.go", e[1]["path"])
			assert.Equal(t, "cmd/gen/**", e[1]["exclude_path"])
			// pre_bash には関係ない
			assert.Nil(t, e[2]["path"])
		})
	})

	t.Run("InheritFiles leaves entries alone when the rule has no files", func(t *testing.T) {
		entries := []Dict{{"event": "pre_edit", "when": "x"}}
		assert.Equal(t, entries, InheritFiles(entries, nil, nil))
		assert.Equal(t, []Dict{{"event": "pre_edit", "when": "x", "path": []any{"**/*.go"}}}, InheritFiles(entries, []string{"**/*.go"}, nil))
	})

	t.Run("a rule with files is not injected on UserPromptSubmit; the others still are", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "go_errors", 5, "files: '**/*.go'\n")
			fbtFileRule(fb, "everywhere", 3, "")
			r := FeedbackInjectFor(fbtFileIo(proj, fb), "sess-1")
			assert.Contains(t, r.Stdout, "everywhere")
			assert.NotContains(t, r.Stdout, "go_errors")
		})
	})
}

func TestFeedbackFileInject(t *testing.T) {
	t.Run("Read of a matching file injects the rule once per turn; a new prompt lets it come again", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "go_errors", 3, "files: '**/*.go'\n")
			fbtFileRule(fb, "go_style", 4, "files: '**/*.go'\n")
			fbtFileRule(fb, "everywhere", 3, "")
			fbtFileRule(fb, "provisional", 1, "files: '**/*.go'\n")
			io := fbtFileIo(proj, fb, LangJA)
			file := filepath.Join(proj, "internal", "a.go")

			first := FeedbackFileInject(io, fbtRead(file, "sess-1"))
			assert.Equal(t, 0, first.ExitCode)
			text := fbtContext(t, first.Stdout)
			assert.True(t, strings.HasPrefix(text, "# internal/a.go に適用されるフィードバックルール\n今読んだファイル"), text)
			// count 降順
			assert.Less(t, strings.Index(text, "■ go_style (これまで 4 回指摘されています)"), strings.Index(text, "■ go_errors (これまで 3 回指摘されています)"))
			assert.Contains(t, text, "go_errors の本文の第一段落。")
			assert.NotContains(t, text, "everywhere")
			assert.NotContains(t, text, "provisional")
			assert.NotContains(t, text, "**Why**")
			assert.True(t, Exists(InjectStatePath(io, "sess-1")))

			// 同じターンの 2 回目（別の Go ファイルでも）は出ない
			assert.Equal(t, "", FeedbackFileInject(io, fbtRead(filepath.Join(proj, "internal", "b.go"), "sess-1")).Stdout)
			assert.Equal(t, "", FeedbackFileInject(io, fbtEdit(file, "sess-1")).Stdout)

			// 新しいプロンプトで状態が消え、また出る
			FeedbackInjectFor(io, "sess-1")
			assert.False(t, Exists(InjectStatePath(io, "sess-1")))
			next := FeedbackFileInject(io, fbtEdit(file, "sess-1"))
			assert.True(t, strings.HasPrefix(fbtContext(t, next.Stdout), "# internal/a.go に適用されるフィードバックルール\n今編集したファイル"))
		})
	})

	t.Run("the header follows the language and names the file; a relative file_path is resolved against the project", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "go_errors", 3, "files: '**/*.go'\n")
			en := FeedbackFileInject(fbtFileIo(proj, fb, LangEN), fbtRead(filepath.Join(proj, "a.go"), "sess-1"))
			text := fbtContext(t, en.Stdout)
			assert.True(t, strings.HasPrefix(text, "# Feedback rules for a.go\nThese confirmed rules apply to the file you just read."), text)
			assert.Contains(t, text, "■ go_errors (pointed out 3 times so far)")
			rel := FeedbackFileInject(fbtFileIo(proj, fb, LangEN), fbtRead("b.go", "sess-2"))
			assert.Contains(t, fbtContext(t, rel.Stdout), "# Feedback rules for b.go")
		})
	})

	t.Run("non-matching files, other tools and rules below count 3 produce nothing", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "go_errors", 3, "files: '**/*.go'\nexclude_files: '**/*_test.go'\n")
			fbtFileRule(fb, "py_low", 2, "files: '**/*.py'\n")
			io := fbtFileIo(proj, fb)
			assert.Equal(t, "", FeedbackFileInject(io, fbtRead(filepath.Join(proj, "a.py"), "s")).Stdout)
			assert.Equal(t, "", FeedbackFileInject(io, fbtRead(filepath.Join(proj, "a_test.go"), "s")).Stdout)
			assert.Equal(t, "", FeedbackFileInject(io, Dict{"session_id": "s", "tool_name": "Glob", "tool_input": Dict{"pattern": "**/*.go"}}).Stdout)
			assert.Equal(t, "", FeedbackFileInject(io, Dict{"session_id": "s", "tool_name": "Read", "tool_input": Dict{}}).Stdout)
			assert.False(t, Exists(InjectStatePath(io, "s")))
		})
	})

	t.Run("Bash: the targets of plain heredoc writes are treated like Write; other commands are not", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "sql_down", 3, "files: 'migrations/*.sql'\n")
			io := fbtFileIo(proj, fb, LangEN)
			bash := func(command, session string) Dict {
				return Dict{"session_id": session, "cwd": proj, "tool_name": "Bash", "tool_input": Dict{"command": command}, "tool_response": Dict{}}
			}
			r := FeedbackFileInject(io, bash("cat > migrations/001_up.sql <<'EOF'\nCREATE TABLE t (id int);\nEOF", "s1"))
			text := fbtContext(t, r.Stdout)
			assert.Contains(t, text, "# Feedback rules for migrations/001_up.sql")
			assert.Contains(t, text, "the file you just edited")
			assert.Equal(t, "", FeedbackFileInject(io, bash("python gen.py > migrations/002_up.sql", "s2")).Stdout)
			assert.Equal(t, "", FeedbackFileInject(io, bash("ls migrations", "s3")).Stdout)
		})
	})

	t.Run("subagents keep their own state; the parent prompt clears it too", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "go_errors", 3, "files: '**/*.go'\n")
			io := fbtFileIo(proj, fb)
			file := filepath.Join(proj, "a.go")
			assert.Contains(t, fbtContext(t, FeedbackFileInject(io, fbtRead(file, "sess-1")).Stdout), "go_errors")
			assert.Contains(t, fbtContext(t, FeedbackFileInject(io, fbtRead(file, "sess-1", "agent-9")).Stdout), "go_errors")
			assert.True(t, Exists(InjectStatePath(io, "sess-1--agent-9")))
			FeedbackInjectFor(io, "sess-1")
			assert.False(t, Exists(InjectStatePath(io, "sess-1--agent-9")))
		})
	})

	t.Run("without a session id nothing is remembered, so the rule is shown every time", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "go_errors", 3, "files: '**/*.go'\n")
			io := fbtFileIo(proj, fb)
			payload := Dict{"tool_name": "Read", "tool_input": Dict{"file_path": filepath.Join(proj, "a.go")}}
			assert.Contains(t, fbtContext(t, FeedbackFileInject(io, payload).Stdout), "go_errors")
			assert.Contains(t, fbtContext(t, FeedbackFileInject(io, payload).Stdout), "go_errors")
		})
	})

	t.Run("inactive rules (projects / expires) are never injected", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "elsewhere", 3, "files: '**/*.go'\nprojects: ['/no/such/dir/**']\n")
			fbtFileRule(fb, "expired", 3, "files: '**/*.go'\nexpires: 2020-01-01\n")
			assert.Equal(t, "", FeedbackFileInject(fbtFileIo(proj, fb), fbtRead(filepath.Join(proj, "a.go"), "s")).Stdout)
		})
	})

	t.Run("SessionStart clears the state on startup / clear / compact and keeps it on resume", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "go_errors", 3, "files: '**/*.go'\n")
			io := fbtFileIo(proj, fb)
			file := filepath.Join(proj, "a.go")
			for _, source := range []string{"startup", "clear", "compact"} {
				FeedbackFileInject(io, fbtRead(file, "sess-1"))
				assert.True(t, Exists(InjectStatePath(io, "sess-1")))
				ResetGate(io, Dict{"session_id": "sess-1", "source": source})
				assert.False(t, Exists(InjectStatePath(io, "sess-1")), source)
			}
			FeedbackFileInject(io, fbtRead(file, "sess-1"))
			ResetGate(io, Dict{"session_id": "sess-1", "source": "resume"})
			assert.True(t, Exists(InjectStatePath(io, "sess-1")))
			// 他のセッションの状態には触らない
			FeedbackFileInject(io, fbtRead(file, "sess-2"))
			ResetGate(io, Dict{"session_id": "sess-1", "source": "clear"})
			assert.True(t, Exists(InjectStatePath(io, "sess-2")))
			// 24h 超のものは掃除される
			old := time.Unix(1, 0)
			require.NoError(t, os.Chtimes(InjectStatePath(io, "sess-2"), old, old))
			ResetGate(io, Dict{"session_id": "sess-3", "source": "resume"})
			assert.False(t, Exists(InjectStatePath(io, "sess-2")))
		})
	})

	t.Run("PostToolUse wiring: Read and Edit carry the context; Edit also runs post_edit", func(t *testing.T) {
		withFileDirs(func(proj, fb string) {
			fbtFileRule(fb, "go_errors", 3, "files: '**/*.go'\n")
			io := fbtFileIo(proj, fb, LangEN)
			file := filepath.Join(proj, "a.go")
			r := PostToolUse(io, "sess-1", fbtRead(file, "sess-1"))
			require.Len(t, r.Outcome.AdditionalContext, 1)
			assert.Contains(t, r.Outcome.AdditionalContext[0], "# Feedback rules for a.go")
			again := PostToolUse(io, "sess-1", fbtEdit(file, "sess-1"))
			assert.Empty(t, again.Outcome.AdditionalContext)
			// UserPromptSubmit で状態が消える
			UserPromptSubmit(io, "sess-1", PluginOptions{})
			assert.False(t, Exists(InjectStatePath(io, "sess-1")))
		})
	})
}
