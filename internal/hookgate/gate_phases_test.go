package hookgate

// tests/gate-phases.spec.ts の移植。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// gList は []any のリテラルを短く書くための小物（YAML の配列に相当）。
func gList(xs ...any) []any {
	if xs == nil {
		return []any{}
	}
	return xs
}

// bandClock はテストで時間を注入する（TS の makeClock）。advance は登録された every の fn をすべて呼ぶ。
type bandClock struct {
	mu  sync.Mutex
	t   int64
	fns map[int]func()
	seq int
}

func newBandClock(t int64) *bandClock { return &bandClock{t: t, fns: map[int]func(){}} }

func (c *bandClock) now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *bandClock) every(_ int64, fn func()) func() {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := c.seq
	c.seq++
	c.fns[id] = fn
	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		delete(c.fns, id)
	}
}

func (c *bandClock) advance(ms int64) {
	c.mu.Lock()
	c.t += ms
	var fns []func()
	for i := range c.seq {
		if f, ok := c.fns[i]; ok {
			fns = append(fns, f)
		}
	}
	c.mu.Unlock()
	for _, f := range fns {
		f()
	}
}

func (c *bandClock) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.fns)
}

func anyMatch(re *regexp.Regexp, ss []string) bool {
	for _, s := range ss {
		if re.MatchString(s) {
			return true
		}
	}
	return false
}

func lastOf(ss []string) string {
	if len(ss) == 0 {
		return ""
	}
	return ss[len(ss)-1]
}

