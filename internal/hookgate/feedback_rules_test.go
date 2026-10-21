package hookgate

// tests/feedback-rules.spec.ts の移植。

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func fbtRule(name string, count int, enforce ...Dict) Rule {
	return Rule{Name: name, Count: count, Description: "", Enforce: enforce, Path: "", Projects: []string{}, WhenExists: []string{}}
}

// fbtIoFor は ioFor(projectDir, feedbackDir = projectDir)。
func fbtIoFor(projectDir string, feedbackDir ...string) Io {
	fb := projectDir
	if len(feedbackDir) > 0 {
		fb = feedbackDir[0]
	}
	return MakeIo(IoOpts{ProjectDir: projectDir, Env: EnvVars{ClaudeFeedbackDir: fb}})
}

func fbtWrite(p, content string) {
	must(os.MkdirAll(filepath.Dir(p), 0o755))
	must(os.WriteFile(p, []byte(content), 0o644))
}

func fbtNames(rules []Rule) []string {
	out := []string{}
	for _, r := range rules {
		out = append(out, r.Name)
	}
	return out
}

func fbtViolationRules(vs []Violation) []string {
	out := []string{}
	for _, v := range vs {
		out = append(out, v.Rule)
	}
	return out
}

func fbtGit(t *testing.T, cwd string, args ...string) {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), "git", args...)
	cmd.Dir = cwd
	require.NoError(t, cmd.Run())
}

func fbtInitRepo(t *testing.T, dir string) {
	t.Helper()
	fbtGit(t, dir, "init", "-q")
	fbtGit(t, dir, "config", "user.email", "t@example.com")
	fbtGit(t, dir, "config", "user.name", "t")
}

func TestListRulesRealFeedbackDir(t *testing.T) {
	// ~/.claude/feedback/ は利用者ごとの実ファイルなので、CI など存在しない環境ではスキップする。
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory")
	}
	realDir := filepath.Join(home, ".claude", "feedback")
	if !Exists(realDir) {
		t.Skip("no real ~/.claude/feedback")
	}
	t.Run("reads exactly the md files that have frontmatter", func(t *testing.T) {
		expected := []string{}
		entries, err := os.ReadDir(realDir)
		require.NoError(t, err)
		fmRe := regexp.MustCompile(`(?s)^---\n(.*?\n)---\n`)
		nameRe := regexp.MustCompile(`(?m)^name:\s*(\S+)\s*$`)
		for _, e := range entries {
			if !strings.HasSuffix(e.Name(), ".md") {
				continue
			}
			b, err := os.ReadFile(filepath.Join(realDir, e.Name()))
			require.NoError(t, err)
			m := fmRe.FindStringSubmatch(string(b))
			if m == nil {
				continue
			}
			if nm := nameRe.FindStringSubmatch(m[1]); nm != nil {
				expected = append(expected, nm[1])
			}
		}
		rules, err := ListRules(fbtIoFor(os.TempDir()), realDir)
		require.NoError(t, err)
		got := fbtNames(rules)
		sort.Strings(got)
		sort.Strings(expected)
		// Set の比較（重複した名前は 1 つにまとめる）
		assert.Equal(t, fbtUniqStrings(expected), fbtUniqStrings(got))
	})

	t.Run("each rule has name and count", func(t *testing.T) {
		rules, err := ListRules(fbtIoFor(os.TempDir()), realDir)
		require.NoError(t, err)
		for _, r := range rules {
			assert.NotEmpty(t, r.Name)
		}
	})
}

