package hookgate

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func sleepMs(ms int) { time.Sleep(time.Duration(ms) * time.Millisecond) }

func outcomeOf(out string, ok ...bool) SharedOutcome {
	return SharedOutcome{Out: out, Ok: len(ok) == 0 || ok[0], TimedOut: false, Logpath: "/log/" + out}
}

func newIo(proj string) Io { return MakeIo(IoOpts{ProjectDir: proj}) }

// both は 2 つ以上の呼び出しを並行に走らせて、結果を呼び出し順に返す。
func parallel[T any](fns ...func() T) []T {
	out := make([]T, len(fns))
	var wg sync.WaitGroup
	for i, fn := range fns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out[i] = fn()
		}()
	}
	wg.Wait()
	return out
}

func TestRunShared(t *testing.T) {
	t.Run("concurrent callers with the same key execute once and share the outcome", func(t *testing.T) {
		WithTmp(func(proj string) {
			var runs atomic.Int32
			execute := func([]string, []string) SharedOutcome {
				n := runs.Add(1)
				sleepMs(400)
				return outcomeOf(fmt.Sprintf("run%d", n), false)
			}
			var waited atomic.Int32
			call := func() SharedResult {
				return RunShared(newIo(proj), "k", nil, 10_000, execute, SharedHooks{OnWait: func() { waited.Add(1) }})
			}
			results := parallel(call, call)
			assert.EqualValues(t, 1, runs.Load())
			assert.Equal(t, outcomeOf("run1", false), results[0].Outcome)
			assert.Equal(t, outcomeOf("run1", false), results[1].Outcome)
			assert.NotEqual(t, results[0].Shared, results[1].Shared)
			assert.EqualValues(t, 1, waited.Load())
		})
	})

	t.Run("different keys execute in parallel", func(t *testing.T) {
		WithTmp(func(proj string) {
			var runs atomic.Int32
			execute := func([]string, []string) SharedOutcome {
				runs.Add(1)
				sleepMs(300)
				return outcomeOf("x")
			}
			call := func(k string) func() SharedResult {
				return func() SharedResult { return RunShared(newIo(proj), k, nil, 10_000, execute, SharedHooks{}) }
			}
			parallel(call("k1"), call("k2"))
			assert.EqualValues(t, 2, runs.Load())
		})
	})

	t.Run("a finished run is not reused", func(t *testing.T) {
		WithTmp(func(proj string) {
			runs := 0
			execute := func([]string, []string) SharedOutcome { runs++; return outcomeOf(fmt.Sprintf("run%d", runs)) }
			first := RunShared(newIo(proj), "k", nil, 10_000, execute, SharedHooks{})
			second := RunShared(newIo(proj), "k", nil, 10_000, execute, SharedHooks{})
			assert.Equal(t, []string{"run1", "run2"}, []string{first.Outcome.Out, second.Outcome.Out})
			assert.False(t, second.Shared)
		})
	})

	t.Run("a marker older than the timeout is taken over", func(t *testing.T) {
		WithTmp(func(proj string) {
			lock := filepath.Join(SharedDirOf(proj), ShareID("k", nil)+".run")
			require.NoError(t, os.MkdirAll(lock, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(lock, "info.json"), []byte(`{"started":1000,"timeoutMs":1000,"key":"k","files":[]}`), 0o644))
			r := RunShared(newIo(proj), "k", nil, 10_000, func([]string, []string) SharedOutcome { return outcomeOf("mine") }, SharedHooks{})
			assert.Equal(t, "mine", r.Outcome.Out)
			assert.False(t, r.Shared)
		})
	})

	t.Run("when the executing side throws, the waiting side runs it itself", func(t *testing.T) {
		WithTmp(func(proj string) {
			var runs atomic.Int32
			execute := func([]string, []string) SharedOutcome {
				if runs.Add(1) == 1 {
					sleepMs(300)
					panic("boom")
				}
				return outcomeOf("second")
			}
			type settled struct {
				res      SharedResult
				panicked bool
			}
			call := func() settled {
				var s settled
				func() {
					defer func() {
						if recover() != nil {
							s.panicked = true
						}
					}()
					s.res = RunShared(newIo(proj), "k", nil, 10_000, execute, SharedHooks{})
				}()
				return s
			}
			results := parallel(call, call)
			panicked, fulfilled := 0, []settled{}
			for _, r := range results {
				if r.panicked {
					panicked++
				} else {
					fulfilled = append(fulfilled, r)
				}
			}
			assert.Equal(t, 1, panicked)
			require.Len(t, fulfilled, 1)
			assert.Equal(t, "second", fulfilled[0].res.Outcome.Out)
		})
	})
}

