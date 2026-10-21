package hookgate

// tests/gate-sharing.spec.ts の移植。

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func sharingCount(file string) int {
	if !Exists(file) {
		return 0
	}
	n := 0
	for _, l := range strings.Split(Read(file), "\n") {
		if l != "" {
			n++
		}
	}
	return n
}

func sharingLogFiles(proj, stateID string) []string {
	dir := filepath.Join(proj, ".claude", ".gate-status", "logs", stateID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

// sharedLogs は複数の Gate が同じ bandLog / resultLog へ書くテスト用のログ。mu で書き込みと読み出しを直列にする。
type sharedLogs struct {
	mu     sync.Mutex
	band   []string
	result []string
}

func (l *sharedLogs) bandSnapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.band...)
}

func (l *sharedLogs) resultSnapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.result...)
}

// nonEmpty は undefined（""）を除いたもの（TS の `filter((l) => l !== undefined)`）。
func nonEmpty(ss []string) []string {
	out := []string{}
	for _, s := range ss {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func agentIo(proj string, logs *sharedLogs) Io {
	opts := IoOpts{ProjectDir: proj, Env: EnvVars{DogwoodBin: MissingDogwoodBin}}
	if logs == nil {
		return MakeIo(opts)
	}
	opts.BandLog = &logs.band
	opts.ResultLog = &logs.result
	return syncIo{Io: MakeIo(opts), mu: &logs.mu}
}

func agentGate(proj, agentID string, logs *sharedLogs) *Gate {
	return NewGate(agentIo(proj, logs), GateOptions{SessionID: "sess1", AgentID: agentID, Phase: "rules"})
}

// concurrently は fns を並行に走らせて全部の完了を待つ（Promise.all 相当）。
func concurrently(fns ...func()) {
	var wg sync.WaitGroup
	for _, fn := range fns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fn()
		}()
	}
	wg.Wait()
}