func fbtUniqStrings(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func TestLogViolation(t *testing.T) {
	t.Run("does not change the source rule file (count is never rewritten)", func(t *testing.T) {
		WithTmp(func(dir string) {
			WithTmp(func(logDir string) {
				file := filepath.Join(dir, "tdd.md")
				fbtWrite(file, "---\nname: tdd\ncount: 6\n---\nbody\n")
				before := Read(file)
				LogViolation(fbtIoFor(dir, logDir), "tdd", 6, "ask", "pre_edit", "test")
				assert.Equal(t, before, Read(file))
				var entry Dict
				require.NoError(t, json.Unmarshal([]byte(strings.TrimSpace(Read(filepath.Join(logDir, ".violations.jsonl")))), &entry))
				assert.Equal(t, "tdd", entry["rule"])
				assert.EqualValues(t, 6, entry["count"])
				assert.Equal(t, "ask", entry["severity"])
				assert.Equal(t, "pre_edit", entry["event"])
				assert.Equal(t, "test", entry["detail"])
				assert.Regexp(t, `\+00:00$`, Str(entry["ts"]))
			})
		})
	})
}

// 利用者の実ルールに依存していた回帰テスト（golang_conventions / verify_via_hooks）を、同じ形のルールを
// frontmatter から読む自己完結のテストにしたもの。
func TestGolangConventionsStyleDirectoryRule(t *testing.T) {
	frontmatter := strings.Join([]string{
		"name: golang_conventions",
		"description: d",
		"type: feedback",
		"count: 5",
		"enforce:",
		"  - event: pre_edit",
		"    path: 'pkg/**/*.go'",
		"    exclude_path:",
		"      - '**/*_test.go'",
		"      - 'pkg/{config,cmd,domain,infrastructure,interfaces,services,internal,tests}/**'",
		"    when: '[\\s\\S]'",
		"    message: '構成に従うこと'",
		"    severity: warn",
		"",
	}, "\n")

	t.Run("block sequence exclude_path is read as a list", func(t *testing.T) {
		parsed, err := ParseYaml(frontmatter)
		require.NoError(t, err)
		entry := parsed.(Dict)["enforce"].([]any)[0].(Dict)
		list, ok := entry["exclude_path"].([]any)
		assert.True(t, ok)
		assert.Contains(t, list, "**/*_test.go")
	})

	t.Run("test file is not flagged and non-test is warn only", func(t *testing.T) {
		WithTmp(func(tmp string) {
			fbtWrite(filepath.Join(tmp, "golang_conventions.md"), "---\n"+frontmatter+"---\n\n本文\n")
			io := fbtIoFor(tmp)
			rules, err := ListRules(io)
			require.NoError(t, err)
			require.Len(t, rules, 1)
			handler := filepath.Join(tmp, "pkg", "handler")
			require.NoError(t, os.MkdirAll(handler, 0o755))
			assert.Empty(t, EvalPreEdit(io, rules, filepath.Join(handler, "server_test.go"), "package handler", tmp))
			v := EvalPreEdit(io, rules, filepath.Join(handler, "server.go"), "package handler", tmp)
			require.Len(t, v, 1)
			assert.Equal(t, "warn", v[0].Severity)
		})
	})
}

func TestWrapperPrefixedCommandRule(t *testing.T) {
	when := `(^|&&|\|\||;)\s*(mise\s+(exec|x)\s+--\s+|uv\s+run\s+|bundle\s+exec\s+|env\s+\S+=\S+\s+)?(pytest|go test|rspec)\b`
	r := fbtRule("verify_via_hooks", 6, Dict{"event": "pre_bash", "when": when, "message": "hookに任せる", "severity": "deny"})
	io := fbtIoFor(os.TempDir())

	t.Run("wrapper prefixed commands are denied", func(t *testing.T) {
		for _, command := range []string{"mise exec -- pytest tests", "mise x -- go test ./...", "uv run pytest", "env FOO=1 pytest tests", "bundle exec rspec"} {
			v := EvalPreBash(io, []Rule{r}, command)
			require.NotEmpty(t, v, command)
			assert.Equal(t, "deny", v[0].Severity)
		}
	})

	t.Run("shows the rule being evaluated when running a check command", func(t *testing.T) {
		progress := []string{}
		withCheck := fbtRule("chk_rule", 6, Dict{"event": "pre_bash", "when": "rm", "check": "false", "message": "m", "severity": "deny"})
		v := EvalPreBash(MakeIo(IoOpts{ProjectDir: os.TempDir(), ProgressLog: &progress}), []Rule{withCheck}, "rm x")
		assert.Len(t, v, 1)
		assert.Equal(t, []string{"[feedback-guard] 評価中: chk_rule"}, progress)
	})

	t.Run("mise run task is not denied", func(t *testing.T) {
		for _, command := range []string{"mise run test", "mise run lint"} {
			assert.Empty(t, EvalPreBash(io, []Rule{r}, command))
		}
	})

	t.Run("bare command is still denied", func(t *testing.T) {
		v := EvalPreBash(io, []Rule{r}, "pytest tests")
		require.NotEmpty(t, v)
		assert.Equal(t, "deny", v[0].Severity)
	})

	t.Run("wrapper name without tool is not a false positive", func(t *testing.T) {
		assert.Empty(t, EvalPreBash(io, []Rule{r}, "mise exec -- echo hi"))
	})
}

func TestFrontmatterParser(t *testing.T) {
	sample := strings.Join([]string{
		"name: sample_rule",
		"description: サンプルの説明",
		"type: feedback",
		"count: 4",
		"enforce:",
		"  - event: pre_bash",
		"    when: 'go (test|vet)\\b'",
		"    unless: '--dry-run'",
		"    message: 'テストはhookに任せること'",
		"    severity: deny",
		"  - event: pre_edit",
		"    path: '**/*.go'",
		"    absent_sibling: '{stem}_test.go'",
		"    message: 'テストファイルが先'",
		"    severity: ask",
		"  - event: stop_check",
		"    changed: '**/README.md'",
		"    require_sibling: 'README_ja.md'",
		"    message: '日英併記のこと'",
		"    severity: block",
		"",
	}, "\n")
	parse := func(t *testing.T, text string) Dict {
		t.Helper()
		v, err := ParseYaml(text)
		require.NoError(t, err)
		return v.(Dict)
	}

	t.Run("parses scalars and enforce list", func(t *testing.T) {
		data := parse(t, sample)
		assert.Equal(t, "sample_rule", data["name"])
		assert.Equal(t, "サンプルの説明", data["description"])
		assert.Equal(t, 4, data["count"])
		list, ok := data["enforce"].([]any)
		assert.True(t, ok)
		assert.Len(t, list, 3)
	})

	t.Run("preserves regex backslashes in single quotes", func(t *testing.T) {
		entry := parse(t, sample)["enforce"].([]any)[0].(Dict)
		assert.Equal(t, "pre_bash", entry["event"])
		assert.Equal(t, `go (test|vet)\b`, entry["when"])
		assert.Equal(t, "--dry-run", entry["unless"])
		assert.Equal(t, "deny", entry["severity"])
	})

	t.Run("handles nested pre_edit and stop_check entries", func(t *testing.T) {
		enforce := parse(t, sample)["enforce"].([]any)
		e1, e2 := enforce[1].(Dict), enforce[2].(Dict)
		assert.Equal(t, "**/*.go", e1["path"])
		assert.Equal(t, "{stem}_test.go", e1["absent_sibling"])
		assert.Equal(t, "**/README.md", e2["changed"])
		assert.Equal(t, "README_ja.md", e2["require_sibling"])
	})

	t.Run("exclude_path block sequence", func(t *testing.T) {
		text := strings.Join([]string{
			"name: tdd",
			"count: 7",
			"enforce:",
			"  - event: pre_edit",
			"    path: '**/*.go'",
			"    exclude_path:",
			"      - '**/interfaces/**'",
			"      - '**/*_iface.go'",
			"    absent_sibling: '{stem}_test.go'",
			"",
		}, "\n")
		e := parse(t, text)["enforce"].([]any)[0].(Dict)
		assert.Equal(t, []any{"**/interfaces/**", "**/*_iface.go"}, e["exclude_path"])
		assert.Equal(t, "{stem}_test.go", e["absent_sibling"])
	})
}

func TestLoadRuleListRules(t *testing.T) {
	write := func(tmp, name, content string) string {
		p := filepath.Join(tmp, name)
		fbtWrite(p, content)
		return p
	}

	t.Run("skips file without frontmatter", func(t *testing.T) {
		WithTmp(func(tmp string) {
			p := write(tmp, "rules.md", "# グローバルルール\n\n本文だけで frontmatter が無い\n")
			_, ok, err := LoadRule(fbtIoFor(tmp), p)
			require.NoError(t, err)
			assert.False(t, ok)
		})
	})

	t.Run("parses minimal rule without enforce", func(t *testing.T) {
		WithTmp(func(tmp string) {
			p := write(tmp, "foo.md", "---\nname: foo\ndescription: foo desc\ntype: feedback\ncount: 2\n---\n\n本文\n")
			r, ok, err := LoadRule(fbtIoFor(tmp), p)
			require.NoError(t, err)
			require.True(t, ok)
			assert.Equal(t, "foo", r.Name)
			assert.Equal(t, 2, r.Count)
			assert.Equal(t, []Dict{}, r.Enforce)
		})
	})

	t.Run("listRules on directory", func(t *testing.T) {
		WithTmp(func(tmp string) {
			write(tmp, "a.md", "---\nname: a\ndescription: d\ntype: feedback\ncount: 1\n---\nbody\n")
			write(tmp, "b.md", "---\nname: b\ndescription: d\ntype: feedback\ncount: 5\n---\nbody\n")
			write(tmp, "rules.md", "# no frontmatter\n")
			rules, err := ListRules(fbtIoFor(tmp))
			require.NoError(t, err)
			names := fbtNames(rules)
			sort.Strings(names)
			assert.Equal(t, []string{"a", "b"}, names)
		})
	})

	t.Run("project .claude/feedback", func(t *testing.T) {
		ruleText := func(name string, count int) string {
			return "---\nname: " + name + "\ndescription: d\ntype: feedback\ncount: " + string(rune('0'+count)) + "\n---\nbody\n"
		}
		type layout struct {
			globalDir, projectDir, projectFeedback string
			io                                     Io
		}
		setup := func(tmp string) layout {
			globalDir := filepath.Join(tmp, "global")
			projectDir := filepath.Join(tmp, "project")
			projectFeedback := ProjectFeedbackDir(MakeIo(IoOpts{ProjectDir: projectDir}))
			require.NoError(t, os.MkdirAll(globalDir, 0o755))
			require.NoError(t, os.MkdirAll(projectFeedback, 0o755))
			return layout{globalDir, projectDir, projectFeedback, fbtIoFor(projectDir, globalDir)}
		}

		t.Run("reads project .claude/feedback/*.md in addition to global", func(t *testing.T) {
			WithTmp(func(tmp string) {
				l := setup(tmp)
				globalDir, projectFeedback, io := l.globalDir, l.projectFeedback, l.io
				fbtWrite(filepath.Join(globalDir, "g.md"), ruleText("g", 3))
				fbtWrite(filepath.Join(projectFeedback, "p.md"), ruleText("p", 4))
				rules, err := ListRules(io)
				require.NoError(t, err)
				assert.Equal(t, []string{"g", "p"}, fbtNames(rules))
			})
		})

		t.Run("project rule wins over global rule with the same name", func(t *testing.T) {
			WithTmp(func(tmp string) {
				l := setup(tmp)
				globalDir, projectFeedback, io := l.globalDir, l.projectFeedback, l.io
				fbtWrite(filepath.Join(globalDir, "dup.md"), ruleText("dup", 3))
				fbtWrite(filepath.Join(globalDir, "only-g.md"), ruleText("only-g", 3))
				fbtWrite(filepath.Join(projectFeedback, "dup.md"), ruleText("dup", 5))
				rules, err := ListRules(io)
				require.NoError(t, err)
				dups := []Rule{}
				for _, r := range rules {
					if r.Name == "dup" {
						dups = append(dups, r)
					}
				}
				require.Len(t, dups, 1)
				assert.Equal(t, 5, dups[0].Count)
				assert.Equal(t, filepath.Join(projectFeedback, "dup.md"), dups[0].Path)
				assert.Equal(t, []string{"only-g", "dup"}, fbtNames(rules))
			})
		})

		t.Run("explicit feedbackDirPath does not read the project directory", func(t *testing.T) {
			WithTmp(func(tmp string) {
				l := setup(tmp)
				globalDir, projectFeedback, io := l.globalDir, l.projectFeedback, l.io
				fbtWrite(filepath.Join(globalDir, "g.md"), ruleText("g", 3))
				fbtWrite(filepath.Join(projectFeedback, "p.md"), ruleText("p", 3))
				rules, err := ListRules(io, globalDir)
				require.NoError(t, err)
				assert.Equal(t, []string{"g"}, fbtNames(rules))
			})
		})

		t.Run("same directory for global and project is read only once", func(t *testing.T) {
			WithTmp(func(tmp string) {
				projectDir := filepath.Join(tmp, "same")
				projectFeedback := ProjectFeedbackDir(MakeIo(IoOpts{ProjectDir: projectDir}))
				require.NoError(t, os.MkdirAll(projectFeedback, 0o755))
				fbtWrite(filepath.Join(projectFeedback, "a.md"), ruleText("a", 3))
				rules, err := ListRules(fbtIoFor(projectDir, projectFeedback))
				require.NoError(t, err)
				assert.Equal(t, []string{"a"}, fbtNames(rules))
			})
		})
	})
}

func TestExpiresProjectsWhenExists(t *testing.T) {
	T := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC).UnixMilli()
	parseMs := func(s string) int64 {
		tm, err := time.Parse(time.RFC3339Nano, s)
		require.NoError(t, err)
		return tm.UnixMilli()
	}

	type namesOpts struct {
		projectDir string
		now        int64
		home       string
	}
	// グローバル用ディレクトリに name のルールを書き、ListRules（マージ経路）で返る名前を返す。
	names := func(t *testing.T, tmp string, extra []string, o namesOpts) []string {
		t.Helper()
		globalDir := filepath.Join(tmp, "global")
		require.NoError(t, os.MkdirAll(globalDir, 0o755))
		fbtWrite(filepath.Join(globalDir, "r.md"), "---\nname: r\ndescription: d\ntype: feedback\ncount: 3\n"+strings.Join(extra, "\n")+"\n---\nbody\n")
		projectDir := o.projectDir
		if projectDir == "" {
			projectDir = filepath.Join(tmp, "project")
		}
		require.NoError(t, os.MkdirAll(projectDir, 0o755))
		opts := IoOpts{ProjectDir: projectDir, Env: EnvVars{ClaudeFeedbackDir: globalDir, Home: o.home}}
		if o.now != 0 {
			now := o.now
			opts.Now = func() int64 { return now }
		}
		rules, err := ListRules(MakeIo(opts))
		require.NoError(t, err)
		return fbtNames(rules)
	}
	r := []string{"r"}
	none := []string{}

	t.Run("loadRule reads the three keys", func(t *testing.T) {
		WithTmp(func(tmp string) {
			p := filepath.Join(tmp, "x.md")
			fbtWrite(p, "---\nname: x\nexpires: 2026-12-31T10:00:00Z\nprojects: '~/a/**'\nwhen_exists: ['go.mod', '**/*.go']\n---\n")
			rule, ok, err := LoadRule(fbtIoFor(tmp), p)
			require.NoError(t, err)
			require.True(t, ok)
			require.NotNil(t, rule.Expires)
			assert.Equal(t, parseMs("2026-12-31T10:00:00Z"), *rule.Expires)
			assert.Equal(t, []string{"~/a/**"}, rule.Projects)
			assert.Equal(t, []string{"go.mod", "**/*.go"}, rule.WhenExists)
		})
	})

	t.Run("expires in the future is active, in the past is excluded", func(t *testing.T) {
		WithTmp(func(tmp string) {
			assert.Equal(t, r, names(t, tmp, []string{"expires: 2026-12-31T00:00:00Z"}, namesOpts{now: T}))
			assert.Equal(t, none, names(t, tmp, []string{"expires: 2026-01-01T00:00:00Z"}, namesOpts{now: T}))
		})
	})

	t.Run("YYYY-MM-DD is valid until the end of that day", func(t *testing.T) {
		WithTmp(func(tmp string) {
			assert.Equal(t, r, names(t, tmp, []string{"expires: 2026-06-15"}, namesOpts{now: parseMs("2026-06-15T23:59:59.999Z")}))
			assert.Equal(t, none, names(t, tmp, []string{"expires: 2026-06-15"}, namesOpts{now: parseMs("2026-06-16T00:00:00Z")}))
			// 引用符付き（文字列）でも同じ
			assert.Equal(t, r, names(t, tmp, []string{"expires: '2026-06-15'"}, namesOpts{now: parseMs("2026-06-15T23:59:59.999Z")}))
		})
	})

	t.Run("YYYY/MM/DD (V8 Date.parse) is read like the dashed form", func(t *testing.T) {
		WithTmp(func(tmp string) {
			assert.Equal(t, none, names(t, tmp, []string{"expires: \"2020/01/01\""}, namesOpts{now: T}))
			assert.Equal(t, none, names(t, tmp, []string{"expires: 2020/1/1"}, namesOpts{now: T}))
			assert.Equal(t, r, names(t, tmp, []string{"expires: 2026/06/15"}, namesOpts{now: parseMs("2026-06-15T23:59:59.999Z")}))
			assert.Equal(t, none, names(t, tmp, []string{"expires: 2026/06/15"}, namesOpts{now: parseMs("2026-06-16T00:00:00Z")}))
			assert.Equal(t, r, names(t, tmp, []string{"expires: '2026/06/15 10:00'"}, namesOpts{now: parseMs("2026-06-15T10:00:00Z")}))
			assert.Equal(t, none, names(t, tmp, []string{"expires: '2026/06/15 10:00:30'"}, namesOpts{now: parseMs("2026-06-15T10:00:31Z")}))
		})
	})

	t.Run("unparsable expires is treated as no expiry", func(t *testing.T) {
		WithTmp(func(tmp string) {
			assert.Equal(t, r, names(t, tmp, []string{"expires: not-a-date"}, namesOpts{now: T}))
			assert.Equal(t, r, names(t, tmp, []string{"expires: '2020/13/01'"}, namesOpts{now: T}))
			assert.Equal(t, r, names(t, tmp, []string{"expires: '2020/01/01T10:00'"}, namesOpts{now: T}))
		})
	})

	t.Run("projects: matches the project directory, excludes otherwise", func(t *testing.T) {
		WithTmp(func(tmp string) {
			projectDir := filepath.Join(tmp, "src", "myorg", "app")
			o := namesOpts{projectDir: projectDir}
			assert.Equal(t, r, names(t, tmp, []string{"projects: ['" + tmp + "/src/myorg/**']"}, o))
			assert.Equal(t, r, names(t, tmp, []string{"projects: '" + tmp + "/src/myorg/**'"}, o))
			assert.Equal(t, none, names(t, tmp, []string{"projects: ['" + tmp + "/other/**']"}, o))
			assert.Equal(t, r, names(t, tmp, []string{"projects: ['" + tmp + "/other/**', '" + tmp + "/src/**']"}, o))
			assert.Equal(t, r, names(t, tmp, []string{"projects: []"}, o))
		})
	})

	t.Run("projects: leading ~ is expanded to HOME", func(t *testing.T) {
		WithTmp(func(tmp string) {
			projectDir := filepath.Join(tmp, "src", "myorg", "app")
			o := namesOpts{projectDir: projectDir, home: tmp}
			assert.Equal(t, r, names(t, tmp, []string{"projects: ['~/src/myorg/**']"}, o))
			assert.Equal(t, none, names(t, tmp, []string{"projects: ['~/src/another/**']"}, o))
		})
	})

	t.Run("when_exists: active only if one of the globs exists", func(t *testing.T) {
		WithTmp(func(tmp string) {
			projectDir := filepath.Join(tmp, "project")
			require.NoError(t, os.MkdirAll(projectDir, 0o755))
			o := namesOpts{projectDir: projectDir}
			assert.Equal(t, none, names(t, tmp, []string{"when_exists: ['go.mod']"}, o))
			fbtWrite(filepath.Join(projectDir, "go.mod"), "module x\n")
			assert.Equal(t, r, names(t, tmp, []string{"when_exists: ['go.mod']"}, o))
			assert.Equal(t, r, names(t, tmp, []string{"when_exists: 'go.mod'"}, o))
			assert.Equal(t, r, names(t, tmp, []string{"when_exists: ['Cargo.toml', 'go.mod']"}, o))
			assert.Equal(t, none, names(t, tmp, []string{"when_exists: ['Cargo.toml']"}, o))
		})
	})

	t.Run("when_exists: recursive pattern", func(t *testing.T) {
		WithTmp(func(tmp string) {
			projectDir := filepath.Join(tmp, "project")
			o := namesOpts{projectDir: projectDir}
			assert.Equal(t, none, names(t, tmp, []string{"when_exists: ['**/*.go']"}, o))
			require.NoError(t, os.MkdirAll(filepath.Join(projectDir, "cmd", "app"), 0o755))
			fbtWrite(filepath.Join(projectDir, "cmd", "app", "main.go"), "package main\n")
			assert.Equal(t, r, names(t, tmp, []string{"when_exists: ['**/*.go']"}, o))
		})
	})

	t.Run("all three conditions must hold", func(t *testing.T) {
		WithTmp(func(tmp string) {
			projectDir := filepath.Join(tmp, "project")
			require.NoError(t, os.MkdirAll(projectDir, 0o755))
			fbtWrite(filepath.Join(projectDir, "go.mod"), "module x\n")
			okLines := []string{"projects: ['" + tmp + "/**']", "when_exists: ['go.mod']", "expires: 2026-12-31"}
			assert.Equal(t, r, names(t, tmp, okLines, namesOpts{projectDir: projectDir, now: T}))
			assert.Equal(t, none, names(t, tmp, okLines, namesOpts{projectDir: projectDir, now: parseMs("2027-01-01T00:00:00Z")}))
		})
	})

	t.Run("isRuleActive takes an explicit projectDir", func(t *testing.T) {
		WithTmp(func(tmp string) {
			dir := filepath.Join(tmp, "other")
			require.NoError(t, os.MkdirAll(dir, 0o755))
			fbtWrite(filepath.Join(dir, "go.mod"), "")
			rule := fbtRule("r", 3)
			rule.WhenExists = []string{"go.mod"}
			io := fbtIoFor(filepath.Join(tmp, "project"))
			active, err := IsRuleActive(io, rule)
			require.NoError(t, err)
			assert.False(t, active)
			active, err = IsRuleActive(io, rule, dir)
			require.NoError(t, err)
			assert.True(t, active)
		})
	})

	t.Run("explicit feedbackDirPath returns rules even when expired", func(t *testing.T) {
		WithTmp(func(tmp string) {
			dir := filepath.Join(tmp, "explicit")
			require.NoError(t, os.MkdirAll(dir, 0o755))
			fbtWrite(filepath.Join(dir, "r.md"), "---\nname: r\ncount: 3\nexpires: 2020-01-01\nprojects: [/nowhere/**]\n---\n")
			io := MakeIo(IoOpts{ProjectDir: tmp, Env: EnvVars{ClaudeFeedbackDir: dir}, Now: func() int64 { return T }})
			rules, err := ListRules(io, dir)
			require.NoError(t, err)
			assert.Equal(t, []string{"r"}, fbtNames(rules))
		})
	})

	t.Run("expired project rule does not resurrect the global rule of the same name", func(t *testing.T) {
		WithTmp(func(tmp string) {
			globalDir := filepath.Join(tmp, "global")
			projectDir := filepath.Join(tmp, "project")
			projectFeedback := ProjectFeedbackDir(MakeIo(IoOpts{ProjectDir: projectDir}))
			require.NoError(t, os.MkdirAll(globalDir, 0o755))
			require.NoError(t, os.MkdirAll(projectFeedback, 0o755))
			fbtWrite(filepath.Join(globalDir, "dup.md"), "---\nname: dup\ncount: 3\n---\n")
			fbtWrite(filepath.Join(projectFeedback, "dup.md"), "---\nname: dup\ncount: 5\nexpires: 2020-01-01\n---\n")
			io := MakeIo(IoOpts{ProjectDir: projectDir, Env: EnvVars{ClaudeFeedbackDir: globalDir}, Now: func() int64 { return T }})
			rules, err := ListRules(io)
			require.NoError(t, err)
			assert.Empty(t, rules)
		})
	})
}

