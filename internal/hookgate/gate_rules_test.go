package hookgate

// tests/gate-rules.spec.ts の移植（stop-test-gate と record-changes のエントリポイントのテストを含む）。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func mkdirs(t *testing.T, parts ...string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Join(parts...), 0o755))
}

func systemMessageOf(t *testing.T, stdout string) string {
	t.Helper()
	var m struct {
		SystemMessage string `json:"systemMessage"`
	}
	require.NoError(t, json.Unmarshal([]byte(stdout), &m), stdout)
	return m.SystemMessage
}

func TestGateRules(t *testing.T) {
	t.Run("per_file_dir: file root (pure)", func(t *testing.T) {
		t.Run("root is dirname of the matched file", func(t *testing.T) {
			for _, c := range [][2]string{
				{"packages/foo/x.go", "packages/foo"},
				{"services/foo/src/utils/helper.py", "services/foo/src/utils"},
				{"pkg/services/chat/x.go", "pkg/services/chat"},
			} {
				assert.Equal(t, c[1], FileRoot(c[0]))
			}
		})
		t.Run("file directly under project root gives empty root", func(t *testing.T) {
			assert.Equal(t, "", FileRoot("x.py"))
		})
	})

	t.Run("globMatchRoot (pattern_root)", func(t *testing.T) {
		t.Run("double star root stops before the ** segment", func(t *testing.T) {
			for _, c := range [][3]string{
				{"packages/*/**/*.go", "packages/foo/x.go", "packages/foo"},
				{"services/*/**/*.py", "services/foo/src/utils/helper.py", "services/foo"},
				{"packages/api/**/*.go", "packages/api/internal/x.go", "packages/api"},
			} {
				assert.Equal(t, c[2], GlobMatchRoot(c[0], c[1]))
			}
		})
		t.Run("pattern without ** falls back to dirname", func(t *testing.T) {
			assert.Equal(t, "services/foo", GlobMatchRoot("services/*/*.py", "services/foo/x.py"))
		})
		t.Run("leading ** gives project root", func(t *testing.T) {
			assert.Equal(t, "", GlobMatchRoot("**/*.py", "x.py"))
		})
	})

	t.Run("normalizePerFileDirMode", func(t *testing.T) {
		t.Run("true and \"file\" normalize to file mode", func(t *testing.T) {
			assert.Equal(t, "file", NormalizePerFileDirMode(true))
			assert.Equal(t, "file", NormalizePerFileDirMode("file"))
		})
		t.Run("\"pattern_root\" normalizes to pattern_root mode", func(t *testing.T) {
			assert.Equal(t, "pattern_root", NormalizePerFileDirMode("pattern_root"))
		})
		t.Run("invalid values return null", func(t *testing.T) {
			for _, v := range []any{false, nil, "", "bogus", 1, float64(1), "File", "PATTERN_ROOT"} {
				assert.Equal(t, "", NormalizePerFileDirMode(v), "%v", v)
			}
		})
	})

	t.Run("computePerFileRoots", func(t *testing.T) {
		pairs := func(pats ...string) []PatternPair {
			p, err := MatchPatterns(pats)
			require.NoError(t, err)
			return p
		}
		t.Run("file mode uses each file own dirname", func(t *testing.T) {
			roots := ComputePerFileRoots("file", pairs("pkg/**/*.go"), []string{"pkg/services/chat/x.go", "pkg/services/chat/y_test.go", "pkg/domain/user/z.go"})
			assert.Equal(t, "pkg/services/chat", roots["pkg/services/chat/x.go"])
			assert.Equal(t, "pkg/services/chat", roots["pkg/services/chat/y_test.go"])
			assert.Equal(t, "pkg/domain/user", roots["pkg/domain/user/z.go"])
		})
		t.Run("pattern_root mode uses first matching pattern in match order", func(t *testing.T) {
			assert.Equal(t, "packages", ComputePerFileRoots("pattern_root", pairs("packages/**/*.go", "packages/api/**/*.go"), []string{"packages/api/x.go"})["packages/api/x.go"])
			assert.Equal(t, "packages/api", ComputePerFileRoots("pattern_root", pairs("packages/api/**/*.go", "packages/**/*.go"), []string{"packages/api/x.go"})["packages/api/x.go"])
		})
		t.Run("pattern_root mode dedupes by root across multiple files", func(t *testing.T) {
			roots := ComputePerFileRoots("pattern_root", pairs("services/*/**/*.py"), []string{"services/foo/a.py", "services/foo/sub/b.py", "services/bar/c.py"})
			var vals []string
			for _, v := range roots {
				vals = append(vals, v)
			}
			assert.Equal(t, []string{"services/bar", "services/foo"}, gateSorted(gateUniq(vals)))
		})
	})

	t.Run("summarizeCmds", func(t *testing.T) {
		t.Run("sequential commands are not joined with &&", func(t *testing.T) {
			r := SummarizeCmds(gList("a", "b", "c"))
			assert.Equal(t, "a ; b ; c", r)
			assert.NotContains(t, r, "&&")
		})
		t.Run("parallel block still uses ampersand inside parens", func(t *testing.T) {
			assert.Equal(t, "echo a ; (echo b & echo c)", SummarizeCmds(gList(Dict{"cmd": "echo a"}, Dict{"parallel": gList("echo b", "echo c")})))
		})
	})

	t.Run("per_file_dir integration", func(t *testing.T) {
		t.Run("file mode cwd is matched file own directory", func(t *testing.T) {
			proj := tmpProj(t)
			svc := filepath.Join(proj, "pkg", "services", "chat")
			Touch(svc, "marker.txt")
			Touch(svc, "x.go")
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "pkg/**/*.go", "per_file_dir": true, "run": gList("test -f marker.txt")})})
			WriteChangedFiles(proj, "sess1", "pkg/services/chat/x.go")
			assert.Equal(t, 0, rules(proj).ExitCode)
			// run_checks が無いので、成功したファイルは CHANGED から完全に消えている
			assert.False(t, Exists(ChangedPath(proj, "sess1")))
		})

		t.Run("file mode files in same directory share a single run", func(t *testing.T) {
			proj := tmpProj(t)
			svc := filepath.Join(proj, "pkg", "services", "chat")
			Touch(svc, "x.go")
			Touch(svc, "y_test.go")
			counter := filepath.Join(proj, "run_count.txt")
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "pkg/**/*.go", "per_file_dir": true, "run": gList("echo x >> " + counter)})})
			WriteChangedFiles(proj, "sess1", "pkg/services/chat/x.go", "pkg/services/chat/y_test.go")
			assert.Equal(t, 0, rules(proj).ExitCode)
			assert.Len(t, Lines(counter), 1)
		})

		t.Run("pattern_root mode cwd is service root, not leaf directory", func(t *testing.T) {
			proj := tmpProj(t)
			svc := filepath.Join(proj, "services", "foo")
			Touch(svc, "pyproject.toml")
			Touch(svc, "src", "utils", "helper.py")
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "services/*/**/*.py", "per_file_dir": "pattern_root", "run": gList("test -f pyproject.toml")})})
			WriteChangedFiles(proj, "sess1", "services/foo/src/utils/helper.py")
			assert.Equal(t, 0, rules(proj).ExitCode)
			assert.False(t, Exists(ChangedPath(proj, "sess1")))
		})
	})

	t.Run("CLAUDE_GATE_FILES", func(t *testing.T) {
		t.Run("rule run receives matched files", func(t *testing.T) {
			proj := tmpProj(t)
			for _, name := range []string{"b.rb", "a.rb", "ignored.txt"} {
				Touch(proj, "app", name)
			}
			out := filepath.Join(proj, "files.txt")
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "app/**/*.rb", "run": gList(`printf "%s\n" "$CLAUDE_GATE_FILES" > ` + out)})})
			WriteChangedFiles(proj, "sess1", "app/b.rb", "app/a.rb", "app/ignored.txt", "app/b.rb")
			assert.Equal(t, 0, rules(proj).ExitCode)
			assert.Equal(t, "app/a.rb app/b.rb", strings.TrimSpace(Read(out)))
		})

		t.Run("per_file_dir run receives only that root files", func(t *testing.T) {
			proj := tmpProj(t)
			for _, d := range []string{"chat", "user"} {
				Touch(proj, "pkg", d, "x.go")
			}
			out := filepath.Join(proj, "files.txt")
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "pkg/**/*.go", "per_file_dir": true, "run": gList(`printf "%s\n" "$CLAUDE_GATE_FILES" >> ` + out)})})
			WriteChangedFiles(proj, "sess1", "pkg/chat/x.go", "pkg/user/x.go")
			assert.Equal(t, 0, rules(proj).ExitCode)
			got := Lines(out)
			sort.Strings(got)
			assert.Equal(t, []string{"pkg/chat/x.go", "pkg/user/x.go"}, got)
		})

		t.Run("eval set -- recovers paths with spaces", func(t *testing.T) {
			proj := tmpProj(t)
			Touch(proj, "app", "a b.rb")
			out := filepath.Join(proj, "files.txt")
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "app/**/*.rb", "run": gList(`eval "set -- $CLAUDE_GATE_FILES"; for f in "$@"; do echo "$f" >> ` + out + `; done`)})})
			WriteChangedFiles(proj, "sess1", "app/a b.rb")
			assert.Equal(t, 0, rules(proj).ExitCode)
			assert.Equal(t, []string{"app/a b.rb"}, Lines(out))
		})

		t.Run("consistency check run receives reserving files", func(t *testing.T) {
			proj := tmpProj(t)
			out := filepath.Join(proj, "files.txt")
			SetupReservedCheckProject(proj, "sess1", gList(`printf "%s\n" "$CLAUDE_GATE_FILES" > `+out), nil)
			assert.Equal(t, 0, rules(proj).ExitCode)
			assert.Equal(t, 0, checks(proj, GateOpts{StopHookActive: true}).ExitCode)
			assert.Equal(t, "x.py", strings.TrimSpace(Read(out)))
		})
	})

	t.Run("invalid per_file_dir value", func(t *testing.T) {
		t.Run("fails the rule instead of silently ignoring", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "per_file_dir": "bogus", "run": gList("echo hi")})})
			WriteChangedFiles(proj, "sess1", "x.py")
			// rules フェーズの失敗は会話をブロックしないが、exit 2 で stderr 通知される
			r := rules(proj)
			assert.Equal(t, 2, r.ExitCode)
			assert.Contains(t, r.Stderr, "'bogus'")
		})
	})

	t.Run("missing cwd", func(t *testing.T) {
		t.Run("dir rule with missing directory is skipped, not crashed", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "ghost/**/*.py", "dir": "ghost", "run": gList("echo hi")})})
			WriteChangedFiles(proj, "sess1", "ghost/x.py")
			assert.Equal(t, 0, rules(proj).ExitCode)
		})

		t.Run("per_file_dir with missing root is skipped, not crashed", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "ghost/*/**/*.py", "per_file_dir": true, "run": gList("echo hi")})})
			WriteChangedFiles(proj, "sess1", "ghost/foo/bar.py")
			assert.Equal(t, 0, rules(proj).ExitCode)
		})

		t.Run("consistency check with missing dir is skipped, not crashed", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{
				"rules":              gList(Dict{"match": "**/*.py", "run": gList("true"), "run_checks": gList("ghost-check")}),
				"consistency_checks": gList(Dict{"name": "ghost-check", "dir": "ghost", "run": gList("echo hi")}),
			})
			WriteChangedFiles(proj, "sess1", "x.py")
			assert.Equal(t, 0, rules(proj).ExitCode)
			assert.Equal(t, 0, checks(proj).ExitCode)
		})
	})

	t.Run("status lines", func(t *testing.T) {
		t.Run("rules phase prints ok line with label, cmd and seconds", func(t *testing.T) {
			proj := tmpProj(t)
			mkdirs(t, proj, "sub")
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "dir": "sub", "run": gList("echo hi")})})
			WriteChangedFiles(proj, "sess1", "x.py")
			r := rules(proj)
			assert.Equal(t, 0, r.ExitCode)
			assert.Regexp(t, `\[gate\] ok: sub \$ echo hi \(\d+\.\ds\)`, systemMessageOf(t, r.Stdout))
		})

		t.Run("ok line is printed for each parallel command", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList(Dict{"parallel": gList("echo aaa", Dict{"cmd": "echo bbb", "name": "second"})})})})
			WriteChangedFiles(proj, "sess1", "x.py")
			msg := systemMessageOf(t, rules(proj).Stdout)
			assert.Regexp(t, `\[gate\] ok: \. \$ echo aaa \(`, msg)
			assert.Regexp(t, `\[gate\] ok: \. \$ echo bbb \(`, msg)
		})

		t.Run("multiline cmd is collapsed to one line", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList("echo first\necho second")})})
			WriteChangedFiles(proj, "sess1", "x.py")
			msg := systemMessageOf(t, rules(proj).Stdout)
			var okLines []string
			for _, l := range strings.Split(msg, "\n") {
				if strings.HasPrefix(l, "[gate] ok:") {
					okLines = append(okLines, l)
				}
			}
			require.Len(t, okLines, 1)
			assert.Contains(t, okLines[0], "echo first ...")
			assert.NotContains(t, msg, "echo second")
		})

		t.Run("file matching no rule is reported as skipped", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList("echo hi")})})
			WriteChangedFiles(proj, "sess1", "x.py", "notes.txt")
			msg := systemMessageOf(t, rules(proj).Stdout)
			var skip []string
			for _, l := range strings.Split(msg, "\n") {
				if strings.HasPrefix(l, "[gate] skip:") {
					skip = append(skip, l)
				}
			}
			require.Len(t, skip, 1)
			assert.Regexp(t, `notes\.txt.*どのルールにもマッチしません`, skip[0])
			assert.NotContains(t, skip[0], "x.py")
		})

		t.Run("only unmatched files still prints a skip line", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList("echo hi")})})
			WriteChangedFiles(proj, "sess1", "notes.txt")
			r := rules(proj)
			assert.Equal(t, 0, r.ExitCode)
			assert.Contains(t, systemMessageOf(t, r.Stdout), "[gate] skip:")
		})

		t.Run("missing cwd is reported as skipped", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "dir": "ghost", "run": gList("echo hi")})})
			WriteChangedFiles(proj, "sess1", "x.py")
			assert.Regexp(t, `\[gate\] skip: ghost \$ echo hi .*cwd`, systemMessageOf(t, rules(proj).Stdout))
		})

		t.Run("policy skip is reported as skipped", func(t *testing.T) {
			proj := tmpProj(t)
			fake, _ := WriteFakeDogwood(filepath.Join(proj, "bin"), FakeDogwoodOpts{Verdict: "deny"})
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList("echo hi")})})
			WriteChangedFiles(proj, "sess1", "x.py")
			r := rules(proj, GateOpts{DogwoodBin: fake})
			assert.Regexp(t, `\[gate\] skip: \. \$ echo hi .*ポリシー`, systemMessageOf(t, r.Stdout))
		})

		t.Run("failure keeps detail and adds fail and ok lines on stderr", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList("echo passed-cmd", "echo boom-detail; exit 1")})})
			WriteChangedFiles(proj, "sess1", "x.py")
			r := rules(proj)
			assert.Equal(t, 2, r.ExitCode)
			assert.Regexp(t, `\[gate\] ok: \. \$ echo passed-cmd \(`, r.Stderr)
			assert.Regexp(t, `\[gate\] fail: \. \$ echo boom-detail; exit 1 \(`, r.Stderr)
			assert.Contains(t, r.Stderr, "boom-detail")
		})

		t.Run("checks phase prints ok line", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{
				"rules":              gList(Dict{"match": "**/*.py", "run": gList("echo r"), "run_checks": gList("all")}),
				"consistency_checks": gList(Dict{"name": "all", "run": gList("echo whole")}),
			})
			WriteChangedFiles(proj, "sess1", "x.py")
			rules(proj)
			r := checks(proj, GateOpts{StopHookActive: true})
			assert.Equal(t, 0, r.ExitCode)
			assert.Regexp(t, `\[gate\] ok: check:all \$ echo whole \(\d+\.\ds\)`, systemMessageOf(t, r.Stdout))
		})

		t.Run("files env reaches the command", func(t *testing.T) {
			proj := tmpProj(t)
			out := filepath.Join(proj, "files.out")
			mkdirs(t, proj, "packages", "app")
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "packages/app/**/*.ts", "dir": "packages/app", "run": gList(`echo "$CLAUDE_GATE_FILES" > ` + out)})})
			WriteChangedFiles(proj, "sess1", "packages/app/src/a.ts", "packages/app/src/b.ts")
			rules(proj)
			assert.Equal(t, "packages/app/src/a.ts packages/app/src/b.ts", strings.TrimSpace(Read(out)))
		})
	})

	t.Run("internal error safety net", func(t *testing.T) {
		t.Run("unexpected exception is caught: exit 0 with system message", func(t *testing.T) {
			proj := tmpProj(t)
			// match が文字列/リストではない不正な設定 -> パターン展開時に TypeError を誘発する
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": 123, "run": gList("echo hi")})})
			WriteChangedFiles(proj, "sess1", "x.py")
			r := rules(proj)
			assert.Equal(t, 0, r.ExitCode)
			assert.Contains(t, r.Stdout, "systemMessage")
			assert.Contains(t, r.Stdout, "内部エラー")
			assert.Contains(t, r.Stderr, "internal error")
		})

		t.Run("a gate.yaml that cannot be parsed is reported the same way", func(t *testing.T) {
			proj := tmpProj(t)
			mkdirs(t, proj, ".claude")
			require.NoError(t, os.WriteFile(filepath.Join(proj, ".claude", "gate.yaml"), []byte("rules: [unclosed\n"), 0o644))
			WriteChangedFiles(proj, "sess1", "x.py")
			r := rules(proj)
			assert.Equal(t, 0, r.ExitCode)
			assert.Contains(t, r.Stdout, "内部エラー")
			assert.Contains(t, r.Stderr, "YAMLParseError")
		})
	})

	t.Run("gate.yml typo", func(t *testing.T) {
		t.Run("warns when only the yml extension is present", func(t *testing.T) {
			proj := tmpProj(t)
			Touch(proj, ".claude", "gate.yml")
			r := gate(proj)
			assert.Equal(t, 0, r.ExitCode)
			assert.Contains(t, r.Stdout, "systemMessage")
			assert.Contains(t, r.Stdout, "gate.yml")
		})

		t.Run("no warning when neither file is present", func(t *testing.T) {
			proj := tmpProj(t)
			r := gate(proj)
			assert.Equal(t, 0, r.ExitCode)
			assert.Equal(t, "", strings.TrimSpace(r.Stdout))
		})
	})
}