func TestGateSharing(t *testing.T) {
	t.Run("two agents running the same command", func(t *testing.T) {
		setup := func(proj, tail string, extra Dict) string {
			marker := filepath.Join(proj, "marker.txt")
			item := Dict{"cmd": "echo r >> " + marker + "; sleep 0.5; " + tail, "name": "slow"}
			for k, v := range extra {
				item[k] = v
			}
			WriteGateYaml(proj, Dict{"rules": gList(Dict{"match": "**/*.py", "run": gList(item)})})
			WriteChangedFiles(proj, "sess1--a1", "x.py")
			WriteChangedFiles(proj, "sess1--a2", "x.py")
			return marker
		}
		both := func(proj string) (ScriptResult, ScriptResult) {
			var r1, r2 ScriptResult
			concurrently(
				func() { r1 = rules(proj, GateOpts{Session: "sess1", AgentID: "a1"}) },
				func() { r2 = rules(proj, GateOpts{Session: "sess1", AgentID: "a2"}) },
			)
			return r1, r2
		}

		t.Run("the command runs once, both get the same success, and both keep a trace and a log", func(t *testing.T) {
			proj := tmpProj(t)
			marker := setup(proj, "true", nil)
			r1, r2 := both(proj)
			assert.Equal(t, 1, sharingCount(marker))
			assert.Equal(t, []int{0, 0}, []int{r1.ExitCode, r2.ExitCode})
			for _, id := range []string{"sess1--a1", "sess1--a2"} {
				assert.Contains(t, traceKindsOf(proj, id), "response")
				assert.NotEmpty(t, sharingLogFiles(proj, id))
			}
		})

		t.Run("both get the same failure", func(t *testing.T) {
			proj := tmpProj(t)
			marker := setup(proj, "echo boom; exit 1", nil)
			r1, r2 := both(proj)
			assert.Equal(t, 1, sharingCount(marker))
			assert.Equal(t, []int{2, 2}, []int{r1.ExitCode, r2.ExitCode})
			assert.Contains(t, r1.Stderr, "boom")
			assert.Contains(t, r2.Stderr, "boom")
			for _, id := range []string{"sess1--a1", "sess1--a2"} {
				assert.Contains(t, traceKindsOf(proj, id), "error")
			}
		})

		t.Run("the waiting side logs the shared output in its own log directory", func(t *testing.T) {
			proj := tmpProj(t)
			setup(proj, "echo shared-output", nil)
			both(proj)
			for _, id := range []string{"sess1--a1", "sess1--a2"} {
				dir := filepath.Join(proj, ".claude", ".gate-status", "logs", id)
				var texts []string
				for _, f := range sharingLogFiles(proj, id) {
					b, err := os.ReadFile(filepath.Join(dir, f))
					require.NoError(t, err)
					texts = append(texts, string(b))
				}
				assert.Contains(t, strings.Join(texts, "\n"), "shared-output")
			}
		})

		t.Run("share: false runs it twice even when concurrent", func(t *testing.T) {
			proj := tmpProj(t)
			marker := setup(proj, "true", Dict{"share": false})
			r1, r2 := both(proj)
			assert.Equal(t, 2, sharingCount(marker))
			assert.Equal(t, []int{0, 0}, []int{r1.ExitCode, r2.ExitCode})
		})

		t.Run("files: false in gate.yaml runs it once even when the agents changed different files", func(t *testing.T) {
			proj := tmpProj(t)
			marker := setup(proj, "true", Dict{"files": false})
			WriteChangedFiles(proj, "sess1--a2", "y.py")
			both(proj)
			assert.Equal(t, 1, sharingCount(marker))
		})

		t.Run("a differing CLAUDE_GATE_FILES runs it twice", func(t *testing.T) {
			proj := tmpProj(t)
			marker := setup(proj, "true", nil)
			WriteChangedFiles(proj, "sess1--a2", "y.py")
			both(proj)
			assert.Equal(t, 2, sharingCount(marker))
		})
	})

	t.Run("the share key", func(t *testing.T) {
		run := func(proj, agentID, cmd, cwd string, env GateEnv) {
			agentGate(proj, agentID, nil).ExecOne("l", cmd, cwd, 10, "", "n", env, ExecScope{Root: proj})
		}
		cmd := func(marker, tag string) string { return "echo r >> " + marker + "; sleep 0.4 # " + tag }
		x := FilesEnv([]string{"x.py"})

		t.Run("the same root, cwd, cmd and files share one run even though the agent ids differ", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			concurrently(
				func() { run(proj, "a1", cmd(marker, ""), proj, x) },
				func() { run(proj, "a2", cmd(marker, ""), proj, x) },
			)
			assert.Equal(t, 1, sharingCount(marker))
		})

		t.Run("a differing cwd runs twice", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			mkdirs(t, proj, "d1")
			mkdirs(t, proj, "d2")
			concurrently(
				func() { run(proj, "a1", cmd(marker, ""), filepath.Join(proj, "d1"), x) },
				func() { run(proj, "a2", cmd(marker, ""), filepath.Join(proj, "d2"), x) },
			)
			assert.Equal(t, 2, sharingCount(marker))
		})

		t.Run("a differing cmd runs twice", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			concurrently(
				func() { run(proj, "a1", cmd(marker, "a"), proj, x) },
				func() { run(proj, "a2", cmd(marker, "b"), proj, x) },
			)
			assert.Equal(t, 2, sharingCount(marker))
		})

		t.Run("a differing CLAUDE_GATE_FILES runs twice", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			concurrently(
				func() { run(proj, "a1", cmd(marker, ""), proj, FilesEnv([]string{"x.py"})) },
				func() { run(proj, "a2", cmd(marker, ""), proj, FilesEnv([]string{"y.py"})) },
			)
			assert.Equal(t, 2, sharingCount(marker))
		})

		t.Run("files: false shares the run even though CLAUDE_GATE_FILES differ", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			no := false
			g := func(id string, files []string) {
				agentGate(proj, id, nil).ExecOne("l", cmd(marker, ""), proj, 10, "", "n", FilesEnv(files), ExecScope{Root: proj, Files: &no})
			}
			concurrently(func() { g("a1", []string{"x.py"}) }, func() { g("a2", []string{"y.py", "z.py"}) })
			assert.Equal(t, 1, sharingCount(marker))
		})

		t.Run("files: false with share: false still runs twice", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			no := false
			g := func(id string, files []string) {
				agentGate(proj, id, nil).ExecOne("l", cmd(marker, ""), proj, 10, "", "n", FilesEnv(files), ExecScope{Root: proj, Share: &no, Files: &no})
			}
			concurrently(func() { g("a1", []string{"x.py"}) }, func() { g("a2", []string{"y.py"}) })
			assert.Equal(t, 2, sharingCount(marker))
		})

		t.Run("files that are a subset of the running ones share the run", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			var wg sync.WaitGroup
			wg.Add(2)
			go func() {
				defer wg.Done()
				run(proj, "a1", cmd(marker, ""), proj, FilesEnv([]string{"x.py", "y.py"}))
			}()
			require.NoError(t, WaitForSharedLock(proj))
			go func() {
				defer wg.Done()
				run(proj, "a2", cmd(marker, ""), proj, FilesEnv([]string{"x.py"}))
			}()
			wg.Wait()
			assert.Equal(t, 1, sharingCount(marker))
		})

		t.Run("files that are not a subset of the running ones run separately", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			var wg sync.WaitGroup
			wg.Add(2)
			go func() {
				defer wg.Done()
				run(proj, "a1", cmd(marker, ""), proj, FilesEnv([]string{"x.py"}))
			}()
			require.NoError(t, WaitForSharedLock(proj))
			go func() {
				defer wg.Done()
				run(proj, "a2", cmd(marker, ""), proj, FilesEnv([]string{"x.py", "y.py"}))
			}()
			wg.Wait()
			assert.Equal(t, 2, sharingCount(marker))
		})

		t.Run("a differing CLAUDE_GATE_FILES runs twice, one after the other", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			c := "echo start >> " + marker + "; sleep 0.4; echo end >> " + marker
			concurrently(
				func() { run(proj, "a1", c, proj, FilesEnv([]string{"x.py"})) },
				func() { run(proj, "a2", c, proj, FilesEnv([]string{"y.py"})) },
			)
			assert.Equal(t, []string{"start", "end", "start", "end"}, Lines(marker))
		})

		t.Run("the same cmd in the rules phase of one agent and the checks phase of another runs one after the other", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			c := "echo start >> " + marker + "; sleep 0.4; echo end >> " + marker
			g := func(id, phase string) {
				NewGate(agentIo(proj, nil), GateOptions{SessionID: "sess1", AgentID: id, Phase: phase}).ExecOne("l", c, proj, 10, "", "n", GateEnv{}, ExecScope{Root: proj})
			}
			concurrently(func() { g("a1", "rules") }, func() { g("a2", "checks") })
			assert.Equal(t, []string{"start", "end", "start", "end"}, Lines(marker))
		})

		t.Run("different cmds with the same name run one after the other, even in different roots", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			c := func(tag string) string {
				return "echo start >> " + marker + "; sleep 0.4; echo end >> " + marker + " # " + tag
			}
			g := func(id, tag, root string) {
				agentGate(proj, id, nil).ExecOne("l", c(tag), proj, 10, "", "go-test", FilesEnv([]string{"x.py"}), ExecScope{Root: root})
			}
			concurrently(func() { g("a1", "a", proj) }, func() { g("a2", "b", filepath.Join(proj, "other")) })
			assert.Equal(t, []string{"start", "end", "start", "end"}, Lines(marker))
		})

		t.Run("the command pid is written into the lock while it runs", func(t *testing.T) {
			proj := tmpProj(t)
			shared := SharedDirOf(proj)
			seen := filepath.Join(proj, "seen.txt")
			// 実行中のコマンド自身から、ロックの pid が自分の PID（$$）と一致するかを書き出す。
			c := "for f in " + shared + `/*.serial/pid; do [ "$(cat "$f")" = "$$" ] && echo same >> ` + seen + "; done; true"
			agentGate(proj, "a1", nil).ExecOne("l", c, proj, 10, "", "n", FilesEnv([]string{"x.py"}), ExecScope{Root: proj})
			assert.Equal(t, "same", strings.TrimSpace(Read(seen)))
		})

		t.Run("share: false is not serialized", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			c := "echo start >> " + marker + "; sleep 0.4; echo end >> " + marker
			no := false
			g := func(id string) {
				agentGate(proj, id, nil).ExecOne("l", c, proj, 10, "", "n", FilesEnv([]string{"x.py"}), ExecScope{Root: proj, Share: &no})
			}
			concurrently(func() { g("a1") }, func() { g("a2") })
			assert.Equal(t, []string{"start", "start"}, Lines(marker)[:2])
		})

		t.Run("a differing root runs twice", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			g := func(id, root string) {
				agentGate(proj, id, nil).ExecOne("l", cmd(marker, ""), proj, 10, "", "n", FilesEnv([]string{"x.py"}), ExecScope{Root: root})
			}
			concurrently(func() { g("a1", proj) }, func() { g("a2", filepath.Join(proj, "other")) })
			assert.Equal(t, 2, sharingCount(marker))
		})
	})

	t.Run("shared band", func(t *testing.T) {
		t.Run("the band stays while another agent is running; the result line appears only when all are done", func(t *testing.T) {
			proj := tmpProj(t)
			logs := &sharedLogs{}
			a := agentGate(proj, "a1", logs)
			b := agentGate(proj, "a2", logs)
			doneA, doneB := make(chan struct{}), make(chan struct{})
			go func() {
				a.ExecOne("l", "sleep 0.3", proj, 10, "", "fast", nil, ExecScope{Root: proj})
				a.FinishProgress()
				close(doneA)
			}()
			go func() {
				b.ExecOne("l", "sleep 1", proj, 10, "", "slow", nil, ExecScope{Root: proj})
				b.FinishProgress()
				close(doneB)
			}()
			<-doneA
			band := logs.bandSnapshot()
			require.NotEmpty(t, band)
			assert.Regexp(t, `^\[gate\] 実行中:\n {2}slow \$ sleep 1 \(\d+s\)$`, band[len(band)-1])
			assert.Empty(t, nonEmpty(logs.resultSnapshot()))
			<-doneB
			band = logs.bandSnapshot()
			idx := indexOfEmpty(band)
			assert.Positive(t, idx)
			for _, l := range band[idx:] {
				assert.Equal(t, "", l)
			}
			result := nonEmpty(logs.resultSnapshot())
			require.Len(t, result, 1)
			assert.Regexp(t, `^\[gate\] 完了: ✓ 1 \(\d+\.\ds\)$`, result[0])
		})

		t.Run("the band lists every agent and marks the one that waits", func(t *testing.T) {
			proj := tmpProj(t)
			logs := &sharedLogs{}
			a := agentGate(proj, "a1", logs)
			b := agentGate(proj, "a2", logs)
			execJob := func(g *Gate) {
				g.ExecOne("l", "sleep 0.6", proj, 10, "", "job", FilesEnv([]string{"x.py"}), ExecScope{Root: proj})
			}
			var wg sync.WaitGroup
			wg.Add(2)
			go func() {
				defer wg.Done()
				execJob(a)
			}()
			require.NoError(t, WaitForSharedLock(proj))
			go func() {
				defer wg.Done()
				execJob(b)
			}()
			wg.Wait()
			found := false
			for _, l := range logs.bandSnapshot() {
				if strings.Contains(l, "\n  job $ sleep 0.6 (") && strings.Contains(l, "\n  job $ sleep 0.6 待機中 (") {
					found = true
				}
			}
			assert.True(t, found)
		})

		t.Run("runGate keeps the band until the last agent finishes", func(t *testing.T) {
			proj := tmpProj(t)
			WriteGateYaml(proj, Dict{
				"rules": gList(
					Dict{"match": "a.py", "run": gList(Dict{"cmd": "sleep 0.2", "name": "fast"})},
					Dict{"match": "b.py", "run": gList(Dict{"cmd": "sleep 1", "name": "slow"})},
				),
			})
			WriteChangedFiles(proj, "sess1--a1", "a.py")
			WriteChangedFiles(proj, "sess1--a2", "b.py")
			logs := &sharedLogs{}
			opts := IoOpts{ProjectDir: proj, BandLog: &logs.band}
			goRun := func(agentID string) {
				RunGate(syncIo{Io: MakeIo(opts), mu: &logs.mu}, GateOptions{SessionID: "sess1", AgentID: agentID, Phase: "rules"})
			}
			concurrently(func() { goRun("a1") }, func() { goRun("a2") })
			band := logs.bandSnapshot()
			idx := indexOfEmpty(band)
			assert.Positive(t, idx)
			for _, l := range band[idx:] {
				assert.Equal(t, "", l)
			}
		})
	})

	t.Run("deferred commands in the checks phase", func(t *testing.T) {
		t.Run("a policy-less reserved check consumes the same command left in the deferred store", func(t *testing.T) {
			proj := tmpProj(t)
			counter := filepath.Join(proj, "count.txt")
			cmd := "echo x >> " + counter
			WriteGateYaml(proj, Dict{
				"policy":             false,
				"rules":              gList(Dict{"match": "**/*.py", "run": gList("true"), "run_checks": gList("chk")}),
				"consistency_checks": gList(Dict{"name": "chk", "run": gList(Dict{"cmd": cmd, "name": "chk-cmd"})}),
			})
			WriteChangedFiles(proj, "sess1", "x.py")
			assert.Equal(t, 0, rules(proj).ExitCode)
			WriteDeferred(proj, "sess1", gList(Dict{"root": proj, "cwd": proj, "name": "chk-cmd", "cmd": cmd, "timeout": 300, "label": "."}))
			assert.Equal(t, 0, checks(proj, GateOpts{StopHookActive: true}).ExitCode)
			assert.Equal(t, 1, sharingCount(counter))
		})
	})

	t.Run("serializing across git worktrees of one repository", func(t *testing.T) {
		git := func(t *testing.T, cwd string, args ...string) {
			t.Helper()
			cmd := exec.CommandContext(context.Background(), "git", append([]string{"-C", cwd}, args...)...)
			cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
			out, err := cmd.CombinedOutput()
			require.NoError(t, err, string(out))
		}
		repoWithWorktrees := func(t *testing.T, base string) []string {
			main := filepath.Join(base, "repo")
			require.NoError(t, os.Mkdir(main, 0o755))
			git(t, main, "init", "-q")
			git(t, main, "commit", "-q", "--allow-empty", "-m", "init")
			inner := filepath.Join(main, ".claude", "worktrees", "w")
			outer := filepath.Join(base, "outside")
			git(t, main, "worktree", "add", "-q", "-b", "w", inner)
			git(t, main, "worktree", "add", "-q", "-b", "o", outer)
			return []string{main, inner, outer}
		}
		runAll := func(dirs []string, marker, counter string) {
			c := "echo start >> " + marker + "; echo x >> " + counter + "; sleep 0.4; echo end >> " + marker
			fns := make([]func(), len(dirs))
			for i, d := range dirs {
				fns[i] = func() {
					agentGate(d, "a"+string(rune('0'+i)), nil).ExecOne("l", c, d, 10, "", "heavy", FilesEnv([]string{"x.py"}), ExecScope{Root: d})
				}
			}
			concurrently(fns...)
		}

		t.Run("the main checkout and two worktrees run the same name one at a time, without sharing results", func(t *testing.T) {
			base := tmpProj(t)
			dirs := repoWithWorktrees(t, base)
			ids := map[string]bool{}
			for _, d := range dirs {
				ids[SharedDirOf(d)] = true
			}
			assert.Len(t, ids, 1)
			marker := filepath.Join(base, "m.txt")
			counter := filepath.Join(base, "c.txt")
			runAll(dirs, marker, counter)
			assert.Equal(t, []string{"start", "end", "start", "end", "start", "end"}, Lines(marker))
			assert.Equal(t, 3, sharingCount(counter))
		})

		t.Run("different repositories get different shared directories", func(t *testing.T) {
			base := tmpProj(t)
			for _, d := range []string{"x", "y"} {
				require.NoError(t, os.Mkdir(filepath.Join(base, d), 0o755))
			}
			a := repoWithWorktrees(t, filepath.Join(base, "x"))
			b := repoWithWorktrees(t, filepath.Join(base, "y"))
			assert.NotEqual(t, SharedDirOf(a[0]), SharedDirOf(b[0]))
		})

		t.Run("outside git, the same name in one project is still serialized", func(t *testing.T) {
			proj := tmpProj(t)
			marker := filepath.Join(proj, "m.txt")
			counter := filepath.Join(proj, "c.txt")
			// 同じ projectDir・同じキーなので結果は共有され得る（1 回か 2 回）。どちらでも重ならないこと
			runAll([]string{proj, proj}, marker, counter)
			lines := Lines(marker)
			for i, l := range lines {
				want := "end"
				if i%2 == 0 {
					want = "start"
				}
				assert.Equal(t, want, l)
			}
			assert.GreaterOrEqual(t, sharingCount(counter), 1)
		})
	})
}

func indexOfEmpty(ss []string) int {
	for i, s := range ss {
		if s == "" {
			return i
		}
	}
	return -1
}

func traceKindsOf(proj, id string) []any {
	out := []any{}
	for _, r := range ReadTraceRecords(proj, id) {
		out = append(out, r["kind"])
	}
	return out
}