func TestResolveSeverity(t *testing.T) {
	t.Run("count 6 and 5 are deny", func(t *testing.T) {
		assert.Equal(t, "deny", ResolveSeverity(6, nil, ""))
		assert.Equal(t, "deny", ResolveSeverity(5, nil, ""))
	})
	t.Run("count 4 is ask for pre events and block for stop_check", func(t *testing.T) {
		assert.Equal(t, "ask", ResolveSeverity(4, nil, "pre_bash"))
		assert.Equal(t, "ask", ResolveSeverity(4, nil, "pre_edit"))
		assert.Equal(t, "block", ResolveSeverity(4, nil, "stop_check"))
	})
	t.Run("count 4 and 3 are block for post_edit", func(t *testing.T) {
		assert.Equal(t, "block", ResolveSeverity(4, nil, "post_edit"))
		assert.Equal(t, "block", ResolveSeverity(3, nil, "post_edit"))
	})
	t.Run("count 3 matches same boundaries as 4", func(t *testing.T) {
		assert.Equal(t, "ask", ResolveSeverity(3, nil, "pre_bash"))
		assert.Equal(t, "block", ResolveSeverity(3, nil, "stop_check"))
	})
	t.Run("count 2 and 1 are warn", func(t *testing.T) {
		assert.Equal(t, "warn", ResolveSeverity(2, nil, "pre_bash"))
		assert.Equal(t, "warn", ResolveSeverity(1, nil, "stop_check"))
		assert.Equal(t, "warn", ResolveSeverity(2, nil, "post_edit"))
	})
	t.Run("count 5 is deny for post_edit", func(t *testing.T) {
		assert.Equal(t, "deny", ResolveSeverity(5, nil, "post_edit"))
	})
	t.Run("explicit severity overrides count", func(t *testing.T) {
		assert.Equal(t, "warn", ResolveSeverity(6, "warn", ""))
		assert.Equal(t, "deny", ResolveSeverity(1, "deny", ""))
	})
}