func TestRunSharedWithFileLists(t *testing.T) {
	// leader の info.json が現れてから waiter が来る。waiter が待ったか（= 結果を受け取ったか）と、実行回数を返す。
	overlap := func(t *testing.T, proj string, leaderFiles, waiterFiles []string) (int32, SharedResult) {
		t.Helper()
		var n atomic.Int32
		execute := func([]string, []string) SharedOutcome {
			v := n.Add(1)
			sleepMs(500)
			return outcomeOf(fmt.Sprintf("run%d", v))
		}
		results := parallel(
			func() SharedResult { return RunShared(newIo(proj), "k", leaderFiles, 10_000, execute, SharedHooks{}) },
			func() SharedResult {
				assert.NoError(t, WaitForSharedLock(proj))
				return RunShared(newIo(proj), "k", waiterFiles, 10_000, execute, SharedHooks{})
			},
		)
		return n.Load(), results[1]
	}

	t.Run("a waiter whose files are a subset of the running ones receives its outcome", func(t *testing.T) {
		WithTmp(func(proj string) {
			runs, w := overlap(t, proj, []string{"a.py", "b.py"}, []string{"a.py"})
			assert.EqualValues(t, 1, runs)
			assert.True(t, w.Shared)
			assert.Equal(t, outcomeOf("run1"), w.Outcome)
		})
	})

	t.Run("the same file list is shared", func(t *testing.T) {
		WithTmp(func(proj string) {
			runs, w := overlap(t, proj, []string{"b.py", "a.py"}, []string{"a.py", "b.py"})
			assert.EqualValues(t, 1, runs)
			assert.True(t, w.Shared)
		})
	})

	t.Run("a waiter whose files are not a subset runs it itself", func(t *testing.T) {
		WithTmp(func(proj string) {
			runs, w := overlap(t, proj, []string{"a.py"}, []string{"a.py", "b.py"})
			assert.EqualValues(t, 2, runs)
			assert.False(t, w.Shared)
		})
	})

	t.Run("disjoint file lists run separately", func(t *testing.T) {
		WithTmp(func(proj string) {
			runs, w := overlap(t, proj, []string{"a.py"}, []string{"b.py"})
			assert.EqualValues(t, 2, runs)
			assert.False(t, w.Shared)
		})
	})

	t.Run("an empty file list is contained in any running list", func(t *testing.T) {
		WithTmp(func(proj string) {
			runs, w := overlap(t, proj, []string{"a.py"}, nil)
			assert.EqualValues(t, 1, runs)
			assert.True(t, w.Shared)
		})
	})

	t.Run("a running empty list does not cover a waiter with files", func(t *testing.T) {
		WithTmp(func(proj string) {
			runs, w := overlap(t, proj, nil, []string{"a.py"})
			assert.EqualValues(t, 2, runs)
			assert.False(t, w.Shared)
		})
	})

	t.Run("runs that cannot be shared do not overlap, and the waiters' file lists are batched into the next run", func(t *testing.T) {
		WithTmp(func(proj string) {
			var active, peak, runs, waited atomic.Int32
			var mu sync.Mutex
			var ranWith [][]string
			execute := func(_ []string, files []string) SharedOutcome {
				n := runs.Add(1)
				cur := active.Add(1)
				for {
					p := peak.Load()
					if cur <= p || peak.CompareAndSwap(p, cur) {
						break
					}
				}
				mu.Lock()
				ranWith = append(ranWith, files)
				mu.Unlock()
				sleepMs(300)
				active.Add(-1)
				return outcomeOf(fmt.Sprintf("run%d", n))
			}
			call := func(files ...string) func() SharedResult {
				return func() SharedResult {
					return RunShared(newIo(proj), "k", files, 10_000, execute, SharedHooks{OnWait: func() { waited.Add(1) }})
				}
			}
			first := call("a.py")
			results := parallel(first, func() SharedResult {
				sleepMs(100) // a.py が実行側になってから b.py と c.py が来る
				return parallel(call("b.py"), call("c.py"))[0]
			})
			// a.py の実行中に来た b.py と c.py は受け取れないので待ち、終わったあと 1 回にまとめて走る（一方が実行側、他方が受け取る）。
			assert.EqualValues(t, 2, runs.Load())
			assert.EqualValues(t, 1, peak.Load())
			assert.EqualValues(t, 2, waited.Load())
			assert.Equal(t, [][]string{{"a.py"}, {"b.py", "c.py"}}, ranWith)
			assert.False(t, results[0].Shared)
			// 置かれた一覧は消えている
			assert.Empty(t, listNames(SharedDirOf(proj), ".queue"))
		})
	})

	t.Run("a stale request left by a dead waiter is dropped, not batched", func(t *testing.T) {
		WithTmp(func(proj string) {
			queue := filepath.Join(SharedDirOf(proj), HashKey("k")+".queue")
			require.NoError(t, os.MkdirAll(queue, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(queue, "old.json"), []byte(`{"started":1000,"key":"k","files":["z.py"]}`), 0o644))
			require.NoError(t, os.WriteFile(filepath.Join(queue, "other.json"), []byte(JSONStringify(OMap{{"started", time.Now().UnixMilli()}, {"key", "other"}, {"files", []string{"o.py"}}})), 0o644))
			var ranWith []string
			RunShared(newIo(proj), "k", []string{"a.py"}, 10_000, func(_ []string, files []string) SharedOutcome {
				ranWith = files
				return outcomeOf("x")
			}, SharedHooks{})
			assert.Equal(t, []string{"a.py"}, ranWith)
			assert.False(t, exists(filepath.Join(queue, "old.json")))
			assert.True(t, exists(filepath.Join(queue, "other.json")), "another key's request is left for its own leader")
		})
	})

	t.Run("different keys with the same serial do not overlap", func(t *testing.T) {
		WithTmp(func(proj string) {
			var active, peak atomic.Int32
			execute := func([]string, []string) SharedOutcome {
				cur := active.Add(1)
				for {
					p := peak.Load()
					if cur <= p || peak.CompareAndSwap(p, cur) {
						break
					}
				}
				sleepMs(300)
				active.Add(-1)
				return outcomeOf("x")
			}
			call := func(k string) func() SharedResult {
				return func() SharedResult { return RunShared(newIo(proj), k, nil, 10_000, execute, SharedHooks{Serial: "s"}) }
			}
			parallel(call("k1"), call("k2"))
			assert.EqualValues(t, 1, peak.Load())
		})
	})

	t.Run("a stale serial lock is taken over", func(t *testing.T) {
		WithTmp(func(proj string) {
			lock := filepath.Join(SharedDirOf(proj), HashKey("k")+".serial")
			require.NoError(t, os.MkdirAll(lock, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(lock, "info.json"), []byte(`{"started":1000,"timeoutMs":1000}`), 0o644))
			r := RunShared(newIo(proj), "k", []string{"a.py"}, 10_000, func([]string, []string) SharedOutcome { return outcomeOf("mine") }, SharedHooks{})
			assert.Equal(t, "mine", r.Outcome.Out)
			assert.False(t, Exists(lock))
		})
	})
}

