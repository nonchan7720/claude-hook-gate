package hookgate

// tests/gate-policy.spec.ts の移植。

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func traceField(proj, field string) []any {
	out := []any{}
	for _, r := range ReadTraceRecords(proj, "sess1") {
		out = append(out, r[field])
	}
	return out
}

func traceNames(proj string) []any { return traceField(proj, "name") }
func traceKinds(proj string) []any { return traceField(proj, "kind") }

func traceKindNames(proj string) [][2]any {
	out := [][2]any{}
	for _, r := range ReadTraceRecords(proj, "sess1") {
		out = append(out, [2]any{r["kind"], r["name"]})
	}
	return out
}

func deferredCmds(proj string) []any {
	out := []any{}
	for _, e := range ReadDeferred(proj, "sess1") {
		out = append(out, e["cmd"])
	}
	return out
}

func countNonEmptyLines(p string) int {
	n := 0
	for _, l := range strings.Split(Read(p), "\n") {
		if l != "" {
			n++
		}
	}
	return n
}

func TestGatePolicy(t *testing.T) {
	t.Run("resolveDogwood", func(t *testing.T) {
		t.Run("DOGWOOD_BIN is used as is", func(t *testing.T) {
			proj := tmpProj(t)
			fake, _ := WriteFakeDogwood(filepath.Join(proj, "bin"))
			got, ok := newGate(proj, GateOpts{DogwoodBin: fake}).ResolveDogwood()
			assert.True(t, ok)
			assert.Equal(t, fake, got)
		})

		t.Run("a missing DOGWOOD_BIN does not fall back to PATH", func(t *testing.T) {
			proj := tmpProj(t)
			_, ok := newGate(proj, GateOpts{DogwoodBin: filepath.Join(proj, "nope")}).ResolveDogwood()
			assert.False(t, ok)
		})
	})

	t.Run("cedar trace lines", func(t *testing.T) {
		t.Run("quotes and backslashes are escaped", func(t *testing.T) {
			assert.Equal(t, `"a\"b\\c"`, CedarString("a\"b\\c"))
		})

		t.Run("control characters are escaped", func(t *testing.T) {
			assert.Equal(t, `"a\nb\r\tc\"\\"`, CedarString("a\nb\r\tc\"\\"))
		})

		t.Run("multiline cmd is a single line", func(t *testing.T) {
			line := TraceLine(Dict{"ts": 1, "name": "all-type-check", "kind": "response", "cmd": "for pkg in packages/*/; do\n  echo \"${pkg}\"\ndone\nexit $status"}, "/p", 0)
			assert.NotContains(t, line, "\n")
			assert.NotContains(t, line, "\r")
		})

		t.Run("request line carries ts, project, name and cmd", func(t *testing.T) {
			line := TraceLine(Dict{"ts": 1000, "name": "hooks-pytest", "cmd": "pytest tests -q", "kind": "request"}, "claude", 0)
			assert.True(t, strings.HasPrefix(line, "@1000 "))
			assert.Contains(t, line, `Gate::Agent::"gate"`)
			assert.Contains(t, line, `Gate::Project::"claude"`)
			assert.Contains(t, line, `Gate::Action::"Run"::request(`)
			assert.Contains(t, line, `name: "hooks-pytest"`)
			assert.Contains(t, line, `cmd: "pytest tests -q"`)
		})

		t.Run("history kinds use their own event name", func(t *testing.T) {
			for _, kind := range []string{"response", "error"} {
				assert.Contains(t, TraceLine(Dict{"ts": 1, "name": "n", "cmd": "c", "kind": kind}, "p", 1), fmt.Sprintf(`Gate::Action::"Run"::%s(`, kind))
			}
		})
	})

	t.Run("policy path resolution", func(t *testing.T) {
		t.Run("relative path is resolved from root dir", func(t *testing.T) {
			proj := tmpProj(t)
			assert.Equal(t, "/root/.claude/policies/gate.dw", newGate(proj).ResolvePolicyPath("/root", ".claude/policies/gate.dw"))
		})

		t.Run("absolute and tilde paths are kept", func(t *testing.T) {
			proj := tmpProj(t)
			g := newGate(proj)
			assert.Equal(t, "/abs/gate.dw", g.ResolvePolicyPath("/root", "/abs/gate.dw"))
			assert.Equal(t, filepath.Join(TestHome, "gate.dw"), g.ResolvePolicyPath("/root", "~/gate.dw"))
		})

		t.Run("rule policy overrides top level", func(t *testing.T) {
			proj := tmpProj(t)
			top := WritePolicy(proj, ".claude/policies/gate.dw")
			rule := WritePolicy(proj, ".claude/policies/hooks.dw")
			g := newGate(proj)
			cfg := Dict{"policy": ".claude/policies/gate.dw"}
			r := g.PolicyPaths(cfg, Dict{"policy": ".claude/policies/hooks.dw"}, proj, nil)
			require.NotNil(t, r)
			assert.Equal(t, rule, r.Policy)
			r = g.PolicyPaths(cfg, Dict{}, proj, nil)
			require.NotNil(t, r)
			assert.Equal(t, top, r.Policy)
		})

		t.Run("default schema is used when not configured", func(t *testing.T) {
			proj := tmpProj(t)
			WritePolicy(proj)
			g := newGate(proj)
			r := g.PolicyPaths(Dict{"policy": ".claude/policies/gate.dw"}, Dict{}, proj, nil)
			require.NotNil(t, r)
			assert.Equal(t, g.DefaultPolicySchema, r.Schema)
			assert.True(t, Exists(g.DefaultPolicySchema))
		})

		t.Run("unset policy falls back to the bundled default", func(t *testing.T) {
			proj := tmpProj(t)
			g := newGate(proj)
			r := g.PolicyPaths(Dict{}, Dict{}, proj, nil)
			assert.Equal(t, &PolicyResolved{Policy: g.DefaultPolicy, Schema: g.DefaultPolicySchema, IsDefault: true}, r)
			assert.True(t, Exists(g.DefaultPolicy))
		})

		t.Run("explicit policy is not flagged as default", func(t *testing.T) {
			proj := tmpProj(t)
			WritePolicy(proj)
			r := newGate(proj).PolicyPaths(Dict{"policy": ".claude/policies/gate.dw"}, Dict{}, proj, nil)
			require.NotNil(t, r)
			assert.False(t, r.IsDefault)
		})

		t.Run("missing default policy file disables the mechanism", func(t *testing.T) {
			proj := tmpProj(t)
			g := newGate(proj)
			g.DefaultPolicy = filepath.Join(proj, "ghost-default.dw")
			assert.Nil(t, g.PolicyPaths(Dict{}, Dict{}, proj, nil))
		})

		t.Run("missing policy file disables the mechanism and logs", func(t *testing.T) {
			proj := tmpProj(t)
			var logs []string
			assert.Nil(t, newGate(proj).PolicyPaths(Dict{"policy": "ghost.dw"}, Dict{}, proj, &logs))
			assert.True(t, anyContains(logs, "ghost.dw"))
		})

		t.Run("false disables the mechanism; rule false overrides a top level path; rule path overrides top level false", func(t *testing.T) {
			proj := tmpProj(t)
			rule := WritePolicy(proj, ".claude/policies/hooks.dw")
			WritePolicy(proj)
			g := newGate(proj)
			assert.Nil(t, g.PolicyPaths(Dict{"policy": false}, Dict{}, proj, nil))
			assert.Nil(t, g.PolicyPaths(Dict{"policy": ".claude/policies/gate.dw"}, Dict{"policy": false}, proj, nil))
			assert.Nil(t, g.PolicyPaths(Dict{"policy": false}, Dict{"match": "x"}, proj, nil))
			r := g.PolicyPaths(Dict{"policy": false}, Dict{"policy": ".claude/policies/hooks.dw"}, proj, nil)
			require.NotNil(t, r)
			assert.Equal(t, rule, r.Policy)
		})
	})

	t.Run("trace store", func(t *testing.T) {
		cmds := func(rs []Dict) []any {
			out := []any{}
			for _, r := range rs {
				out = append(out, r["cmd"])
			}
			return out
		}

		t.Run("records are scoped to their root", func(t *testing.T) {
			proj := tmpProj(t)
			g := newGate(proj)
			g.AppendTrace(proj, proj, "a", "cmd-a", "request")
			g.AppendTrace("/other/root", "/other/root", "b", "cmd-b", "request")
			assert.Equal(t, []any{"cmd-a"}, cmds(g.ReadTrace(proj)))
			assert.Equal(t, []any{"cmd-b"}, cmds(g.ReadTrace("/other/root")))
		})

		t.Run("timestamp is monotonic non-decreasing per root", func(t *testing.T) {
			proj := tmpProj(t)
			future := time.Now().Unix() + 5000
			WriteTraceRecords(proj, "sess1", []Dict{{"ts": future, "root": proj, "cwd": proj, "name": "a", "cmd": "a", "kind": "request"}})
			assert.GreaterOrEqual(t, newGate(proj).AppendTrace(proj, proj, "b", "b", "response"), float64(future))
		})

		t.Run("records older than the window are pruned on write", func(t *testing.T) {
			proj := tmpProj(t)
			now := time.Now().Unix()
			WriteTraceRecords(proj, "sess1", []Dict{
				{"ts": now - 90000, "root": proj, "cwd": proj, "name": "old", "cmd": "old", "kind": "error"},
				{"ts": now - 60, "root": proj, "cwd": proj, "name": "recent", "cmd": "recent", "kind": "error"},
			})
			newGate(proj).AppendTrace(proj, proj, "new", "new", "request")
			assert.Equal(t, []any{"recent", "new"}, traceNames(proj))
		})

		t.Run("broken lines are ignored", func(t *testing.T) {
			proj := tmpProj(t)
			require.NoError(t, os.MkdirAll(filepath.Dir(TracePath(proj, "sess1")), 0o755))
			require.NoError(t, os.WriteFile(TracePath(proj, "sess1"), []byte("<<broken>>\n"), 0o644))
			g := newGate(proj)
			g.AppendTrace(proj, proj, "a", "a", "request")
			names := []any{}
			for _, r := range g.ReadTrace(proj) {
				names = append(names, r["name"])
			}
			assert.Equal(t, []any{"a"}, names)
		})
	})

	t.Run("deferred store", func(t *testing.T) {
		t.Run("entries are deduped by root, cwd and cmd", func(t *testing.T) {
			proj := tmpProj(t)
			g := newGate(proj)
			g.DeferCmd(proj, proj, "n", "pytest -q", 300, "hooks", nil)
			g.DeferCmd(proj, proj, "n2", "pytest -q", 60, "hooks", nil)
			g.DeferCmd(proj, filepath.Join(proj, "sub"), "n", "pytest -q", 300, "sub", nil)
			entries := ReadDeferred(proj, "sess1")
			require.Len(t, entries, 2)
			assert.Equal(t, float64(300), entries[0]["timeout"])
		})

		t.Run("files env of a duplicate is merged into the existing entry", func(t *testing.T) {
			proj := tmpProj(t)
			g := newGate(proj)
			g.DeferCmd(proj, proj, "n", "c", 300, "x", GateEnv{"CLAUDE_GATE_FILES": "a.py"})
			g.DeferCmd(proj, proj, "n", "c", 300, "x", GateEnv{"CLAUDE_GATE_FILES": "b.py 'c d.py'"})
			env, ok := ReadDeferred(proj, "sess1")[0]["env"].(map[string]any)
			require.True(t, ok)
			assert.Equal(t, "a.py b.py 'c d.py'", env["CLAUDE_GATE_FILES"])
		})

		t.Run("takeDeferred returns all and empties the store", func(t *testing.T) {
			proj := tmpProj(t)
			g := newGate(proj)
			g.DeferCmd(proj, proj, "n", "a", 300, "x", nil)
			assert.Len(t, g.TakeDeferred(), 1)
			assert.Empty(t, ReadDeferred(proj, "sess1"))
		})
	})

	entry := func(proj, cmd string) Dict {
		return Dict{"root": proj, "cwd": proj, "name": fmt.Sprintf("n%d", len(cmd)), "cmd": cmd, "timeout": 30, "label": "x", "env": Dict{}}
	}

	t.Run("checks phase drains deferred", func(t *testing.T) {
		t.Run("runs deferred without pending checks and empties the store", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.go", "run": gList("true")})})
			marker := filepath.Join(proj, "ran.txt")
			WriteDeferred(proj, "sess1", gList(entry(proj, "echo ok > "+marker)))
			requireExit0(t, checks(proj, GateOpts{StopHookActive: true}))
			assert.True(t, Exists(marker))
			assert.Empty(t, ReadDeferred(proj, "sess1"))
		})

		t.Run("blocks and keeps only the failed deferred", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.go", "run": gList("true")})})
			WriteDeferred(proj, "sess1", gList(entry(proj, "true"), entry(proj, "echo deferred-failed; exit 1")))
			r := checks(proj)
			assert.Equal(t, 2, r.ExitCode)
			assert.Contains(t, r.Stderr, "deferred-failed")
			assert.Equal(t, []any{"echo deferred-failed; exit 1"}, deferredCmds(proj))
		})
	})

	t.Run("policy disabled / missing", func(t *testing.T) {
		runRules := func(t *testing.T, proj string, gateCfg Dict, dogwoodBin string) string {
			marker := filepath.Join(proj, "ran.marker")
			cfg := Dict{}
			for k, v := range gateCfg {
				cfg[k] = v
			}
			cfg["rules"] = gList(Dict{"match": "**/*.py", "run": gList("touch " + marker)})
			WriteGateYaml(proj, cfg)
			WriteChangedFiles(proj, "sess1", "x.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: dogwoodBin}))
			return marker
		}

		t.Run("policy false runs commands without asking dogwood", func(t *testing.T) {
			proj := tmpProj(t)
			fake, calls := WriteFakeDogwood(filepath.Join(proj, "bin"), FakeDogwoodOpts{Verdict: "deny"})
			assert.True(t, Exists(runRules(t, proj, Dict{"policy": false}, fake)))
			assert.Empty(t, ReadCalls(calls))
			assert.Empty(t, ReadDeferred(proj, "sess1"))
		})

		t.Run("rule policy false overrides a top level path", func(t *testing.T) {
			proj := tmpProj(t)
			fake, calls := WriteFakeDogwood(filepath.Join(proj, "bin"), FakeDogwoodOpts{Verdict: "deny"})
			WritePolicy(proj)
			marker := filepath.Join(proj, "ran.marker")
			WriteGateYaml(proj, Dict{"policy": ".claude/policies/gate.dw", "rules": gList(Dict{"match": "**/*.py", "policy": false, "run": gList("touch " + marker)})})
			WriteChangedFiles(proj, "sess1", "x.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			assert.True(t, Exists(marker))
			assert.Empty(t, ReadCalls(calls))
		})

		t.Run("rule policy path overrides a top level false", func(t *testing.T) {
			proj := tmpProj(t)
			fake, calls := WriteFakeDogwood(filepath.Join(proj, "bin"), FakeDogwoodOpts{Verdict: "deny"})
			ruleType := WritePolicy(proj, ".claude/policies/hooks.dw")
			marker := filepath.Join(proj, "ran.marker")
			WriteGateYaml(proj, Dict{
				"policy": false,
				"rules":  gList(Dict{"match": "**/*.py", "policy": ".claude/policies/hooks.dw", "run": gList(Dict{"cmd": "touch " + marker, "name": "pkg-a"})}),
			})
			WriteChangedFiles(proj, "sess1", "x.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			assert.False(t, Exists(marker))
			got := ReadCalls(calls)
			require.NotEmpty(t, got)
			assert.Equal(t, ruleType, got[0].Argv[1])
		})

		t.Run("missing policy file runs commands as before", func(t *testing.T) {
			proj := tmpProj(t)
			fake, calls := WriteFakeDogwood(filepath.Join(proj, "bin"), FakeDogwoodOpts{Verdict: "deny"})
			assert.True(t, Exists(runRules(t, proj, Dict{"policy": ".claude/policies/ghost.dw"}, fake)))
			assert.Empty(t, ReadCalls(calls))
			assert.Empty(t, ReadDeferred(proj, "sess1"))
		})

		t.Run("missing policy file is logged by runRules", func(t *testing.T) {
			proj := tmpProj(t)
			g := newGate(proj, GateOpts{Phase: "rules"})
			var logs []string
			g.RunRules(Dict{"policy": ".claude/policies/ghost.dw", "rules": gList(Dict{"match": "**/*.py", "run": gList("true")})}, []string{"x.py"}, &logs, proj, NewPolicyState())
			assert.True(t, anyContains(logs, "ghost.dw"))
		})
	})

	t.Run("default policy", func(t *testing.T) {
		type proj struct{ fake, calls, marker string }
		project := func(dir, name string, fakeOpts FakeDogwoodOpts) proj {
			fake, calls := WriteFakeDogwood(filepath.Join(dir, "bin"), fakeOpts)
			marker := filepath.Join(dir, "ran.marker")
			WriteGateYaml(dir, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList(Dict{"cmd": "touch " + marker, "name": name})})})
			WriteChangedFiles(dir, "sess1", "x.py")
			return proj{fake, calls, marker}
		}

		t.Run("bundled default policy is used when policy is unset", func(t *testing.T) {
			dir := tmpProj(t)
			p := project(dir, "pkg-a", FakeDogwoodOpts{})
			requireExit0(t, rules(dir, GateOpts{DogwoodBin: p.fake}))
			assert.True(t, Exists(p.marker))
			got := ReadCalls(p.calls)
			require.NotEmpty(t, got)
			assert.Equal(t, newGate(dir).DefaultPolicy, got[0].Argv[1])
		})

		t.Run("default policy deny skips and defers", func(t *testing.T) {
			dir := tmpProj(t)
			p := project(dir, "pkg-a", FakeDogwoodOpts{Deny: []string{"pkg-a"}})
			requireExit0(t, rules(dir, GateOpts{DogwoodBin: p.fake}))
			assert.False(t, Exists(p.marker))
			assert.Len(t, ReadDeferred(dir, "sess1"), 1)
		})

		t.Run("missing dogwood runs the command without deferring", func(t *testing.T) {
			dir := tmpProj(t)
			p := project(dir, "pkg-a", FakeDogwoodOpts{})
			requireExit0(t, rules(dir, GateOpts{DogwoodBin: filepath.Join(dir, "nope")}))
			assert.True(t, Exists(p.marker))
			assert.Empty(t, ReadDeferred(dir, "sess1"))
			// 判定していないので request は残らない。実行結果だけは履歴に積む。
			assert.Equal(t, []any{"response"}, traceKinds(dir))
		})

		t.Run("broken dogwood still skips and defers", func(t *testing.T) {
			dir := tmpProj(t)
			// fail-open するのはバイナリ不在のときだけ。dogwood は在るのに評価できないケースはスキップして控えに積む。
			for _, mode := range []string{"fail", "broken", "empty"} {
				sub := filepath.Join(dir, mode)
				require.NoError(t, os.MkdirAll(sub, 0o755))
				p := project(sub, "pkg-a", FakeDogwoodOpts{Mode: mode})
				requireExit0(t, rules(sub, GateOpts{DogwoodBin: p.fake}))
				assert.False(t, Exists(p.marker))
				assert.Len(t, ReadDeferred(sub, "sess1"), 1)
			}
		})

		t.Run("missing default policy file runs the command", func(t *testing.T) {
			dir := tmpProj(t)
			p := project(dir, "pkg-a", FakeDogwoodOpts{Verdict: "deny"})
			// Gate インスタンスの既定ポリシーを差し替えて main を呼ぶ。
			g := newGate(dir, GateOpts{Phase: "rules", DogwoodBin: p.fake})
			g.DefaultPolicy = filepath.Join(dir, "ghost-default.dw")
			assert.Equal(t, 0, g.Main())
			assert.True(t, Exists(p.marker))
			assert.Empty(t, ReadCalls(p.calls))
		})

		t.Run("default policy applies to consistency checks", func(t *testing.T) {
			dir := tmpProj(t)
			fake, _ := WriteFakeDogwood(filepath.Join(dir, "bin"), FakeDogwoodOpts{Deny: []string{"chk-cmd"}})
			marker := filepath.Join(dir, "chk.marker")
			WriteGateYaml(dir, Dict{
				"rules":              gList(Dict{"match": "**/*.py", "run": gList("true"), "run_checks": gList("chk")}),
				"consistency_checks": gList(Dict{"name": "chk", "run": gList(Dict{"cmd": "touch " + marker, "name": "chk-cmd"})}),
			})
			WriteChangedFiles(dir, "sess1", "x.py")
			requireExit0(t, rules(dir, GateOpts{DogwoodBin: fake}))
			requireExit0(t, checks(dir, GateOpts{DogwoodBin: fake}))
			assert.False(t, Exists(marker))
			assert.Len(t, ReadDeferred(dir, "sess1"), 1)
		})

		t.Run("missing policy file is logged by the named checks too", func(t *testing.T) {
			dir := tmpProj(t)
			fake, _ := WriteFakeDogwood(filepath.Join(dir, "bin"))
			WriteGateYaml(dir, Dict{
				"policy":             ".claude/policies/ghost.dw",
				"rules":              gList(Dict{"match": "**/*.py", "run": gList("true"), "run_checks": gList("chk")}),
				"consistency_checks": gList(Dict{"name": "chk", "run": gList("true")}),
			})
			WriteChangedFiles(dir, "sess1", "x.py")
			rules(dir, GateOpts{DogwoodBin: fake})
			r := checks(dir, GateOpts{DogwoodBin: fake, StopHookActive: true})
			assert.Equal(t, 0, r.ExitCode)
		})
	})

	// policy を設定した gate.yaml と偽 dogwood を用意し、(バイナリ, 呼び出し記録) を返す。
	policyProject := func(proj string, run []any, fakeOpts FakeDogwoodOpts) (string, string) {
		fake, calls := WriteFakeDogwood(filepath.Join(proj, "bin"), fakeOpts)
		WritePolicy(proj)
		WriteGateYaml(proj, Dict{"policy": ".claude/policies/gate.dw", "rules": gList(Dict{"match": "**/*.py", "run": run})})
		WriteChangedFiles(proj, "sess1", "x.py")
		return fake, calls
	}

	t.Run("policy decisions", func(t *testing.T) {
		t.Run("allow runs the command and records request and response", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "ran.marker")
			fake, calls := policyProject(proj, gList(Dict{"cmd": "touch " + marker, "name": "pkg-a"}), FakeDogwoodOpts{})
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			assert.True(t, Exists(marker))
			assert.Len(t, ReadCalls(calls), 1)
			assert.Equal(t, [][2]any{{"request", "pkg-a"}, {"response", "pkg-a"}}, traceKindNames(proj))
		})

		t.Run("allow with a failing command records error", func(t *testing.T) {
			proj := tmpProj(t)
			fake, _ := policyProject(proj, gList(Dict{"cmd": "false", "name": "pkg-a"}), FakeDogwoodOpts{})
			assert.Equal(t, 2, rules(proj, GateOpts{DogwoodBin: fake}).ExitCode)
			assert.Equal(t, []any{"request", "error"}, traceKinds(proj))
		})

		t.Run("deny skips the command without failing the phase", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "ran.marker")
			fake, _ := policyProject(proj, gList(Dict{"cmd": "touch " + marker, "name": "pkg-a"}), FakeDogwoodOpts{Deny: []string{"pkg-a"}})
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			assert.False(t, Exists(marker))
			// スキップは失敗ではないので、成功時と同じくファイルは CHANGED から外れる
			assert.False(t, Exists(filepath.Join(proj, ".claude", ".gate-status", "changed_files.sess1.txt")))
			assert.Equal(t, []any{"request"}, traceKinds(proj))
			entries := ReadDeferred(proj, "sess1")
			require.Len(t, entries, 1)
			assert.Equal(t, "touch "+marker, entries[0]["cmd"])
			assert.Equal(t, "pkg-a", entries[0]["name"])
		})

		t.Run("name defaults to the slug of the command", func(t *testing.T) {
			proj := tmpProj(t)
			fake, _ := policyProject(proj, gList("true"), FakeDogwoodOpts{})
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			assert.Equal(t, []any{Slug("true"), Slug("true")}, traceNames(proj))
		})
	})

	t.Run("policy evaluation failure", func(t *testing.T) {
		assertSkippedAndDeferred := func(t *testing.T, proj, fake string) {
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			assert.False(t, Exists(filepath.Join(proj, "ran.marker")))
			assert.Len(t, ReadDeferred(proj, "sess1"), 1)
			assert.Empty(t, ReadTraceRecords(proj, "sess1"))
		}

		t.Run("dogwood binary missing", func(t *testing.T) {
			proj := tmpProj(t)
			policyProject(proj, gList("touch "+filepath.Join(proj, "ran.marker")), FakeDogwoodOpts{})
			assertSkippedAndDeferred(t, proj, filepath.Join(proj, "nope"))
		})

		for _, mode := range []string{"fail", "broken", "empty"} {
			t.Run("dogwood mode "+mode, func(t *testing.T) {
				proj := tmpProj(t)
				fake, _ := policyProject(proj, gList("touch "+filepath.Join(proj, "ran.marker")), FakeDogwoodOpts{Mode: mode})
				assertSkippedAndDeferred(t, proj, fake)
			})
		}
	})

	t.Run("rule policy override", func(t *testing.T) {
		t.Run("rule policy is passed to dogwood instead of the top level one", func(t *testing.T) {
			proj := tmpProj(t)
			fake, calls := WriteFakeDogwood(filepath.Join(proj, "bin"))
			WritePolicy(proj, ".claude/policies/gate.dw")
			rulePolicy := WritePolicy(proj, ".claude/policies/hooks.dw")
			WriteGateYaml(proj, Dict{"policy": ".claude/policies/gate.dw", "rules": gList(Dict{"match": "**/*.py", "policy": ".claude/policies/hooks.dw", "run": gList("true")})})
			WriteChangedFiles(proj, "sess1", "x.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			got := ReadCalls(calls)
			require.NotEmpty(t, got)
			assert.Equal(t, "replay", got[0].Argv[0])
			assert.Equal(t, rulePolicy, got[0].Argv[1])
		})
	})

	t.Run("deferred drain", func(t *testing.T) {
		type two struct{ fake, calls, a, b string }
		twoRuleProject := func(proj string) two {
			fake, calls := WriteFakeDogwood(filepath.Join(proj, "bin"), FakeDogwoodOpts{Deny: []string{"pkg-a"}})
			WritePolicy(proj)
			a := filepath.Join(proj, "a.marker")
			b := filepath.Join(proj, "b.marker")
			WriteGateYaml(proj, Dict{
				"policy": ".claude/policies/gate.dw",
				"rules": gList(
					Dict{"match": "a.py", "run": gList(Dict{"cmd": "touch " + a, "name": "pkg-a"})},
					Dict{"match": "b.py", "run": gList(Dict{"cmd": "touch " + b, "name": "pkg-b"})},
				),
			})
			return two{fake, calls, a, b}
		}

		t.Run("deferred is drained on the run where a command was allowed", func(t *testing.T) {
			proj := tmpProj(t)
			p := twoRuleProject(proj)
			WriteChangedFiles(proj, "sess1", "a.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: p.fake}))
			assert.False(t, Exists(p.a))
			assert.Len(t, ReadDeferred(proj, "sess1"), 1)

			WriteChangedFiles(proj, "sess1", "b.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: p.fake}))
			assert.True(t, Exists(p.b))
			assert.True(t, Exists(p.a))
			assert.Empty(t, ReadDeferred(proj, "sess1"))
			// 控えの消化はポリシー判定をバイパスする（deny のままでは永久に消化されない）
			assert.Len(t, ReadCalls(p.calls), 2)
		})

		t.Run("drained command result is recorded without a request", func(t *testing.T) {
			proj := tmpProj(t)
			p := twoRuleProject(proj)
			WriteChangedFiles(proj, "sess1", "a.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: p.fake}))
			WriteChangedFiles(proj, "sess1", "b.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: p.fake}))
			assert.Equal(t, [][2]any{{"request", "pkg-a"}, {"request", "pkg-b"}, {"response", "pkg-b"}, {"response", "pkg-a"}}, traceKindNames(proj))
		})

		t.Run("a command deferred in the same run as an allow is not drained that run", func(t *testing.T) {
			proj := tmpProj(t)
			p := twoRuleProject(proj)
			WriteChangedFiles(proj, "sess1", "a.py", "b.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: p.fake}))
			assert.False(t, Exists(p.a))
			assert.True(t, Exists(p.b))
			assert.Len(t, ReadDeferred(proj, "sess1"), 1)
		})

		t.Run("an entry deferred in a prior run is drained on a later allowed run", func(t *testing.T) {
			proj := tmpProj(t)
			p := twoRuleProject(proj)
			WriteChangedFiles(proj, "sess1", "a.py", "b.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: p.fake}))
			assert.False(t, Exists(p.a))
			assert.Len(t, ReadDeferred(proj, "sess1"), 1)

			WriteChangedFiles(proj, "sess1", "b.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: p.fake}))
			assert.True(t, Exists(p.a))
			assert.Empty(t, ReadDeferred(proj, "sess1"))
		})

		t.Run("a key re-deferred after being allowed in the same run is not drained that run", func(t *testing.T) {
			proj := tmpProj(t)
			counter := filepath.Join(proj, "count.txt")
			WritePolicy(proj)
			WriteGateYaml(proj, Dict{
				"policy": ".claude/policies/gate.dw",
				"rules": gList(
					Dict{"match": "a.py", "run": gList(Dict{"cmd": "echo x >> " + counter, "name": "pkg-a"})},
					Dict{"match": "b.py", "run": gList(Dict{"cmd": "echo x >> " + counter, "name": "pkg-a"})},
				),
			})
			seed, _ := WriteFakeDogwood(filepath.Join(proj, "seed-bin"), FakeDogwoodOpts{Deny: []string{"pkg-a"}})
			flip, _ := WriteFakeDogwood(filepath.Join(proj, "flip-bin"), FakeDogwoodOpts{DenyAfterFirstCall: []string{"pkg-a"}})
			WriteChangedFiles(proj, "sess1", "a.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: seed}))
			assert.Len(t, ReadDeferred(proj, "sess1"), 1)

			WriteChangedFiles(proj, "sess1", "a.py", "b.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: flip}))
			assert.Equal(t, 1, countNonEmptyLines(counter))
			assert.Len(t, ReadDeferred(proj, "sess1"), 1)
		})

		t.Run("a deferred entry with a vanished cwd is discarded without running", func(t *testing.T) {
			proj := tmpProj(t)
			p := twoRuleProject(proj)
			ghostMarker := filepath.Join(proj, "ghost.marker")
			WriteDeferred(proj, "sess1", gList(Dict{"root": proj, "cwd": filepath.Join(proj, "ghost"), "name": "ghost", "cmd": "touch " + ghostMarker, "timeout": 300, "label": "ghost"}))
			WriteChangedFiles(proj, "sess1", "b.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: p.fake}))
			assert.True(t, Exists(p.b))
			assert.False(t, Exists(ghostMarker))
			assert.Empty(t, ReadDeferred(proj, "sess1"))
		})

		t.Run("an allow consumes the same command left in the deferred store", func(t *testing.T) {
			proj := tmpProj(t)
			counter := filepath.Join(proj, "count.txt")
			WritePolicy(proj)
			WriteGateYaml(proj, Dict{"policy": ".claude/policies/gate.dw", "rules": gList(Dict{"match": "a.py", "run": gList(Dict{"cmd": "echo x >> " + counter, "name": "pkg-a"})})})
			denyBin, _ := WriteFakeDogwood(filepath.Join(proj, "deny-bin"), FakeDogwoodOpts{Deny: []string{"pkg-a"}})
			allowBin, _ := WriteFakeDogwood(filepath.Join(proj, "allow-bin"))
			WriteChangedFiles(proj, "sess1", "a.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: denyBin}))
			assert.Len(t, ReadDeferred(proj, "sess1"), 1)
			WriteChangedFiles(proj, "sess1", "a.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: allowBin}))
			assert.Equal(t, 1, countNonEmptyLines(counter))
			assert.Empty(t, ReadDeferred(proj, "sess1"))
		})

		t.Run("deferred is not drained when nothing was allowed", func(t *testing.T) {
			proj := tmpProj(t)
			p := twoRuleProject(proj)
			WriteChangedFiles(proj, "sess1", "a.py")
			for range 2 {
				requireExit0(t, rules(proj, GateOpts{DogwoodBin: p.fake}))
			}
			assert.False(t, Exists(p.a))
			assert.Len(t, ReadDeferred(proj, "sess1"), 1)
		})
	})

	t.Run("checks phase with policy", func(t *testing.T) {
		reserved := func(proj string, checkRun []any, fakeOpts FakeDogwoodOpts) string {
			fake, _ := WriteFakeDogwood(filepath.Join(proj, "bin"), fakeOpts)
			WritePolicy(proj)
			WriteGateYaml(proj, Dict{
				"policy":             ".claude/policies/gate.dw",
				"rules":              gList(Dict{"match": "**/*.py", "run": gList("true"), "run_checks": gList("chk")}),
				"consistency_checks": gList(Dict{"name": "chk", "run": checkRun}),
			})
			WriteChangedFiles(proj, "sess1", "x.py")
			return fake
		}

		t.Run("a consistency check command is denied and skipped", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "chk.marker")
			fake := reserved(proj, gList(Dict{"cmd": "touch " + marker, "name": "chk-cmd"}), FakeDogwoodOpts{Deny: []string{"chk-cmd"}})
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			requireExit0(t, checks(proj, GateOpts{DogwoodBin: fake}))
			assert.False(t, Exists(marker))
			assert.Len(t, ReadDeferred(proj, "sess1"), 1)
		})

		t.Run("checks phase drains the deferred store along with reserved checks", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "chk.marker")
			deferredMarker := filepath.Join(proj, "deferred.marker")
			fake := reserved(proj, gList("touch "+marker), FakeDogwoodOpts{})
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			WriteDeferred(proj, "sess1", gList(Dict{"root": proj, "cwd": proj, "name": "left-over", "cmd": "touch " + deferredMarker, "timeout": 300, "label": "."}))
			requireExit0(t, checks(proj, GateOpts{DogwoodBin: fake, StopHookActive: true}))
			assert.True(t, Exists(marker))
			assert.True(t, Exists(deferredMarker))
			assert.Empty(t, ReadDeferred(proj, "sess1"))
		})

		t.Run("a reserved check that ran a command consumes the same command left in the deferred store", func(t *testing.T) {
			proj := tmpProj(t)
			counter := filepath.Join(proj, "count.txt")
			cmd := "echo x >> " + counter
			fake := reserved(proj, gList(Dict{"cmd": cmd, "name": "chk-cmd"}), FakeDogwoodOpts{})
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			WriteDeferred(proj, "sess1", gList(Dict{"root": proj, "cwd": proj, "name": "chk-cmd", "cmd": cmd, "timeout": 300, "label": "."}))
			requireExit0(t, checks(proj, GateOpts{DogwoodBin: fake, StopHookActive: true}))
			assert.Equal(t, 1, countNonEmptyLines(counter))
			assert.Empty(t, ReadDeferred(proj, "sess1"))
		})

		t.Run("a deferred command the reserved check did not run is still executed", func(t *testing.T) {
			proj := tmpProj(t)
			counter := filepath.Join(proj, "count.txt")
			cmd := "echo x >> " + counter
			fake := reserved(proj, gList(Dict{"cmd": cmd, "name": "chk-cmd"}), FakeDogwoodOpts{Deny: []string{"chk-cmd"}})
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			WriteDeferred(proj, "sess1", gList(Dict{"root": proj, "cwd": proj, "name": "other", "cmd": "echo y >> " + counter, "timeout": 300, "label": "."}))
			requireExit0(t, checks(proj, GateOpts{DogwoodBin: fake, StopHookActive: true}))
			var got []string
			for _, l := range strings.Split(Read(counter), "\n") {
				if l != "" {
					got = append(got, l)
				}
			}
			assert.Equal(t, []string{"y"}, got)
		})
	})

	t.Run("policy state file naming", func(t *testing.T) {
		t.Run("state files are split by state id", func(t *testing.T) {
			proj := tmpProj(t)
			fake, _ := policyProject(proj, gList(Dict{"cmd": "touch " + filepath.Join(proj, "ran.marker"), "name": "pkg-a"}), FakeDogwoodOpts{Deny: []string{"pkg-a"}})
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake}))
			assert.True(t, Exists(TracePath(proj, "sess1")))
			assert.True(t, Exists(DeferredPath(proj, "sess1")))
		})

		t.Run("state files carry the agent suffix", func(t *testing.T) {
			proj := tmpProj(t)
			fake, _ := policyProject(proj, gList(Dict{"cmd": "touch " + filepath.Join(proj, "ran.marker"), "name": "pkg-a"}), FakeDogwoodOpts{Deny: []string{"pkg-a"}})
			WriteChangedFiles(proj, "sess1--agent1", "x.py")
			requireExit0(t, rules(proj, GateOpts{DogwoodBin: fake, AgentID: "agent1"}))
			assert.True(t, Exists(TracePath(proj, "sess1--agent1")))
			assert.True(t, Exists(DeferredPath(proj, "sess1--agent1")))
			assert.False(t, Exists(TracePath(proj, "sess1")))
			assert.False(t, Exists(DeferredPath(proj, "sess1")))
		})
	})
}

func anyContains(ss []string, sub string) bool {
	for _, s := range ss {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}