func TestFeedbackGlobHelpers(t *testing.T) {
	t.Run("double star crosses directories, single star does not", func(t *testing.T) {
		rx := regexp.MustCompile(GlobToRegex("**/*.go"))
		assert.True(t, rx.MatchString("pkg/domain/foo.go"))
		assert.True(t, rx.MatchString("foo.go"))
		rx2 := regexp.MustCompile(GlobToRegex("*.go"))
		assert.False(t, rx2.MatchString("pkg/foo.go"))
		assert.True(t, rx2.MatchString("foo.go"))
	})

	t.Run("brace expansion", func(t *testing.T) {
		assert.ElementsMatch(t, []string{"**/action.yml", "**/action.yaml"}, ExpandBraces("**/action.{yml,yaml}"))
	})

	t.Run("relativize strips project dir prefix", func(t *testing.T) {
		assert.Equal(t, ".github/workflows/ci.yml", Relativize("/repo/.github/workflows/ci.yml", "/repo"))
	})
}

func TestEvalPreBash(t *testing.T) {
	io := fbtIoFor(os.TempDir())
	goTest := func(count int) Rule {
		return fbtRule("dont_run_tests_manually", count, Dict{"event": "pre_bash", "when": `(^|&&|\|\||;)\s*go test\b`, "message": "hookに任せる", "severity": "deny"})
	}

	t.Run("go test is flagged", func(t *testing.T) {
		v := EvalPreBash(io, []Rule{goTest(6)}, "go test ./...")
		require.Len(t, v, 1)
		assert.Equal(t, "deny", v[0].Severity)
	})

	t.Run("unrelated string is not a false positive", func(t *testing.T) {
		assert.Empty(t, EvalPreBash(io, []Rule{goTest(6)}, "echo go test"))
	})

	t.Run("unless excludes draft PR", func(t *testing.T) {
		r := fbtRule("x", 2, Dict{"event": "pre_bash", "when": "gh pr create", "unless": "--draft", "message": "draftで作成", "severity": "warn"})
		assert.Empty(t, EvalPreBash(io, []Rule{r}, "gh pr create --draft"))
		v := EvalPreBash(io, []Rule{r}, "gh pr create")
		require.Len(t, v, 1)
		assert.Equal(t, "warn", v[0].Severity)
	})

	t.Run("check command confirms violation when nonzero", func(t *testing.T) {
		r := fbtRule("x", 1, Dict{"event": "pre_bash", "when": "git commit", "check": "exit 1", "message": "保護ブランチ", "severity": "warn"})
		assert.Len(t, EvalPreBash(io, []Rule{r}, "git commit -m x"), 1)
	})

	t.Run("check command zero exit means no violation", func(t *testing.T) {
		r := fbtRule("x", 1, Dict{"event": "pre_bash", "when": "git commit", "check": "exit 0", "message": "保護ブランチ", "severity": "warn"})
		assert.Empty(t, EvalPreBash(io, []Rule{r}, "git commit -m x"))
	})

	t.Run("python-style inline flags and named groups are translated", func(t *testing.T) {
		r := fbtRule("x", 1, Dict{"event": "pre_bash", "when": `(?i)(?P<tool>PYTEST)\b`, "message": "m", "severity": "warn"})
		assert.Len(t, EvalPreBash(io, []Rule{r}, "pytest -q"), 1)
	})
}