func TestStopTestGateEntryPoint(t *testing.T) {
	run := func(proj string, payload Dict, phase string) ScriptResult {
		return StopTestGate(MakeIo(IoOpts{ProjectDir: proj, Env: EnvVars{DogwoodBin: MissingDogwoodBin}}), phase, payload)
	}

	t.Run("warns on yml typo without crashing", func(t *testing.T) {
		proj := tmpProj(t)
		Touch(proj, ".claude", "gate.yml")
		r := run(proj, Dict{"session_id": "sess1"}, "")
		assert.Equal(t, 0, r.ExitCode)
		assert.Contains(t, r.Stdout, "gate.yml")
	})

	t.Run("exits silently when neither gate file exists", func(t *testing.T) {
		proj := tmpProj(t)
		r := run(proj, Dict{"session_id": "sess1"}, "")
		assert.Equal(t, 0, r.ExitCode)
		assert.Equal(t, "", strings.TrimSpace(r.Stdout))
	})

	envCheck := func(expr string) string { return "test " + expr }

	t.Run("first arg selects rules phase", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList(envCheck(`"$CLAUDE_GATE_PHASE" = rules`))})})
		WriteChangedFiles(proj, "sess1", "x.py")
		assert.Equal(t, 0, run(proj, Dict{"session_id": "sess1"}, "rules").ExitCode)
	})

	t.Run("no arg defaults to checks phase", func(t *testing.T) {
		proj := tmpProj(t)
		// checks フェーズは PENDING が無ければ何もせず、rule の run は一切実行されない。
		marker := filepath.Join(proj, "ran.marker")
		WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList("touch " + marker)})})
		WriteChangedFiles(proj, "sess1", "x.py")
		assert.Equal(t, 0, run(proj, Dict{"session_id": "sess1"}, "").ExitCode)
		assert.False(t, Exists(marker))
	})

	t.Run("stop_hook_active true is threaded through to the command env", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList(envCheck(`"$CLAUDE_STOP_HOOK_ACTIVE" = true`))})})
		WriteChangedFiles(proj, "sess1", "x.py")
		assert.Equal(t, 0, run(proj, Dict{"session_id": "sess1", "stop_hook_active": true}, "rules").ExitCode)
	})

	t.Run("stop_hook_active false is threaded through to the command env", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList(envCheck(`"$CLAUDE_STOP_HOOK_ACTIVE" = false`))})})
		WriteChangedFiles(proj, "sess1", "x.py")
		assert.Equal(t, 0, run(proj, Dict{"session_id": "sess1"}, "rules").ExitCode)
	})

	t.Run("agent_id is threaded through to the command env", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList(envCheck(`"$CLAUDE_AGENT_ID" = agent1`))})})
		WriteChangedFiles(proj, "sess1--agent1", "x.py")
		assert.Equal(t, 0, run(proj, Dict{"session_id": "sess1", "agent_id": "agent1"}, "rules").ExitCode)
	})

	t.Run("agent_id absent leaves the env var unset", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList(envCheck(`-z "${CLAUDE_AGENT_ID+set}"`))})})
		WriteChangedFiles(proj, "sess1", "x.py")
		assert.Equal(t, 0, run(proj, Dict{"session_id": "sess1"}, "rules").ExitCode)
	})

	t.Run("CLAUDE_PROJECT_DIR and CLAUDE_SESSION_ID are passed to the command", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList(envCheck(`"$CLAUDE_PROJECT_DIR" = ` + proj + ` -a "$CLAUDE_SESSION_ID" = sess1`))})})
		WriteChangedFiles(proj, "sess1", "x.py")
		assert.Equal(t, 0, run(proj, Dict{"session_id": "sess1"}, "rules").ExitCode)
	})
}