func TestGatePhases(t *testing.T) {
	t.Run("rules phase does not run consistency checks", func(t *testing.T) {
		t.Run("consistency checks are not executed", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "chk.marker")
			SetupReservedCheckProject(proj, "sess1", gList("touch "+marker), nil)
			requireExit0(t, rules(proj))
			assert.False(t, Exists(marker))
		})
	})

	t.Run("rules phase persists the reservation", func(t *testing.T) {
		t.Run("reservation is written to the pending file", func(t *testing.T) {
			proj := tmpProj(t)
			SetupReservedCheckProject(proj, "sess1", gList("true"), nil)
			requireExit0(t, rules(proj))
			assert.Equal(t, map[string]map[string][]string{proj: {"chk": {"x.py"}}}, ReadPending(proj, "sess1"))
		})

		t.Run("reservation accumulates across multiple rules phase runs", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{
				"rules":              gList(Dict{"match": "**/*.py", "run": gList("true"), "run_checks": gList("chk")}),
				"consistency_checks": gList(Dict{"name": "chk", "run": gList("true")}),
			})
			WriteChangedFiles(proj, "sess1", "a.py")
			requireExit0(t, rules(proj))
			WriteChangedFiles(proj, "sess1", "b.py")
			requireExit0(t, rules(proj))
			assert.Equal(t, map[string]map[string][]string{proj: {"chk": {"a.py", "b.py"}}}, ReadPending(proj, "sess1"))
		})

		t.Run("matched file moves from changed to sidecar, pending confirmation", func(t *testing.T) {
			proj := tmpProj(t)
			SetupReservedCheckProject(proj, "sess1", gList("true"), nil)
			requireExit0(t, rules(proj))
			assert.False(t, Exists(ChangedPath(proj, "sess1")))
			assert.Equal(t, []string{"x.py"}, strings.Fields(Read(SidecarPath(proj, "sess1"))))
		})
	})

	t.Run("checks phase runs only reserved checks", func(t *testing.T) {
		t.Run("only the referenced check runs", func(t *testing.T) {
			proj := tmpProj(t)
			used := filepath.Join(proj, "used.marker")
			unused := filepath.Join(proj, "unused.marker")
			SetupReservedCheckProject(proj, "sess1", gList("touch "+used), Dict{"name": "chk-unused", "run": gList("touch " + unused)})
			requireExit0(t, rules(proj))
			requireExit0(t, checks(proj, GateOpts{StopHookActive: true}))
			assert.True(t, Exists(used))
			assert.False(t, Exists(unused))
		})

		t.Run("success confirms and clears sidecar and pending", func(t *testing.T) {
			proj := tmpProj(t)
			SetupReservedCheckProject(proj, "sess1", gList("true"), nil)
			requireExit0(t, rules(proj))
			requireExit0(t, checks(proj, GateOpts{StopHookActive: true}))
			assert.False(t, Exists(SidecarPath(proj, "sess1")))
			assert.False(t, Exists(PendingPath(proj, "sess1")))
			assert.False(t, Exists(ChangedPath(proj, "sess1")))
		})
	})

	t.Run("checks phase is a noop when empty", func(t *testing.T) {
		t.Run("no pending file is a noop", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(), "consistency_checks": gList()})
			requireExit0(t, checks(proj))
			assert.False(t, Exists(AttemptsPath(proj, "sess1")))
		})

		t.Run("empty pending object is removed and is a noop", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(), "consistency_checks": gList()})
			WritePending(proj, "sess1", Dict{})
			requireExit0(t, checks(proj))
			assert.False(t, Exists(PendingPath(proj, "sess1")))
		})
	})

	t.Run("pending root isolation", func(t *testing.T) {
		t.Run("same named check runs independently per root", func(t *testing.T) {
			proj := tmpProj(t)
			mainMarker := filepath.Join(proj, "main_chk.marker")
			require.NoError(t, os.MkdirAll(filepath.Join(proj, "docs"), 0o755))
			WriteGateYaml(proj, Dict{
				"rules":              gList(Dict{"match": "docs/*.md", "dir": "docs", "run": gList("true"), "run_checks": gList("chk")}),
				"consistency_checks": gList(Dict{"name": "chk", "run": gList("touch " + mainMarker)}),
			})
			wt := filepath.Join(proj, ".claude", "worktrees", "agent-a1")
			require.NoError(t, os.MkdirAll(filepath.Join(wt, "pkg"), 0o755))
			wtMarker := filepath.Join(wt, "wt_chk.marker")
			WriteGateYaml(wt, Dict{
				"rules":              gList(Dict{"match": "pkg/*.go", "dir": "pkg", "run": gList("true"), "run_checks": gList("chk")}),
				"consistency_checks": gList(Dict{"name": "chk", "run": gList("touch " + wtMarker)}),
			})
			absFile := filepath.Join(wt, "pkg", "foo.go")
			WriteChangedFiles(proj, "sess1", "docs/readme.md", absFile)

			requireExit0(t, rules(proj))
			data := ReadPending(proj, "sess1")
			keys := []string{}
			for k := range data {
				keys = append(keys, k)
			}
			assert.ElementsMatch(t, []string{proj, wt}, keys)
			assert.Equal(t, map[string][]string{"chk": {"docs/readme.md"}}, data[proj])
			assert.Equal(t, map[string][]string{"chk": {absFile}}, data[wt])

			requireExit0(t, checks(proj, GateOpts{StopHookActive: true}))
			assert.True(t, Exists(mainMarker))
			assert.True(t, Exists(wtMarker))
		})

		t.Run("only the root with a reservation runs its check", func(t *testing.T) {
			proj := tmpProj(t)
			mainMarker := filepath.Join(proj, "main_chk.marker")
			require.NoError(t, os.MkdirAll(filepath.Join(proj, "docs"), 0o755))
			WriteGateYaml(proj, Dict{
				"rules":              gList(Dict{"match": "docs/*.md", "dir": "docs", "run": gList("true"), "run_checks": gList("chk")}),
				"consistency_checks": gList(Dict{"name": "chk", "run": gList("touch " + mainMarker)}),
			})
			wt := filepath.Join(proj, ".claude", "worktrees", "agent-a2")
			require.NoError(t, os.MkdirAll(wt, 0o755))
			wtMarker := filepath.Join(wt, "wt_chk.marker")
			WriteGateYaml(wt, Dict{"rules": gList(), "consistency_checks": gList(Dict{"name": "chk", "run": gList("touch " + wtMarker)})})
			WriteChangedFiles(proj, "sess1", "docs/readme.md")

			requireExit0(t, rules(proj))
			keys := []string{}
			for k := range ReadPending(proj, "sess1") {
				keys = append(keys, k)
			}
			assert.Equal(t, []string{proj}, keys)
			requireExit0(t, checks(proj, GateOpts{StopHookActive: true}))
			assert.True(t, Exists(mainMarker))
			assert.False(t, Exists(wtMarker))
		})
	})

	t.Run("cleanup", func(t *testing.T) {
		t.Run("cleanup removes the pending file", func(t *testing.T) {
			proj := tmpProj(t)
			WritePending(proj, "sess1", Dict{proj: Dict{"chk": gList("x.py")}})
			g := newGate(proj)
			assert.True(t, Exists(PendingPath(proj, "sess1")))
			g.Cleanup(nil)
			assert.False(t, Exists(PendingPath(proj, "sess1")))
		})

		t.Run("cleanup only count and pending keeps changed and sidecar", func(t *testing.T) {
			proj := tmpProj(t)
			WriteChangedFiles(proj, "sess1", "a.py")
			WritePending(proj, "sess1", Dict{proj: Dict{"chk": gList("x.py")}})
			g := newGate(proj)
			require.NoError(t, os.WriteFile(g.Count, []byte("3"), 0o644))
			g.Cleanup([]string{g.Count, g.Pending})
			assert.False(t, Exists(g.Count))
			assert.False(t, Exists(g.Pending))
			assert.True(t, Exists(g.Changed))
		})
	})

	t.Run("checks phase max attempts requeues to changed", func(t *testing.T) {
		t.Run("max attempts requeues and keeps changed, removes count and pending", func(t *testing.T) {
			proj := tmpProj(t)
			SetupReservedCheckProject(proj, "sess1", gList("false"), nil)
			requireExit0(t, rules(proj))
			assert.True(t, Exists(SidecarPath(proj, "sess1")))
			assert.True(t, Exists(PendingPath(proj, "sess1")))
			assert.False(t, Exists(ChangedPath(proj, "sess1")))

			r := checks(proj)
			for i := 1; i < 5; i++ {
				r = checks(proj, GateOpts{StopHookActive: true})
			}
			assert.Equal(t, 0, r.ExitCode)
			assert.Contains(t, r.Stdout, "systemMessage")
			assert.Contains(t, r.Stdout, "未検証のまま CHANGED へ戻しました")
			assert.Contains(t, r.Stdout, "手動で確認してください")
			assert.Contains(t, r.Stdout, "reset-gate")

			assert.False(t, Exists(AttemptsPath(proj, "sess1")))
			assert.False(t, Exists(PendingPath(proj, "sess1")))
			assert.False(t, Exists(SidecarPath(proj, "sess1")))
			assert.Equal(t, []string{"x.py"}, strings.Fields(Read(ChangedPath(proj, "sess1"))))
		})

		t.Run("attempts accumulate across checks phase retries", func(t *testing.T) {
			proj := tmpProj(t)
			SetupReservedCheckProject(proj, "sess1", gList("false"), nil)
			requireExit0(t, rules(proj))
			r := checks(proj, GateOpts{StopHookActive: true})
			for i := 1; i < 4; i++ {
				r = checks(proj, GateOpts{StopHookActive: true})
			}
			assert.Equal(t, 2, r.ExitCode)
			assert.Equal(t, "4", AttemptsCount(proj, "sess1"))
		})

		t.Run("attempts reset when stop hook is not active", func(t *testing.T) {
			proj := tmpProj(t)
			SetupReservedCheckProject(proj, "sess1", gList("false"), nil)
			requireExit0(t, rules(proj))
			r1 := checks(proj, GateOpts{StopHookActive: false})
			assert.Equal(t, 2, r1.ExitCode)
			assert.Equal(t, "1", AttemptsCount(proj, "sess1"))
			r2 := checks(proj, GateOpts{StopHookActive: false})
			assert.Equal(t, 2, r2.ExitCode)
			assert.Equal(t, "1", AttemptsCount(proj, "sess1"))
		})
	})

	t.Run("rules phase does not block the conversation", func(t *testing.T) {
		t.Run("failure exits 2 with stderr and no stdout decision", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList("echo BOOM && false")})})
			WriteChangedFiles(proj, "sess1", "x.py")
			r := rules(proj)
			assert.Equal(t, 2, r.ExitCode)
			assert.Contains(t, r.Stderr, "BOOM")
			assert.NotContains(t, r.Stdout, "decision")
		})
	})

	t.Run("checks phase reruns rules that failed and were not fixed", func(t *testing.T) {
		failedPath := func(proj, id string) string { return StatePath(proj, "gate_failed", id, "txt") }
		// proj/broken があるあいだ失敗する lint。run_checks を足すと consistency_check "chk"（常に成功）を予約する。
		setup := func(proj, session string, withCheck bool) {
			rule := Dict{"match": "**/*.py", "run": gList(Dict{"name": "lint", "cmd": "[ ! -f broken ] || { echo LINT-FAIL; exit 1; }"})}
			if withCheck {
				rule["run_checks"] = gList("chk")
			}
			WriteGateYaml(proj, Dict{"rules": gList(rule), "consistency_checks": gList(Dict{"name": "chk", "run": gList(Dict{"name": "build", "cmd": "true"})})})
			Touch(proj, "broken")
			WriteChangedFiles(proj, session, "x.py")
		}
		decisionOf := func(stdout string) (string, string) {
			ls := strings.Split(strings.TrimSpace(stdout), "\n")
			var d struct {
				Decision string `json:"decision"`
				Reason   string `json:"reason"`
			}
			_ = json.Unmarshal([]byte(ls[len(ls)-1]), &d)
			return d.Decision, d.Reason
		}

		t.Run("a stop after an unfixed rules failure reruns the rule and blocks", func(t *testing.T) {
			proj := tmpProj(t)
			setup(proj, "sess1", false)
			assert.Equal(t, 2, rules(proj).ExitCode)
			assert.Equal(t, []string{"x.py"}, Lines(failedPath(proj, "sess1")))
			r := checks(proj)
			assert.Equal(t, 2, r.ExitCode)
			assert.Contains(t, r.Stderr, "LINT-FAIL")
			decision, reason := decisionOf(r.Stdout)
			assert.Equal(t, "block", decision)
			assert.Contains(t, reason, "検証に失敗しました（試行 1/5）")
			assert.Equal(t, []string{"x.py"}, Lines(failedPath(proj, "sess1")))
		})

		t.Run("once fixed, the stop reruns the rule, clears the failure and reports success", func(t *testing.T) {
			proj := tmpProj(t)
			setup(proj, "sess1", false)
			assert.Equal(t, 2, rules(proj).ExitCode)
			require.NoError(t, os.Remove(filepath.Join(proj, "broken")))
			r := checks(proj)
			_, reason := decisionOf(r.Stdout)
			assert.Contains(t, reason, "検証がすべて通りました: lint ✓")
			assert.False(t, Exists(failedPath(proj, "sess1")))
			assert.False(t, Exists(ChangedPath(proj, "sess1")))
		})

		t.Run("a passing reserved check no longer hides the failed rule behind a success report", func(t *testing.T) {
			proj := tmpProj(t)
			setup(proj, "sess1", true)
			assert.Equal(t, 2, rules(proj).ExitCode)
			r := checks(proj)
			assert.Equal(t, 2, r.ExitCode)
			_, reason := decisionOf(r.Stdout)
			assert.NotContains(t, reason, "検証がすべて通りました")
			assert.Contains(t, reason, "検証に失敗しました")
		})

		t.Run("a later rules run that passes drops the file from the failures", func(t *testing.T) {
			proj := tmpProj(t)
			setup(proj, "sess1", false)
			assert.Equal(t, 2, rules(proj).ExitCode)
			require.NoError(t, os.Remove(filepath.Join(proj, "broken")))
			requireExit0(t, rules(proj))
			assert.False(t, Exists(failedPath(proj, "sess1")))
			requireExit0(t, checks(proj))
		})

		t.Run("gives up after MAX_ATTEMPTS: the failure is dropped, the file stays in changed", func(t *testing.T) {
			proj := tmpProj(t)
			setup(proj, "sess1", false)
			assert.Equal(t, 2, rules(proj).ExitCode)
			r := checks(proj)
			for i := 1; i < 5; i++ {
				r = checks(proj, GateOpts{StopHookActive: true})
			}
			assert.Equal(t, 0, r.ExitCode)
			assert.False(t, Exists(failedPath(proj, "sess1")))
			assert.Equal(t, []string{"x.py"}, ChangedLines(proj, "sess1"))
			requireExit0(t, checks(proj))
		})

		t.Run("a subagent stop blocks on its own failures", func(t *testing.T) {
			proj := tmpProj(t)
			setup(proj, "sess1--a1", false)
			assert.Equal(t, 2, rules(proj, GateOpts{Session: "sess1", AgentID: "a1"}).ExitCode)
			requireExit0(t, checks(proj, GateOpts{Session: "sess1"}))
			assert.Equal(t, 2, checks(proj, GateOpts{Session: "sess1", AgentID: "a1"}).ExitCode)
		})
	})

	t.Run("checks phase failure stdout", func(t *testing.T) {
		t.Run("exits 2 with parseable json stdout", func(t *testing.T) {
			proj := tmpProj(t)
			SetupReservedCheckProject(proj, "sess1", gList("echo BOOM && false"), nil)
			requireExit0(t, rules(proj))
			r := checks(proj, GateOpts{StopHookActive: false})
			assert.Equal(t, 2, r.ExitCode)
			assert.Contains(t, r.Stderr, "BOOM")
			var payload struct {
				Decision string `json:"decision"`
				Reason   string `json:"reason"`
			}
			require.NoError(t, json.Unmarshal([]byte(r.Stdout), &payload))
			assert.Equal(t, "block", payload.Decision)
			assert.NotEmpty(t, payload.Reason)
		})

		t.Run(`json stdout survives a "no such file" stderr`, func(t *testing.T) {
			proj := tmpProj(t)
			SetupReservedCheckProject(proj, "sess1", gList("cat /no/such/file/here 2>&1; false"), nil)
			requireExit0(t, rules(proj))
			r := checks(proj, GateOpts{StopHookActive: false})
			assert.Equal(t, 2, r.ExitCode)
			assert.Contains(t, strings.ToLower(r.Stderr), "no such file")
			assert.NotEqual(t, "", strings.TrimSpace(r.Stdout))
			assert.True(t, json.Valid([]byte(r.Stdout)))
		})

		t.Run("success under stop_hook_active has no decision field", func(t *testing.T) {
			proj := tmpProj(t)
			SetupReservedCheckProject(proj, "sess1", gList("true"), nil)
			requireExit0(t, rules(proj))
			r := checks(proj, GateOpts{StopHookActive: true})
			assert.Equal(t, 0, r.ExitCode)
			if strings.TrimSpace(r.Stdout) != "" {
				var m map[string]any
				require.NoError(t, json.Unmarshal([]byte(r.Stdout), &m))
				assert.NotContains(t, m, "decision")
			}
		})

		t.Run("max attempts giveup has no decision field", func(t *testing.T) {
			proj := tmpProj(t)
			SetupReservedCheckProject(proj, "sess1", gList("false"), nil)
			requireExit0(t, rules(proj))
			r := checks(proj, GateOpts{StopHookActive: false})
			for i := 1; i < 5; i++ {
				r = checks(proj, GateOpts{StopHookActive: true})
			}
			assert.Equal(t, 0, r.ExitCode)
			var m map[string]any
			require.NoError(t, json.Unmarshal([]byte(r.Stdout), &m))
			assert.NotContains(t, m, "decision")
		})
	})

	t.Run("worktree grouping (rules phase)", func(t *testing.T) {
		t.Run("worktree path uses the worktree gate.yaml and cwd", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.md", "run": gList("true")})})
			wt := filepath.Join(proj, ".claude", "worktrees", "agent-a1")
			pkgDir := filepath.Join(wt, "pkg")
			require.NoError(t, os.MkdirAll(pkgDir, 0o755))
			WriteGateYaml(wt, Dict{"rules": gList(Dict{"match": "pkg/*.go", "dir": "pkg", "run": gList("touch ok.marker")})})
			WriteChangedFiles(proj, "sess1", filepath.Join(wt, "pkg", "foo.go"))
			requireExit0(t, rules(proj))
			assert.True(t, Exists(filepath.Join(pkgDir, "ok.marker")))
			assert.False(t, Exists(ChangedPath(proj, "sess1")))
		})

		t.Run("missing worktree gate.yaml falls back to the main cfg", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "pkg/*.go", "dir": "pkg", "run": gList("touch fallback.marker")})})
			wt := filepath.Join(proj, ".claude", "worktrees", "agent-a2")
			pkgDir := filepath.Join(wt, "pkg")
			require.NoError(t, os.MkdirAll(pkgDir, 0o755))
			WriteChangedFiles(proj, "sess1", filepath.Join(wt, "pkg", "foo.go"))
			requireExit0(t, rules(proj))
			// メインの cfg のルールが、cwd は proj/pkg ではなく wt/pkg で実行された
			assert.True(t, Exists(filepath.Join(pkgDir, "fallback.marker")))
			assert.False(t, Exists(filepath.Join(proj, "pkg")))
		})

		t.Run("main and worktree mixed memo runs both roots", func(t *testing.T) {
			proj := tmpProj(t)
			require.NoError(t, os.MkdirAll(filepath.Join(proj, "docs"), 0o755))
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "docs/*.md", "dir": "docs", "run": gList("touch main.marker")})})
			wt := filepath.Join(proj, ".claude", "worktrees", "agent-a3")
			pkgDir := filepath.Join(wt, "pkg")
			require.NoError(t, os.MkdirAll(pkgDir, 0o755))
			WriteGateYaml(wt, Dict{"rules": gList(Dict{"match": "pkg/*.go", "dir": "pkg", "run": gList("touch wt.marker")})})
			WriteChangedFiles(proj, "sess1", "docs/readme.md", filepath.Join(wt, "pkg", "foo.go"))
			requireExit0(t, rules(proj))
			assert.True(t, Exists(filepath.Join(proj, "docs", "main.marker")))
			assert.True(t, Exists(filepath.Join(pkgDir, "wt.marker")))
			assert.False(t, Exists(ChangedPath(proj, "sess1")))
		})

		t.Run("failure writes back the raw representation", func(t *testing.T) {
			proj := tmpProj(t)
			require.NoError(t, os.MkdirAll(filepath.Join(proj, "docs"), 0o755))
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "docs/*.md", "dir": "docs", "run": gList("touch main.marker")})})
			wt := filepath.Join(proj, ".claude", "worktrees", "agent-a4")
			require.NoError(t, os.MkdirAll(filepath.Join(wt, "pkg"), 0o755))
			WriteGateYaml(wt, Dict{"rules": gList(Dict{"match": "pkg/*.go", "dir": "pkg", "run": gList("false")})})
			absFile := filepath.Join(wt, "pkg", "foo.go")
			WriteChangedFiles(proj, "sess1", "docs/readme.md", absFile)
			r := rules(proj, GateOpts{StopHookActive: false})
			assert.Equal(t, 2, r.ExitCode)
			// worktree 分は失敗したので元の絶対パス表記のまま CHANGED に残る
			assert.Equal(t, []string{absFile}, ChangedLines(proj, "sess1"))
			// main 分は run_checks が無いので、成功済みとして完全に手を離している（SIDECAR には退避しない）
			assert.False(t, Exists(SidecarPath(proj, "sess1")))
		})

		t.Run("missing worktree directory is skipped with a warning", func(t *testing.T) {
			proj := tmpProj(t)
			require.NoError(t, os.MkdirAll(filepath.Join(proj, "docs"), 0o755))
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "docs/*.md", "dir": "docs", "run": gList("touch main.marker")})})
			ghost := filepath.Join(proj, ".claude", "worktrees", "agent-ghost", "pkg", "foo.go")
			WriteChangedFiles(proj, "sess1", "docs/readme.md", ghost)
			requireExit0(t, rules(proj))
			assert.True(t, Exists(filepath.Join(proj, "docs", "main.marker")))
			assert.False(t, Exists(ChangedPath(proj, "sess1")))
		})

		t.Run("missing worktree directory is consumed, others continue on failure", func(t *testing.T) {
			proj := tmpProj(t)
			require.NoError(t, os.MkdirAll(filepath.Join(proj, "a"), 0o755))
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "a/*.txt", "dir": "a", "run": gList("false")})})
			ghost := filepath.Join(proj, ".claude", "worktrees", "agent-ghost", "pkg", "foo.go")
			WriteChangedFiles(proj, "sess1", "a/x.txt", ghost)
			r := rules(proj, GateOpts{StopHookActive: false})
			assert.Equal(t, 2, r.ExitCode)
			assert.Equal(t, []string{"a/x.txt"}, ChangedLines(proj, "sess1"))
			assert.False(t, Exists(SidecarPath(proj, "sess1")))
		})
	})

	t.Run("agent id state files", func(t *testing.T) {
		t.Run("rules phase uses suffixed changed and pending files", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{
				"rules":              gList(Dict{"match": "**/*.py", "run": gList("true"), "run_checks": gList("chk")}),
				"consistency_checks": gList(Dict{"name": "chk", "run": gList("true")}),
			})
			WriteChangedFiles(proj, "sess1--agent1", "x.py")
			requireExit0(t, rules(proj, GateOpts{Session: "sess1", AgentID: "agent1"}))
			assert.True(t, Exists(PendingPath(proj, "sess1--agent1")))
			assert.False(t, Exists(PendingPath(proj, "sess1")))
		})

		t.Run("checks phase uses the suffixed attempts file", func(t *testing.T) {
			proj := tmpProj(t)
			SetupReservedCheckProject(proj, "sess1--agent1", gList("false"), nil)
			requireExit0(t, rules(proj, GateOpts{Session: "sess1", AgentID: "agent1"}))
			r := checks(proj, GateOpts{Session: "sess1", StopHookActive: false, AgentID: "agent1"})
			assert.Equal(t, 2, r.ExitCode)
			assert.True(t, Exists(AttemptsPath(proj, "sess1--agent1")))
			assert.False(t, Exists(AttemptsPath(proj, "sess1")))
		})

		t.Run("main session rules phase ignores another agent memo", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList("true")})})
			WriteChangedFiles(proj, "sess1--agent1", "other_agent_file.py")
			requireExit0(t, rules(proj))
			// 実行中の別エージェントのメモには手を付けない
			assert.True(t, Exists(ChangedPath(proj, "sess1--agent1")))
		})
	})

	t.Run("gate without gate.yaml", func(t *testing.T) {
		t.Run("is a no-op", func(t *testing.T) {
			proj := tmpProj(t)
			Touch(proj, "x.py")
			r := gate(proj, GateOpts{Phase: "rules"})
			assert.Equal(t, ScriptResult{ExitCode: 0, Stdout: "", Stderr: ""}, r)
		})
	})

	// 実行中は帯（redraw のたびの bandLog）に複数行で出し、全部終わったら帯を消してステータス行（resultLog）に 1 行の結果を残す。
	t.Run("progress band", func(t *testing.T) {
		// rules フェーズで consistency_checks を予約しておく（checks フェーズは予約分しか実行しない）。
		setup := func(t *testing.T, proj string, run []any) {
			WriteGateYaml(proj, Dict{
				"rules":              gList(Dict{"match": "**/*.py", "run": gList("true"), "run_checks": gList("chk")}),
				"consistency_checks": gList(Dict{"name": "chk", "run": run}),
			})
			WriteChangedFiles(proj, "sess1", "x.py")
			requireExit0(t, rules(proj))
		}

		t.Run("checks phase draws the running command in the band, redraws elapsed seconds, then hides it and leaves one result line", func(t *testing.T) {
			proj := tmpProj(t)
			setup(t, proj, gList(Dict{"cmd": "sleep 0.4", "name": "slow"}))
			var bandLog, resultLog, progressLog []string
			c := newBandClock(1_000_000)
			io := MakeIo(IoOpts{ProjectDir: proj, BandLog: &bandLog, ResultLog: &resultLog, ProgressLog: &progressLog, Now: c.now, Every: c.every})
			done := make(chan ScriptResult, 1)
			go func() {
				done <- RunGate(io, GateOptions{SessionID: "sess1", Phase: "checks", StopHookActive: true})
			}()
			time.Sleep(150 * time.Millisecond)
			c.advance(35_000)
			time.Sleep(50 * time.Millisecond)
			requireExit0(t, <-done)
			require.NotEmpty(t, bandLog)
			assert.Equal(t, "[gate] 実行中:\n  slow $ sleep 0.4 (0s)", bandLog[0])
			assert.Contains(t, bandLog, "[gate] 実行中:\n  slow $ sleep 0.4 (35s)")
			assert.Equal(t, "", lastOf(bandLog))
			assert.Regexp(t, `^\[gate\] 完了: ✓ 1 \(\d+\.\ds\)$`, lastOf(resultLog))
			assert.Empty(t, progressLog)
			assert.Equal(t, 0, c.size())
		})

		t.Run("parallel commands are listed together and finished ones stay with a check mark", func(t *testing.T) {
			proj := tmpProj(t)
			setup(t, proj, gList(Dict{"parallel": gList(Dict{"cmd": "sleep 0.4", "name": "a"}, Dict{"cmd": "sleep 0.1", "name": "b"})}))
			var bandLog, resultLog []string
			io := MakeIo(IoOpts{ProjectDir: proj, BandLog: &bandLog, ResultLog: &resultLog})
			requireExit0(t, RunGate(io, GateOptions{SessionID: "sess1", Phase: "checks", StopHookActive: true}))
			assert.Contains(t, bandLog, "[gate] 実行中:\n  a $ sleep 0.4 (0s)\n  b $ sleep 0.1 (0s)")
			assert.True(t, anyMatch(regexp.MustCompile(`^\[gate\] 実行中:\n {2}a \$ sleep 0\.4 \(0s\)\n {2}b ✓ \(\d+\.\ds\)$`), bandLog))
			// 全部終わったら帯は消え、結果は帯ではなくステータス行に 1 行で出る。
			assert.Equal(t, "", lastOf(bandLog))
			assert.Regexp(t, `^\[gate\] 完了: ✓ 2 \(\d+\.\ds\)$`, lastOf(resultLog))
		})

		t.Run("a failed command stays with a cross mark and a command without a name is shown by its cmd", func(t *testing.T) {
			proj := tmpProj(t)
			setup(t, proj, gList(Dict{"parallel": gList(Dict{"cmd": "sleep 0.3", "name": "a"}, Dict{"cmd": "exit 1"})}))
			var bandLog, resultLog []string
			io := MakeIo(IoOpts{ProjectDir: proj, BandLog: &bandLog, ResultLog: &resultLog})
			RunGate(io, GateOptions{SessionID: "sess1", Phase: "checks"})
			assert.True(t, anyMatch(regexp.MustCompile(`^\[gate\] 実行中:\n {2}a \$ sleep 0\.3 \(0s\)\n {2}exit 1 ✗ \(\d+\.\ds\)$`), bandLog))
			assert.Equal(t, "", lastOf(bandLog))
			assert.Regexp(t, `^\[gate\] 完了: ✓ 1 / ✗ 1 \(\d+\.\ds\)$`, lastOf(resultLog))
		})

		t.Run("sequential commands: each result lands on the status line, and the next command clears it and returns to the band", func(t *testing.T) {
			proj := tmpProj(t)
			setup(t, proj, gList(Dict{"cmd": "true", "name": "first"}, Dict{"cmd": "sleep 0.1", "name": "second"}))
			var bandLog, resultLog []string
			io := MakeIo(IoOpts{ProjectDir: proj, BandLog: &bandLog, ResultLog: &resultLog})
			requireExit0(t, RunGate(io, GateOptions{SessionID: "sess1", Phase: "checks", StopHookActive: true}))
			assert.True(t, anyMatch(regexp.MustCompile(`^\[gate\] 実行中:\n {2}first ✓ \(\d+\.\ds\)\n {2}second \$ sleep 0\.1 \(0s\)$`), bandLog))
			assert.Equal(t, "", lastOf(bandLog))
			// 結果 → 次の開始で消える → 結果、の順。
			secs := regexp.MustCompile(`\d+\.\ds`)
			got := make([]string, len(resultLog))
			for i, l := range resultLog {
				if l == "" {
					got[i] = "clear"
				} else {
					got[i] = secs.ReplaceAllString(l, "Ns")
				}
			}
			assert.Equal(t, []string{"clear", "[gate] 完了: ✓ 1 (Ns)", "clear", "[gate] 完了: ✓ 2 (Ns)"}, got)
		})

		t.Run("rules phase draws the running command in the same format", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList(Dict{"cmd": "true", "name": "fmt"})})})
			WriteChangedFiles(proj, "sess1", "x.py")
			var bandLog, resultLog []string
			io := MakeIo(IoOpts{ProjectDir: proj, BandLog: &bandLog, ResultLog: &resultLog})
			requireExit0(t, RunGate(io, GateOptions{SessionID: "sess1", Phase: "rules"}))
			require.NotEmpty(t, bandLog)
			assert.Equal(t, "[gate] 実行中:\n  fmt $ true (0s)", bandLog[0])
			assert.Equal(t, "", lastOf(bandLog))
			assert.Regexp(t, `^\[gate\] 完了: ✓ 1 \(\d+\.\ds\)$`, lastOf(resultLog))
		})
	})

	t.Run("checks phase reports success once", func(t *testing.T) {
		reportedPath := func(proj, id string) string { return StatePath(proj, "gate_reported", id, "txt") }
		countLines := func(p string) int {
			if !Exists(p) {
				return 0
			}
			n := 0
			for _, l := range strings.Split(Read(p), "\n") {
				if l != "" {
					n++
				}
			}
			return n
		}
		lastLineJSON := func(stdout string) map[string]any {
			ls := strings.Split(strings.TrimSpace(stdout), "\n")
			var m map[string]any
			require.NoError(t, json.Unmarshal([]byte(ls[len(ls)-1]), &m))
			return m
		}
		setupNamed := func(proj string, extra Dict) {
			cfg := Dict{
				"rules": gList(Dict{"match": "**/*.py", "run": gList("true"), "run_checks": gList("chk")}),
				"consistency_checks": gList(Dict{
					"name": "chk",
					"run":  gList(Dict{"cmd": "true", "name": "lint"}, Dict{"cmd": "true", "name": "typecheck"}),
				}),
			}
			for k, v := range extra {
				cfg[k] = v
			}
			WriteGateYaml(proj, cfg)
			WriteChangedFiles(proj, "sess1", "x.py")
		}

		t.Run("blocks with the executed commands when everything passed", func(t *testing.T) {
			proj := tmpProj(t)
			setupNamed(proj, nil)
			requireExit0(t, rules(proj))
			r := checks(proj)
			assert.Equal(t, 2, r.ExitCode)
			body := lastLineJSON(r.Stdout)
			assert.Equal(t, "block", body["decision"])
			assert.Contains(t, body["reason"], "[gate] 検証がすべて通りました: lint ✓ / typecheck ✓")
			assert.Contains(t, body["reason"], "報告")
			assert.True(t, Exists(reportedPath(proj, "sess1")))
		})

		t.Run("the success report is in English when the language is en", func(t *testing.T) {
			proj := tmpProj(t)
			setupNamed(proj, nil)
			requireExit0(t, rules(proj, GateOpts{Lang: LangEN}))
			r := checks(proj, GateOpts{Lang: LangEN})
			assert.Equal(t, 2, r.ExitCode)
			body := lastLineJSON(r.Stdout)
			assert.Equal(t, "[gate] All checks passed: lint ✓ / typecheck ✓. Report this result to the user and finish.", body["reason"])
			assert.NotRegexp(t, `[ぁ-んァ-ン一-龥]`, r.Stderr)
		})

		t.Run("does not block when stop_hook_active is true", func(t *testing.T) {
			proj := tmpProj(t)
			setupNamed(proj, nil)
			requireExit0(t, rules(proj))
			requireExit0(t, checks(proj, GateOpts{StopHookActive: true}))
			assert.False(t, Exists(reportedPath(proj, "sess1")))
		})

		t.Run("does not block when nothing was executed", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{"rules": gList(), "consistency_checks": gList()})
			WritePending(proj, "sess1", Dict{})
			requireExit0(t, checks(proj))
			assert.False(t, Exists(reportedPath(proj, "sess1")))
		})

		t.Run("report_success: false disables the report", func(t *testing.T) {
			proj := tmpProj(t)
			setupNamed(proj, Dict{"report_success": false})
			requireExit0(t, rules(proj))
			r := checks(proj)
			requireExit0(t, r)
			assert.Contains(t, r.Stdout, "成功")
			assert.False(t, Exists(reportedPath(proj, "sess1")))
		})

		t.Run("the stop right after a success report runs no command and drops the marker", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "runs.marker")
			SetupReservedCheckProject(proj, "sess1", gList("echo x >> "+marker), nil)
			requireExit0(t, rules(proj))
			assert.Equal(t, 2, checks(proj).ExitCode)
			assert.Equal(t, 1, countLines(marker))

			// 予約が残っていても走らせない
			WritePending(proj, "sess1", Dict{proj: Dict{"chk": gList("x.py")}})
			followUp := checks(proj, GateOpts{StopHookActive: true})
			requireExit0(t, followUp)
			assert.True(t, followUp.ReportConsumed)
			assert.Equal(t, 1, countLines(marker))
			assert.False(t, Exists(reportedPath(proj, "sess1")))
			assert.True(t, Exists(PendingPath(proj, "sess1")))
		})

		t.Run("a new user turn after a report still runs the checks", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "runs.marker")
			SetupReservedCheckProject(proj, "sess1", gList("echo x >> "+marker), nil)
			requireExit0(t, rules(proj))
			assert.Equal(t, 2, checks(proj).ExitCode)
			WritePending(proj, "sess1", Dict{proj: Dict{"chk": gList("x.py")}})
			next := checks(proj)
			assert.Equal(t, 2, next.ExitCode)
			assert.False(t, next.ReportConsumed)
			assert.Equal(t, 2, countLines(marker))
		})

		t.Run("after a failure block the next stop reruns the checks", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "runs.marker")
			SetupReservedCheckProject(proj, "sess1", gList("echo x >> "+marker+"; exit 1"), nil)
			requireExit0(t, rules(proj))
			first := checks(proj)
			assert.Equal(t, 2, first.ExitCode)
			assert.Contains(t, lastLineJSON(first.Stdout)["reason"], "検証に失敗しました（試行")
			assert.False(t, Exists(reportedPath(proj, "sess1")))
			second := checks(proj, GateOpts{StopHookActive: true})
			assert.Equal(t, 2, second.ExitCode)
			assert.Equal(t, 2, countLines(marker))
		})
	})
}