func TestEvalPreEdit(t *testing.T) {
	// 各テストは自分用の一時ディレクトリで走らせる（beforeEach / afterEach の代わり）。
	type env struct {
		tmp string
		io  Io
	}
	run := func(t *testing.T, body func(e env)) {
		t.Helper()
		WithTmp(func(tmp string) { body(env{tmp: tmp, io: fbtIoFor(tmp)}) })
	}
	touch := func(e env, parts ...string) string { return Touch(append([]string{e.tmp}, parts...)...) }
	tdd := func(extra Dict, count int, glob string) []Rule {
		entry := Dict{"event": "pre_edit", "path": glob, "message": "先にテストを書く", "severity": "ask"}
		for k, v := range extra {
			entry[k] = v
		}
		return []Rule{fbtRule("tdd", count, entry)}
	}
	tddGo := func(extra Dict) []Rule { return tdd(extra, 6, "**/*.go") }
	siblingGo := Dict{"absent_sibling": "{stem}_test.go"}
	merge := func(a, b Dict) Dict {
		out := Dict{}
		for k, v := range a {
			out[k] = v
		}
		for k, v := range b {
			out[k] = v
		}
		return out
	}
	rb := func(patterns any) []Rule { return tdd(Dict{"absent_glob": patterns}, 7, "**/*.rb") }
	py := func(patterns any) []Rule { return tdd(Dict{"absent_glob": patterns}, 7, "**/*.py") }
	check := func(e env, rules []Rule, file string, content ...string) []Violation {
		c := "x"
		if len(content) > 0 {
			c = content[0]
		}
		return EvalPreEdit(e.io, rules, file, c, e.tmp)
	}

	t.Run("missing test sibling is ask", func(t *testing.T) {
		run(t, func(e env) {
			v := check(e, tddGo(siblingGo), filepath.Join(e.tmp, "foo.go"), "package main")
			require.Len(t, v, 1)
			assert.Equal(t, "ask", v[0].Severity)
		})
	})

	t.Run("existing test sibling passes", func(t *testing.T) {
		run(t, func(e env) {
			foo := touch(e, "foo.go")
			touch(e, "foo_test.go")
			assert.Empty(t, check(e, tddGo(siblingGo), foo))
		})
	})

	t.Run("test file itself is excluded", func(t *testing.T) {
		run(t, func(e env) {
			assert.Empty(t, check(e, tddGo(siblingGo), touch(e, "foo_test.go")))
		})
	})

	t.Run("exclude_path skips absent_sibling check", func(t *testing.T) {
		run(t, func(e env) {
			iface := touch(e, "interfaces", "repo.go")
			assert.Empty(t, check(e, tddGo(merge(siblingGo, Dict{"exclude_path": []any{"**/interfaces/**", "**/*_iface.go"}})), iface))
		})
	})

	t.Run("exclude_path does not affect unmatched files", func(t *testing.T) {
		run(t, func(e env) {
			foo := touch(e, "foo.go")
			assert.Len(t, check(e, tddGo(merge(siblingGo, Dict{"exclude_path": []any{"**/interfaces/**"}})), foo), 1)
		})
	})

	t.Run("exclude_path accepts single string", func(t *testing.T) {
		run(t, func(e env) {
			assert.Empty(t, check(e, tddGo(merge(siblingGo, Dict{"exclude_path": "**/*_iface.go"})), touch(e, "svc_iface.go")))
		})
	})

	t.Run("exclude_path applies to when-pattern rules", func(t *testing.T) {
		run(t, func(e env) {
			f := filepath.Join(e.tmp, "gen", "x.go")
			r := []Rule{fbtRule("modern_go_map_any", 1, Dict{
				"event": "pre_edit", "path": "**/*.go", "exclude_path": "**/gen/**",
				"when": `interface\{\}`, "message": "anyを使う", "severity": "warn",
			})}
			assert.Empty(t, check(e, r, f, "var m map[string]interface{}"))
		})
	})

	t.Run("absent_glob finds spec in separate tree", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "app", "models", "user.rb")
			touch(e, "spec", "models", "user_spec.rb")
			assert.Empty(t, check(e, rb([]any{"{dir}/{stem}_spec.rb", "spec/**/{stem}_spec.rb"}), impl))
		})
	})

	t.Run("absent_glob flags when no candidate exists", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "app", "models", "user.rb")
			v := check(e, rb([]any{"{dir}/{stem}_spec.rb", "spec/**/{stem}_spec.rb"}), impl)
			require.Len(t, v, 1)
			assert.Equal(t, "ask", v[0].Severity)
		})
	})

	t.Run("absent_glob matches same directory candidate", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "lib", "user.rb")
			touch(e, "lib", "user_spec.rb")
			assert.Empty(t, check(e, rb([]any{"{dir}/{stem}_spec.rb", "spec/**/{stem}_spec.rb"}), impl))
		})
	})

	t.Run("absent_glob accepts single string", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "lib", "user.rb")
			touch(e, "spec", "user_spec.rb")
			assert.Empty(t, check(e, rb("spec/**/{stem}_spec.rb"), impl))
		})
	})

	t.Run("absent_glob handles project root file", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "user.rb")
			touch(e, "user_spec.rb")
			assert.Empty(t, check(e, rb([]any{"{dir}/{stem}_spec.rb"}), impl))
		})
	})

	t.Run("absent_glob skips test file itself", func(t *testing.T) {
		run(t, func(e env) {
			assert.Empty(t, check(e, rb([]any{"spec/**/{stem}_spec.rb"}), touch(e, "spec", "models", "user_spec.rb"), "describe User"))
		})
	})

	t.Run("absent_glob respects exclude_path", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "db", "migrate", "001_create_users.rb")
			r := tdd(Dict{"exclude_path": "**/db/migrate/**", "absent_glob": []any{"spec/**/{stem}_spec.rb"}}, 7, "**/*.rb")
			assert.Empty(t, check(e, r, impl))
		})
	})

	t.Run("absent_glob and absent_sibling are ORed", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "lib", "user.rb")
			touch(e, "lib", "user_spec.rb")
			r := tdd(Dict{"absent_sibling": "{stem}_spec.rb", "absent_glob": []any{"spec/**/{stem}_spec.rb"}}, 7, "**/*.rb")
			assert.Empty(t, check(e, r, impl))
		})
	})

	t.Run("absent_glob expands braces", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "src", "user.ts")
			touch(e, "src", "__tests__", "user.spec.ts")
			r := tdd(Dict{"absent_glob": []any{"{dir}/__tests__/{stem}.{test,spec}.ts"}}, 7, "**/*.ts")
			assert.Empty(t, check(e, r, impl))
		})
	})

	t.Run("absent_glob expands braces in directory part", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "src", "user.ts")
			touch(e, "tests", "unit", "user.test.ts")
			r := tdd(Dict{"absent_glob": []any{"{test,tests}/**/{stem}.{test,spec}.ts"}}, 7, "**/*.ts")
			assert.Empty(t, check(e, r, impl))
		})
	})

	t.Run("absent_glob matches snake_case test for kebab-case impl", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "hooks", "stop-gate.py")
			touch(e, "hooks", "tests", "test_stop_gate.py")
			assert.Empty(t, check(e, py([]any{"{dir}/tests/test_{stem}.py"}), impl))
		})
	})

	t.Run("absent_glob matches kebab-case test for snake_case impl", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "hooks", "stop_gate.py")
			touch(e, "hooks", "tests", "test_stop-gate.py")
			assert.Empty(t, check(e, py([]any{"{dir}/tests/test_{stem}.py"}), impl))
		})
	})

	t.Run("absent_sibling matches underscore variant for kebab-case impl", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "pkg", "my-handler.go")
			touch(e, "pkg", "my_handler_test.go")
			assert.Empty(t, check(e, tddGo(siblingGo), impl))
		})
	})

	t.Run("absent_glob with no separator stem still flags when missing", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "hooks", "gate.py")
			v := check(e, py([]any{"{dir}/tests/test_{stem}.py"}), impl)
			require.Len(t, v, 1)
			assert.Equal(t, "missing test file: hooks/tests/test_gate.py", v[0].Detail)
		})
	})

	t.Run("absent_glob kebab-case impl without any test still flags", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "hooks", "new-thing.py")
			v := check(e, py([]any{"{dir}/tests/test_{stem}.py"}), impl)
			require.Len(t, v, 1)
			assert.Contains(t, v[0].Detail, "test_new-thing.py")
			assert.Contains(t, v[0].Detail, "test_new_thing.py")
		})
	})

	t.Run("absent_sibling kebab-case impl without any test still flags", func(t *testing.T) {
		run(t, func(e env) {
			impl := touch(e, "pkg", "my-other.go")
			v := check(e, tddGo(siblingGo), impl)
			require.Len(t, v, 1)
			assert.Contains(t, v[0].Detail, "my-other_test.go")
			assert.Contains(t, v[0].Detail, "my_other_test.go")
		})
	})

	t.Run("spec and underscore test files are treated as test files", func(t *testing.T) {
		for _, name := range []string{"user.spec.ts", "user.spec.tsx", "user_test.py", "user_test.rb"} {
			assert.True(t, LooksLikeTestFile(name), name)
		}
	})

	t.Run("when pattern on content flags violation", func(t *testing.T) {
		run(t, func(e env) {
			r := []Rule{fbtRule("modern_go_map_any", 1, Dict{"event": "pre_edit", "path": "**/*.go", "when": `interface\{\}`, "message": "anyを使う", "severity": "warn"})}
			assert.Len(t, check(e, r, filepath.Join(e.tmp, "x.go"), "var m map[string]interface{}"), 1)
		})
	})

	t.Run("path glob not matching is ignored", func(t *testing.T) {
		run(t, func(e env) {
			r := []Rule{fbtRule("modern_go_map_any", 1, Dict{"event": "pre_edit", "path": "**/*.go", "when": `interface\{\}`, "message": "anyを使う", "severity": "warn"})}
			assert.Empty(t, check(e, r, filepath.Join(e.tmp, "x.rb"), "interface{}"))
		})
	})
}