func TestRecordChanges(t *testing.T) {
	run := func(proj string, payload Dict) ScriptResult {
		return RecordChanges(MakeIo(IoOpts{ProjectDir: proj}), payload)
	}
	memo := func(proj, id string) string {
		return filepath.Join(proj, ".claude", ".gate-status", "changed_files."+id+".txt")
	}

	t.Run("agent_id present uses suffixed memo", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"rules": gList()})
		r := run(proj, Dict{"session_id": "sess1", "agent_id": "agent1", "tool_input": Dict{"file_path": "x.py"}})
		assert.Equal(t, 0, r.ExitCode)
		assert.Equal(t, "x.py", strings.TrimSpace(Read(memo(proj, "sess1--agent1"))))
		assert.False(t, Exists(memo(proj, "sess1")))
	})

	t.Run("agent_id absent uses plain memo", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"rules": gList()})
		r := run(proj, Dict{"session_id": "sess1", "tool_input": Dict{"file_path": "x.py"}})
		assert.Equal(t, 0, r.ExitCode)
		assert.Equal(t, "x.py", strings.TrimSpace(Read(memo(proj, "sess1"))))
	})

	t.Run("the same path is recorded once", func(t *testing.T) {
		proj := tmpProj(t)
		WriteGateYaml(proj, Dict{"rules": gList()})
		for _, p := range []string{"x.py", "y.py", "x.py"} {
			run(proj, Dict{"session_id": "sess1", "tool_input": Dict{"file_path": p}})
		}
		assert.Equal(t, []string{"x.py", "y.py"}, Lines(memo(proj, "sess1")))
	})

	t.Run("does nothing without gate.yaml (opt-in)", func(t *testing.T) {
		proj := tmpProj(t)
		run(proj, Dict{"session_id": "sess1", "tool_input": Dict{"file_path": "x.py"}})
		assert.False(t, Exists(memo(proj, "sess1")))
	})
}