// ESC などで hook が止められ、ロックが残ったままになった状態を作る。
func leftLock(t *testing.T, proj, serial string, info string, pid int) string {
	t.Helper()
	lock := filepath.Join(SharedDirOf(proj), HashKey(serial)+".serial")
	require.NoError(t, os.MkdirAll(lock, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(lock, "info.json"), []byte(info), 0o644))
	if pid > 0 {
		require.NoError(t, os.WriteFile(filepath.Join(lock, "pid"), []byte(strconv.Itoa(pid)+"\n"), 0o644))
	}
	return lock
}

func deadPid(t *testing.T) int {
	t.Helper()
	out, err := exec.CommandContext(context.Background(), "sh", "-c", "echo $$").Output()
	require.NoError(t, err)
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	require.NoError(t, err)
	return n
}

func TestRunSharedLeftoverLocks(t *testing.T) {
	infoNow := func(timeoutMs int64, agoMs int64) string {
		return fmt.Sprintf(`{"started":%d,"timeoutMs":%d}`, time.Now().UnixMilli()-agoMs, timeoutMs)
	}

	t.Run("a serial lock whose command process is gone is taken over at once, well before its timeout", func(t *testing.T) {
		WithTmp(func(proj string) {
			lock := leftLock(t, proj, "k", infoNow(600_000, 0), deadPid(t))
			t0 := time.Now()
			r := RunShared(newIo(proj), "k", []string{"a.py"}, 10_000, func([]string, []string) SharedOutcome { return outcomeOf("mine") }, SharedHooks{})
			assert.Equal(t, "mine", r.Outcome.Out)
			assert.Less(t, time.Since(t0), 3*time.Second)
			assert.False(t, Exists(lock))
		})
	})

	t.Run("a serial lock without a pid long after its start is taken over", func(t *testing.T) {
		WithTmp(func(proj string) {
			leftLock(t, proj, "k", infoNow(600_000, 60_000), 0)
			t0 := time.Now()
			r := RunShared(newIo(proj), "k", []string{"a.py"}, 10_000, func([]string, []string) SharedOutcome { return outcomeOf("mine") }, SharedHooks{})
			assert.Equal(t, "mine", r.Outcome.Out)
			assert.Less(t, time.Since(t0), 3*time.Second)
		})
	})

	t.Run("a serial lock whose command is still running is waited for until the command ends", func(t *testing.T) {
		WithTmp(func(proj string) {
			child := exec.CommandContext(context.Background(), "sleep", "1")
			require.NoError(t, child.Start())
			var endedAt atomic.Int64
			go func() {
				_ = child.Wait()
				endedAt.Store(time.Now().UnixNano())
			}()
			lock := leftLock(t, proj, "k", infoNow(600_000, 0), child.Process.Pid)
			var startedAt int64
			r := RunShared(newIo(proj), "k", []string{"a.py"}, 10_000, func([]string, []string) SharedOutcome {
				startedAt = time.Now().UnixNano()
				return outcomeOf("mine")
			}, SharedHooks{})
			assert.Equal(t, "mine", r.Outcome.Out)
			assert.Greater(t, endedAt.Load(), int64(0))
			assert.GreaterOrEqual(t, startedAt, endedAt.Load())
			assert.False(t, Exists(lock))
		})
	})

	t.Run("when no lock can be created, it gives up coordinating and runs the command itself", func(t *testing.T) {
		WithTmp(func(proj string) {
			// shared/ がファイルなので mkdir できない。待ち続けず、ラウンドが尽きたら自分で実行する。
			shared := SharedDirOf(proj)
			require.NoError(t, os.MkdirAll(filepath.Dir(shared), 0o755))
			require.NoError(t, os.WriteFile(shared, nil, 0o644))
			done := make(chan SharedResult, 1)
			go func() {
				done <- RunShared(newIo(proj), "k", []string{"a.py"}, 10_000, func([]string, []string) SharedOutcome { return outcomeOf("mine") }, SharedHooks{})
			}()
			select {
			case r := <-done:
				assert.Equal(t, "mine", r.Outcome.Out)
				assert.False(t, r.Shared)
			case <-time.After(4 * time.Second):
				t.Fatal("did not give up coordinating")
			}
		})
	})

	t.Run("a leader whose command just ended but has not yet written its result is not taken over", func(t *testing.T) {
		WithTmp(func(proj string) {
			// 実行側のコマンドは終わった（PID は死んでいる）が、結果を書いてロックを外すのはこれから、という瞬間を作る。
			dead := deadPid(t)
			shared := SharedDirOf(proj)
			id := ShareID("k", []string{"a.py"})
			run := filepath.Join(shared, id+".run")
			require.NoError(t, os.MkdirAll(run, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(run, "info.json"),
				[]byte(fmt.Sprintf(`{"started":%d,"timeoutMs":600000,"key":"k","files":["a.py"]}`, time.Now().UnixMilli())), 0o644))
			require.NoError(t, os.WriteFile(filepath.Join(run, "pid"), []byte(strconv.Itoa(dead)+"\n"), 0o644))
			serial := leftLock(t, proj, "k", infoNow(600_000, 0), dead)
			finished := make(chan struct{})
			go func() {
				defer close(finished)
				sleepMs(400)
				leader := outcomeOf("leader")
				require.NoError(t, os.WriteFile(filepath.Join(shared, id+".result.json"),
					[]byte(fmt.Sprintf(`{"key":"k","files":["a.py"],"out":%q,"ok":true,"timedOut":false,"logpath":%q}`, leader.Out, leader.Logpath)), 0o644))
				require.NoError(t, os.RemoveAll(run))
				require.NoError(t, os.RemoveAll(serial))
			}()
			runs := 0
			r := RunShared(newIo(proj), "k", []string{"a.py"}, 10_000, func([]string, []string) SharedOutcome { runs++; return outcomeOf("mine") }, SharedHooks{})
			<-finished
			assert.Equal(t, 0, runs)
			assert.True(t, r.Shared)
			assert.Equal(t, "leader", r.Outcome.Out)
		})
	})

	t.Run("the leader passes pid files inside both locks to execute, and both locks are gone afterwards", func(t *testing.T) {
		WithTmp(func(proj string) {
			var got []string
			RunShared(newIo(proj), "k", []string{"a.py"}, 10_000, func(pidFiles []string, _ []string) SharedOutcome {
				got = pidFiles
				return outcomeOf("x")
			}, SharedHooks{})
			require.Len(t, got, 2)
			var kinds []string
			for _, f := range got {
				assert.Equal(t, "pid", filepath.Base(f))
				parts := strings.Split(filepath.Base(filepath.Dir(f)), ".")
				kinds = append(kinds, parts[len(parts)-1])
			}
			assert.Equal(t, []string{"serial", "run"}, kinds)
			entries, err := os.ReadDir(SharedDirOf(proj))
			require.NoError(t, err)
			for _, e := range entries {
				assert.True(t, strings.HasSuffix(e.Name(), ".result.json"), e.Name())
			}
		})
	})

	t.Run("a run with a different key is not joined even when the files match", func(t *testing.T) {
		WithTmp(func(proj string) {
			var runs atomic.Int32
			execute := func([]string, []string) SharedOutcome { runs.Add(1); sleepMs(300); return outcomeOf("x") }
			call := func(k string) func() SharedResult {
				return func() SharedResult {
					return RunShared(newIo(proj), k, []string{"a.py"}, 10_000, execute, SharedHooks{})
				}
			}
			parallel(call("k1"), call("k2"))
			assert.EqualValues(t, 2, runs.Load())
		})
	})

	t.Run("a stale superset lock is taken over instead of waited for", func(t *testing.T) {
		WithTmp(func(proj string) {
			lock := filepath.Join(SharedDirOf(proj), ShareID("k", []string{"a.py", "b.py"})+".run")
			require.NoError(t, os.MkdirAll(lock, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(lock, "info.json"), []byte(`{"started":1000,"timeoutMs":1000,"key":"k","files":["a.py","b.py"]}`), 0o644))
			r := RunShared(newIo(proj), "k", []string{"a.py"}, 10_000, func([]string, []string) SharedOutcome { return outcomeOf("mine") }, SharedHooks{})
			assert.Equal(t, "mine", r.Outcome.Out)
			assert.False(t, r.Shared)
		})
	})

	t.Run("a lock that has no info.json yet is waited on, then joined once the info appears", func(t *testing.T) {
		WithTmp(func(proj string) {
			lock := filepath.Join(SharedDirOf(proj), ShareID("k", []string{"a.py", "b.py"})+".run")
			require.NoError(t, os.MkdirAll(lock, 0o755))
			var runs atomic.Int32
			waiter := make(chan SharedResult, 1)
			go func() {
				waiter <- RunShared(newIo(proj), "k", []string{"a.py"}, 10_000, func([]string, []string) SharedOutcome {
					return outcomeOf(fmt.Sprintf("run%d", runs.Add(1)))
				}, SharedHooks{})
			}()
			sleepMs(200)
			require.NoError(t, os.WriteFile(filepath.Join(lock, "info.json"),
				[]byte(fmt.Sprintf(`{"started":%d,"timeoutMs":10000,"key":"k","files":["a.py","b.py"]}`, time.Now().UnixMilli())), 0o644))
			sleepMs(200)
			theirs := outcomeOf("theirs")
			require.NoError(t, os.WriteFile(strings.TrimSuffix(lock, ".run")+".result.json",
				[]byte(fmt.Sprintf(`{"key":"k","files":["a.py","b.py"],"out":%q,"ok":true,"timedOut":false,"logpath":%q}`, theirs.Out, theirs.Logpath)), 0o644))
			require.NoError(t, os.RemoveAll(lock))
			r := <-waiter
			assert.EqualValues(t, 0, runs.Load())
			assert.True(t, r.Shared)
			assert.Equal(t, theirs, r.Outcome)
		})
	})

	t.Run("a lock that never gets an info.json is taken over after the grace period", func(t *testing.T) {
		WithTmp(func(proj string) {
			lock := filepath.Join(SharedDirOf(proj), ShareID("k", []string{"a.py", "b.py"})+".run")
			require.NoError(t, os.MkdirAll(lock, 0o755))
			old := time.Now().Add(-60 * time.Second)
			require.NoError(t, os.Chtimes(lock, old, old))
			r := RunShared(newIo(proj), "k", []string{"a.py"}, 10_000, func([]string, []string) SharedOutcome { return outcomeOf("mine") }, SharedHooks{})
			assert.Equal(t, "mine", r.Outcome.Out)
			assert.False(t, r.Shared)
		})
	})
}