func TestEvalStopCheck(t *testing.T) {
	readme := func() []Rule {
		return []Rule{fbtRule("readme_bilingual", 4, Dict{"event": "stop_check", "changed": "**/README.md", "require_sibling": "README_ja.md", "message": "日英併記", "severity": "block"})}
	}

	t.Run("README without ja sibling is blocked", func(t *testing.T) {
		WithTmp(func(tmp string) {
			fbtWrite(filepath.Join(tmp, "README.md"), "")
			v := EvalStopCheck(fbtIoFor(tmp), readme(), tmp, []string{"README.md"})
			require.Len(t, v, 1)
			assert.Equal(t, "block", v[0].Severity)
		})
	})

	t.Run("README with ja sibling passes", func(t *testing.T) {
		WithTmp(func(tmp string) {
			fbtWrite(filepath.Join(tmp, "README.md"), "")
			fbtWrite(filepath.Join(tmp, "README_ja.md"), "")
			assert.Empty(t, EvalStopCheck(fbtIoFor(tmp), readme(), tmp, []string{"README.md"}))
		})
	})

	t.Run("shows the rule and file being checked when running a check command", func(t *testing.T) {
		WithTmp(func(tmp string) {
			fbtWrite(filepath.Join(tmp, "a.txt"), "")
			progress := []string{}
			io := MakeIo(IoOpts{ProjectDir: tmp, Env: EnvVars{ClaudeFeedbackDir: tmp}, ProgressLog: &progress})
			r := fbtRule("chk_rule", 4, Dict{"event": "stop_check", "changed": "**/*.txt", "check": "true", "message": "m", "severity": "block"})
			EvalStopCheck(io, []Rule{r}, tmp, []string{"a.txt"})
			assert.Equal(t, []string{"[feedback-stop-check] 検査中: chk_rule (" + filepath.Join(tmp, "a.txt") + ")"}, progress)
		})
	})

	t.Run("unrelated changed file is ignored", func(t *testing.T) {
		WithTmp(func(tmp string) {
			assert.Empty(t, EvalStopCheck(fbtIoFor(tmp), readme(), tmp, []string{"main.go"}))
		})
	})

	t.Run("changed file deleted during the session is skipped (require_sibling)", func(t *testing.T) {
		WithTmp(func(tmp string) {
			assert.Empty(t, EvalStopCheck(fbtIoFor(tmp), readme(), tmp, []string{"README.md"}))
		})
	})

	t.Run("changed file deleted during the session is skipped (check)", func(t *testing.T) {
		WithTmp(func(tmp string) {
			r := fbtRule("chk_rule", 4, Dict{"event": "stop_check", "changed": "**/*.txt", "check": "false", "message": "m", "severity": "block"})
			fbtWrite(filepath.Join(tmp, "kept.txt"), "")
			v := EvalStopCheck(fbtIoFor(tmp), []Rule{r}, tmp, []string{"gone.txt", "kept.txt"})
			require.Len(t, v, 1)
			assert.Equal(t, "changed files violating: kept.txt", v[0].Detail)
		})
	})

	t.Run("changed file in a removed worktree is skipped", func(t *testing.T) {
		WithTmp(func(tmp string) {
			wt := filepath.Join(tmp, ".claude", "worktrees", "wt")
			require.NoError(t, os.MkdirAll(filepath.Join(wt, ".github", "workflows"), 0o755))
			fbtWrite(filepath.Join(wt, ".git"), "gitdir: "+filepath.Join(tmp, ".git", "worktrees", "wt")+"\n")
			f := filepath.Join(wt, ".github", "workflows", "ci.yaml")
			fbtWrite(f, "")
			r := fbtRule("pin_actions", 4, Dict{"event": "stop_check", "changed": ".github/workflows/**", "check": "false", "message": "m", "severity": "block"})
			assert.Len(t, EvalStopCheck(fbtIoFor(tmp), []Rule{r}, tmp, []string{f}), 1)
			require.NoError(t, os.RemoveAll(wt))
			assert.Empty(t, EvalStopCheck(fbtIoFor(tmp), []Rule{r}, tmp, []string{f}))
		})
	})
}

func TestGetChangedFiles(t *testing.T) {
	memo := func(tmp, name, text string) {
		fbtWrite(filepath.Join(tmp, ".claude", ".gate-status", name), text)
	}

	t.Run("prefers changed_files memo", func(t *testing.T) {
		WithTmp(func(tmp string) {
			memo(tmp, "changed_files.sess1.txt", "a.go\nb.go\n")
			assert.Equal(t, []string{"a.go", "b.go"}, GetChangedFiles(fbtIoFor(tmp), tmp, "sess1"))
		})
	})

	t.Run("falls back to git when no memo", func(t *testing.T) {
		WithTmp(func(tmp string) {
			fbtInitRepo(t, tmp)
			fbtWrite(filepath.Join(tmp, "committed.txt"), "1")
			fbtGit(t, tmp, "add", ".")
			fbtGit(t, tmp, "commit", "-q", "-m", "init")
			fbtWrite(filepath.Join(tmp, "committed.txt"), "2")
			fbtWrite(filepath.Join(tmp, "untracked.txt"), "3")
			files := GetChangedFiles(fbtIoFor(tmp), tmp, "no-such-session")
			assert.Contains(t, files, "committed.txt")
			assert.Contains(t, files, "untracked.txt")
		})
	})

	t.Run("agent_id reads only agent suffixed memo", func(t *testing.T) {
		WithTmp(func(tmp string) {
			memo(tmp, "changed_files.sess1.txt", "main_only.go\n")
			memo(tmp, "changed_files.sess1--agent1.txt", "agent_only.go\n")
			assert.Equal(t, []string{"agent_only.go"}, GetChangedFiles(fbtIoFor(tmp), tmp, "sess1", "agent1"))
		})
	})

	t.Run("agent fallback without memo uses worktree cwd and returns absolute paths", func(t *testing.T) {
		WithTmp(func(tmp string) {
			worktree := filepath.Join(tmp, ".claude", "worktrees", "agent-agent1")
			require.NoError(t, os.MkdirAll(worktree, 0o755))
			fbtInitRepo(t, worktree)
			fbtWrite(filepath.Join(worktree, "committed.txt"), "1")
			fbtGit(t, worktree, "add", ".")
			fbtGit(t, worktree, "commit", "-q", "-m", "init")
			fbtWrite(filepath.Join(worktree, "committed.txt"), "2")
			assert.Equal(t, []string{filepath.Join(worktree, "committed.txt")}, GetChangedFiles(fbtIoFor(tmp), tmp, "sess1", "agent1"))
		})
	})

	t.Run("agent fallback without worktree uses project dir", func(t *testing.T) {
		WithTmp(func(tmp string) {
			fbtInitRepo(t, tmp)
			fbtWrite(filepath.Join(tmp, "untracked.txt"), "1")
			assert.Contains(t, GetChangedFiles(fbtIoFor(tmp), tmp, "sess1", "agent-without-worktree"), "untracked.txt")
		})
	})

	t.Run("main call merges plain and agent suffixed memos", func(t *testing.T) {
		WithTmp(func(tmp string) {
			memo(tmp, "changed_files.sess1.txt", "main.go\n")
			memo(tmp, "changed_files.sess1--agentA.txt", "agentA.go\n")
			memo(tmp, "changed_files.sess1--agentB.txt", "agentB.go\nmain.go\n")
			assert.Equal(t, []string{"main.go", "agentA.go", "agentB.go"}, GetChangedFiles(fbtIoFor(tmp), tmp, "sess1"))
		})
	})

	t.Run("main call with only agent suffixed memos does not fall back to git", func(t *testing.T) {
		WithTmp(func(tmp string) {
			memo(tmp, "changed_files.sess1--agentA.txt", "agentA.go\n")
			assert.Equal(t, []string{"agentA.go"}, GetChangedFiles(fbtIoFor(tmp), tmp, "sess1"))
		})
	})
}