func TestHashKey(t *testing.T) {
	t.Run("is a stable 14-digit hex string (cyrb53, the same value as the TS version)", func(t *testing.T) {
		assert.Len(t, HashKey("k"), 14)
		assert.Equal(t, HashKey("k"), HashKey("k"))
		assert.NotEqual(t, HashKey("k1"), HashKey("k2"))
	})
}

// listNames は dir 直下の suffix で終わる名前の一覧。
func listNames(dir, suffix string) []string {
	var out []string
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), suffix) {
			if inner, _ := os.ReadDir(filepath.Join(dir, e.Name())); len(inner) > 0 {
				out = append(out, e.Name())
			}
		}
	}
	return out
}

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

func TestMaxParallel(t *testing.T) {
	// 同時に走っている数のピークを数える execute。
	counter := func(active, peak *atomic.Int32, ms int) SharedExecute {
		return func([]string, []string) SharedOutcome {
			cur := active.Add(1)
			for {
				p := peak.Load()
				if cur <= p || peak.CompareAndSwap(p, cur) {
					break
				}
			}
			sleepMs(ms)
			active.Add(-1)
			return outcomeOf("x")
		}
	}

	t.Run("different commands run at most max_parallel at a time, and all of them run", func(t *testing.T) {
		WithTmp(func(proj string) {
			var active, peak, runs atomic.Int32
			execute := counter(&active, &peak, 250)
			call := func(k string) func() SharedResult {
				return func() SharedResult {
					r := RunShared(newIo(proj), k, nil, 10_000, func(p []string, f []string) SharedOutcome { runs.Add(1); return execute(p, f) }, SharedHooks{MaxParallel: 2})
					return r
				}
			}
			parallel(call("k1"), call("k2"), call("k3"), call("k4"))
			assert.EqualValues(t, 4, runs.Load())
			assert.EqualValues(t, 2, peak.Load())
			assert.Empty(t, listNames(SharedDirOf(proj), ""), "slots and locks are released")
		})
	})

	t.Run("max_parallel 0 means no limit", func(t *testing.T) {
		WithTmp(func(proj string) {
			var active, peak atomic.Int32
			execute := counter(&active, &peak, 250)
			call := func(k string) func() SharedResult {
				return func() SharedResult {
					return RunShared(newIo(proj), k, nil, 10_000, execute, SharedHooks{MaxParallel: 0})
				}
			}
			parallel(call("k1"), call("k2"), call("k3"))
			assert.EqualValues(t, 3, peak.Load())
		})
	})

	t.Run("a slot left by a dead process is taken over", func(t *testing.T) {
		WithTmp(func(proj string) {
			slot := filepath.Join(SharedDirOf(proj), "slot.0")
			require.NoError(t, os.MkdirAll(slot, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(slot, "info.json"), []byte(`{"started":1000,"timeoutMs":1000}`), 0o644))
			r := RunShared(newIo(proj), "k", nil, 10_000, func([]string, []string) SharedOutcome { return outcomeOf("mine") }, SharedHooks{MaxParallel: 1})
			assert.Equal(t, "mine", r.Outcome.Out)
			assert.False(t, exists(slot))
		})
	})

	t.Run("RunWithSlot (share: false) takes a slot too and writes the command's pid into it", func(t *testing.T) {
		WithTmp(func(proj string) {
			var active, peak atomic.Int32
			execute := counter(&active, &peak, 250)
			var pidFiles []string
			call := func() func() SharedOutcome {
				return func() SharedOutcome {
					return RunWithSlot(newIo(proj), 1, 10_000, func(p []string) SharedOutcome { pidFiles = p; return execute(p, nil) })
				}
			}
			parallel(call(), call())
			assert.EqualValues(t, 1, peak.Load())
			assert.Equal(t, []string{filepath.Join(SharedDirOf(proj), "slot.0", "pid")}, pidFiles)
			assert.False(t, exists(filepath.Join(SharedDirOf(proj), "slot.0")))
		})
	})
}