func TestSplitRoot(t *testing.T) {
	tmp := "/proj"
	t.Run("worktree path returns worktree root and relative", func(t *testing.T) {
		wt := filepath.Join(tmp, ".claude", "worktrees", "agent-abc123")
		root, rel := SplitRoot(tmp, filepath.Join(wt, "hooks", "foo.py"))
		assert.Equal(t, wt, root)
		assert.Equal(t, "hooks/foo.py", rel)
	})
	t.Run("non worktree absolute path returns project dir", func(t *testing.T) {
		root, rel := SplitRoot(tmp, filepath.Join(tmp, "hooks", "foo.py"))
		assert.Equal(t, tmp, root)
		assert.Equal(t, "hooks/foo.py", rel)
	})
	t.Run("relative path is treated as project relative", func(t *testing.T) {
		root, rel := SplitRoot(tmp, "hooks/foo.py")
		assert.Equal(t, tmp, root)
		assert.Equal(t, "hooks/foo.py", rel)
	})
}

func TestEvalStopCheckWithWorktrees(t *testing.T) {
	run := func(t *testing.T, body func(tmp, worktree string)) {
		t.Helper()
		WithTmp(func(tmp string) {
			worktree := filepath.Join(tmp, ".claude", "worktrees", "agent-abc")
			require.NoError(t, os.MkdirAll(filepath.Join(worktree, "hooks"), 0o755))
			body(tmp, worktree)
		})
	}

	t.Run("worktree file matches anchored glob by root relative path", func(t *testing.T) {
		run(t, func(tmp, worktree string) {
			f := filepath.Join(worktree, "hooks", "foo.py")
			fbtWrite(f, "")
			r := []Rule{fbtRule("some_rule", 4, Dict{"event": "stop_check", "changed": "hooks/**/*.py", "message": "check", "severity": "block", "check": "exit 1"})}
			assert.Len(t, EvalStopCheck(fbtIoFor(tmp), r, tmp, []string{f}), 1)
		})
	})

	t.Run("require_sibling checks worktree absolute path", func(t *testing.T) {
		run(t, func(tmp, worktree string) {
			f := filepath.Join(worktree, "hooks", "README.md")
			fbtWrite(f, "")
			r := []Rule{fbtRule("readme_bilingual", 4, Dict{"event": "stop_check", "changed": "**/README.md", "require_sibling": "README_ja.md", "message": "bilingual", "severity": "block"})}
			assert.Len(t, EvalStopCheck(fbtIoFor(tmp), r, tmp, []string{f}), 1)
			fbtWrite(filepath.Join(worktree, "hooks", "README_ja.md"), "")
			assert.Empty(t, EvalStopCheck(fbtIoFor(tmp), r, tmp, []string{f}))
		})
	})

	t.Run("check command receives worktree absolute file and cwd", func(t *testing.T) {
		run(t, func(tmp, worktree string) {
			f := filepath.Join(worktree, "hooks", "foo.py")
			fbtWrite(f, "")
			marker := filepath.Join(tmp, "marker.txt")
			r := []Rule{fbtRule("some_rule", 4, Dict{
				"event": "stop_check", "changed": "**/*.py", "message": "check", "severity": "block",
				"check": `printf "%s\n%s" "$FILE" "$(pwd)" > ` + marker + `; exit 1`,
			})}
			EvalStopCheck(fbtIoFor(tmp), r, tmp, []string{f})
			parts := strings.SplitN(Read(marker), "\n", 2)
			require.Len(t, parts, 2)
			assert.Equal(t, f, parts[0])
			gotCwd, err := filepath.EvalSymlinks(parts[1])
			require.NoError(t, err)
			wantCwd, err := filepath.EvalSymlinks(worktree)
			require.NoError(t, err)
			assert.Equal(t, wantCwd, gotCwd)
		})
	})

	t.Run("main tree check command cwd is project dir", func(t *testing.T) {
		run(t, func(tmp, _ string) {
			f := filepath.Join(tmp, "hooks", "bar.py")
			fbtWrite(f, "")
			marker := filepath.Join(tmp, "marker.txt")
			r := []Rule{fbtRule("some_rule", 4, Dict{
				"event": "stop_check", "changed": "**/*.py", "message": "check", "severity": "block",
				"check": `printf "%s" "$(pwd)" > ` + marker + `; exit 1`,
			})}
			EvalStopCheck(fbtIoFor(tmp), r, tmp, []string{f})
			got, err := filepath.EvalSymlinks(Read(marker))
			require.NoError(t, err)
			want, err := filepath.EvalSymlinks(tmp)
			require.NoError(t, err)
			assert.Equal(t, want, got)
		})
	})
}

func TestEvalPreEditWithWorktrees(t *testing.T) {
	golang := func() []Rule {
		return []Rule{fbtRule("golang_conventions", 5, Dict{
			"event": "pre_edit", "path": "pkg/**/*.go",
			"exclude_path": []any{"pkg/{domain,infrastructure}/**", "**/*_test.go"},
			"when":         `[\s\S]`, "message": "構成に従うこと", "severity": "warn",
		})}
	}
	specRule := func() []Rule {
		return []Rule{fbtRule("tdd", 7, Dict{"event": "pre_edit", "path": "**/*.rb", "absent_glob": []any{"spec/**/{stem}_spec.rb"}, "message": "先にテストを書く", "severity": "ask"})}
	}
	run := func(t *testing.T, body func(tmp, worktree string)) {
		t.Helper()
		WithTmp(func(tmp string) { body(tmp, filepath.Join(tmp, ".claude", "worktrees", "agent-abc")) })
	}

	t.Run("worktree file matches project root anchored path glob", func(t *testing.T) {
		run(t, func(tmp, worktree string) {
			f := Touch(worktree, "pkg", "cmd", "server.go")
			assert.Len(t, EvalPreEdit(fbtIoFor(tmp), golang(), f, "package cmd", tmp), 1)
		})
	})

	t.Run("worktree file under excluded dir is not flagged", func(t *testing.T) {
		run(t, func(tmp, worktree string) {
			f := Touch(worktree, "pkg", "domain", "model.go")
			assert.Empty(t, EvalPreEdit(fbtIoFor(tmp), golang(), f, "package domain", tmp))
		})
	})

	t.Run("worktree absent_glob resolves against worktree root", func(t *testing.T) {
		run(t, func(tmp, worktree string) {
			impl := Touch(worktree, "app", "models", "user.rb")
			Touch(worktree, "spec", "models", "user_spec.rb")
			assert.Empty(t, EvalPreEdit(fbtIoFor(tmp), specRule(), impl, "class User; end", tmp))
		})
	})

	t.Run("worktree absent_glob flags when only project dir has the test", func(t *testing.T) {
		run(t, func(tmp, worktree string) {
			impl := Touch(worktree, "app", "models", "user.rb")
			Touch(tmp, "spec", "models", "user_spec.rb")
			assert.Len(t, EvalPreEdit(fbtIoFor(tmp), specRule(), impl, "class User; end", tmp), 1)
		})
	})
}