// Ubuntu 26.04 の coreutils（uutils）の mkdir は、存在を確かめてから作るので、同時に呼ばれると複数が 0 で終わる
// （uutils/coreutils#13970）。その mkdir を PATH の先頭に置いて模倣し、ロックの持ち主が 1 人に決まることを確かめる。
func TestRunSharedWithNonAtomicMkdir(t *testing.T) {
	realMkdir, err := exec.LookPath("mkdir")
	require.NoError(t, err)
	bin := TmpDir()
	defer RmTree(bin)
	script := "#!/bin/sh\n" +
		"# non-atomic mkdir: check first, then create (with -p, so a concurrent creator also exits 0)\n" +
		"case \" $* \" in *\" -p \"*) exec \"" + realMkdir + "\" \"$@\";; esac\n" +
		"for d in \"$@\"; do if [ -e \"$d\" ]; then echo \"mkdir: cannot create directory '$d': File exists\" >&2; exit 1; fi; done\n" +
		"sleep 0.05\n" +
		"exec \"" + realMkdir + "\" -p \"$@\"\n"
	require.NoError(t, os.WriteFile(filepath.Join(bin, "mkdir"), []byte(script), 0o755))
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	t.Run("the fake mkdir lets two concurrent callers both succeed", func(t *testing.T) {
		WithTmp(func(dir string) {
			target := filepath.Join(dir, "x")
			rs := parallel(
				func() int { return runProcess([]string{"sh", "-c", `mkdir "$1"`, "sh", target}, RunOptions{}).ExitCode },
				func() int { return runProcess([]string{"sh", "-c", `mkdir "$1"`, "sh", target}, RunOptions{}).ExitCode },
			)
			assert.Equal(t, []int{0, 0}, rs)
		})
	})

	t.Run("concurrent callers with the same key still execute once", func(t *testing.T) {
		WithTmp(func(proj string) {
			var runs atomic.Int32
			execute := func([]string, []string) SharedOutcome {
				runs.Add(1)
				sleepMs(300)
				return outcomeOf("x")
			}
			call := func() SharedResult { return RunShared(newIo(proj), "k", nil, 10_000, execute, SharedHooks{}) }
			parallel(call, call, call)
			assert.EqualValues(t, 1, runs.Load())
			assert.Empty(t, listNames(SharedDirOf(proj), ""), "locks are released")
		})
	})

	t.Run("max_parallel still caps the commands running at once", func(t *testing.T) {
		WithTmp(func(proj string) {
			var active, peak atomic.Int32
			execute := counterExecute(&active, &peak, 250)
			call := func(k string) func() SharedResult {
				return func() SharedResult {
					return RunShared(newIo(proj), k, nil, 10_000, execute, SharedHooks{MaxParallel: 1})
				}
			}
			parallel(call("k1"), call("k2"), call("k3"))
			assert.EqualValues(t, 1, peak.Load())
			assert.Empty(t, listNames(SharedDirOf(proj), ""), "slots and locks are released")
		})
	})
}

// counterExecute は同時に走っている数のピークを数える execute（TestMaxParallel の counter と同じ）。
func counterExecute(active, peak *atomic.Int32, ms int) SharedExecute {
	return func([]string, []string) SharedOutcome {
		cur := active.Add(1)
		for {
			p := peak.Load()
			if cur <= p || peak.CompareAndSwap(p, cur) {
				break
			}
		}
		sleepMs(ms)
		active.Add(-1)
		return outcomeOf("x")
	}
}
