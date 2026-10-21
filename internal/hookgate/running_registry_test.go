package hookgate

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const t0 int64 = 1_000_000

func names(entries []RunningEntry) []string {
	out := []string{}
	for _, e := range entries {
		out = append(out, e.Name)
	}
	return out
}

func TestRunningRegistry(t *testing.T) {
	t.Run("entries of every owner are merged in start order", func(t *testing.T) {
		WithTmp(func(proj string) {
			io := MakeIo(IoOpts{ProjectDir: proj, Now: func() int64 { return t0 + 10_000 }})
			require.NoError(t, PublishRunning(io, "s.b", []RunningEntry{{Name: "late", Cmd: "x", Started: t0 + 5000}}))
			require.NoError(t, PublishRunning(io, "s.a", []RunningEntry{
				{Name: "first", Cmd: "x", Started: t0},
				{Name: "second", Cmd: "x", Started: t0 + 1000, Result: "ok"},
			}))
			assert.Equal(t, []string{"first", "second", "late"}, names(ListRunning(io, "s")))
		})
	})

	t.Run("withdrawing one owner keeps the others", func(t *testing.T) {
		WithTmp(func(proj string) {
			io := MakeIo(IoOpts{ProjectDir: proj, Now: func() int64 { return t0 }})
			require.NoError(t, PublishRunning(io, "s.a", []RunningEntry{{Name: "a", Cmd: "x", Started: t0}}))
			require.NoError(t, PublishRunning(io, "s.b", []RunningEntry{{Name: "b", Cmd: "x", Started: t0}}))
			WithdrawRunning(io, "s.a")
			assert.Equal(t, []string{"b"}, names(ListRunning(io, "s")))
		})
	})

	t.Run("entries left behind by a dead process are ignored once they are old enough", func(t *testing.T) {
		WithTmp(func(proj string) {
			old := MakeIo(IoOpts{ProjectDir: proj, Now: func() int64 { return t0 }})
			require.NoError(t, PublishRunning(old, "s.dead", []RunningEntry{{Name: "dead", Cmd: "x", Started: t0}}))
			later := MakeIo(IoOpts{ProjectDir: proj, Now: func() int64 { return t0 + 3_600_000 }})
			assert.Empty(t, ListRunning(later, "s"))
		})
	})

	t.Run("only the own session (main and its subagents) is listed, not another session or a mere id prefix match", func(t *testing.T) {
		WithTmp(func(proj string) {
			io := MakeIo(IoOpts{ProjectDir: proj, Now: func() int64 { return t0 }})
			for _, p := range []struct {
				owner, name string
				started     int64
			}{
				{"sess.x1", "main", t0}, {"sess--agent.x2", "sub", t0 + 1}, {"other.x3", "other", t0},
				{"sess2.x4", "prefix", t0}, {"sess2--agent.x5", "prefix-sub", t0 + 1},
			} {
				require.NoError(t, PublishRunning(io, p.owner, []RunningEntry{{Name: p.name, Cmd: "x", Started: p.started}}))
			}
			assert.Equal(t, []string{"main", "sub"}, names(ListRunning(io, "sess")))
			assert.Equal(t, []string{"prefix", "prefix-sub"}, names(ListRunning(io, "sess2")))
		})
	})

	t.Run("the finished summary is kept per session", func(t *testing.T) {
		WithTmp(func(proj string) {
			io := MakeIo(IoOpts{ProjectDir: proj})
			require.NoError(t, SaveSummary(io, "sess-a", "A"))
			require.NoError(t, SaveSummary(io, "sess-b", "B"))
			got, ok := LoadSummary(io, "sess-a")
			assert.True(t, ok)
			assert.Equal(t, "A", got)
			ClearSummary(io, "sess-a")
			_, ok = LoadSummary(io, "sess-a")
			assert.False(t, ok)
			got, _ = LoadSummary(io, "sess-b")
			assert.Equal(t, "B", got)
		})
	})

	t.Run("mergeRunning skips broken files", func(t *testing.T) {
		one, err := json.Marshal([]RunningEntry{{Name: "a", Cmd: "x", Started: t0}})
		require.NoError(t, err)
		entries := MergeRunning([]string{"not json", "{}", string(one)}, t0)
		assert.Equal(t, []string{"a"}, names(entries))
	})

	t.Run("the published file omits unset fields", func(t *testing.T) {
		WithTmp(func(proj string) {
			io := MakeIo(IoOpts{ProjectDir: proj})
			require.NoError(t, PublishRunning(io, "s.a", []RunningEntry{{Cmd: "x", Started: t0}, {Name: "n", Cmd: "y", Started: t0, Result: "ok", Ended: Int64Ptr(t0 + 5)}}))
			assert.Equal(t, `[{"cmd":"x","started":1000000},{"name":"n","cmd":"y","started":1000000,"result":"ok","ended":1000005}]`,
				Read(proj+"/.claude/.gate-status/running/s.a.json"))
		})
	})
}

func TestRunningLines(t *testing.T) {
	t.Run("a heading, then running, finished and waiting entries one per line, indented by two spaces", func(t *testing.T) {
		lines := RunningLines([]RunningEntry{
			{Name: "a", Cmd: "sleep 1", Started: t0},
			{Name: "b", Cmd: "x", Started: t0, Result: "ok", Ended: Int64Ptr(t0 + 500)},
			{Name: "c", Cmd: "x", Started: t0, Result: "fail", Ended: Int64Ptr(t0 + 1200)},
			{Name: "d", Cmd: "z", Started: t0 + 1000, Waiting: true},
			{Cmd: "exit 1", Started: t0},
		}, t0+3000, LangJA)
		assert.Equal(t, []string{"[gate] 実行中:", "  a $ sleep 1 (3s)", "  b ✓ (0.5s)", "  c ✗ (1.2s)", "  d $ z 待機中 (2s)", "  exit 1 (3s)"}, lines)
	})

	t.Run("a finished entry keeps its duration on later renders", func(t *testing.T) {
		e := RunningEntry{Name: "b", Cmd: "x", Started: t0, Result: "ok", Ended: Int64Ptr(t0 + 600)}
		assert.Equal(t, RunningLines([]RunningEntry{e}, t0+600, LangJA), RunningLines([]RunningEntry{e}, t0+60_000, LangJA))
	})

	t.Run("a long cmd is cut at a word boundary with \" ...\" so the line stays within the limit", func(t *testing.T) {
		cmd := "find scripts/renovate -name '*_test.sh' -print0 | xargs -0 -P0 -n1 bash -c 'echo hello world'"
		lines := RunningLines([]RunningEntry{{Name: "renovate-scripts-test", Cmd: cmd, Started: t0}}, t0+12_000, LangJA)
		assert.Equal(t, "  renovate-scripts-test $ find scripts/renovate -name '*_test.sh' ... (12s)", lines[1])
		assert.LessOrEqual(t, len(lines[1]), 80)
	})

	t.Run("a multi-line cmd is folded into one line", func(t *testing.T) {
		lines := RunningLines([]RunningEntry{{Name: "m", Cmd: "echo a\n  echo b", Started: t0}}, t0, LangJA)
		assert.Equal(t, "  m $ echo a ... (0s)", lines[1])
	})

	t.Run("an entry without a name is shown by its folded cmd", func(t *testing.T) {
		lines := RunningLines([]RunningEntry{{Cmd: "echo a\necho b", Started: t0, Result: "fail", Ended: Int64Ptr(t0 + 100)}}, t0, LangJA)
		assert.Equal(t, "  echo a ... ✗ (0.1s)", lines[1])
	})

	t.Run("a long non-ASCII cmd is cut by UTF-16 length like the TS version", func(t *testing.T) {
		lines := RunningLines([]RunningEntry{{Name: "n", Cmd: strings.Repeat("あ", 100), Started: t0}}, t0, LangJA)
		assert.Equal(t, "  n $ "+strings.Repeat("あ", 80-len("  n $ ")-len(" (0s)")-len(" ..."))+" ... (0s)", lines[1])
	})
}

func TestRunningLanguage(t *testing.T) {
	t.Run("heading, waiting marker and summary are English when lang is en", func(t *testing.T) {
		entries := []RunningEntry{
			{Name: "a", Cmd: "sleep 1", Started: t0},
			{Name: "d", Cmd: "z", Started: t0 + 1000, Waiting: true},
		}
		assert.Equal(t, []string{"[gate] running:", "  a $ sleep 1 (3s)", "  d $ z waiting (2s)"}, RunningLines(entries, t0+3000, LangEN))
		done := []RunningEntry{
			{Name: "a", Cmd: "x", Started: t0, Result: "ok", Ended: Int64Ptr(t0 + 500)},
			{Name: "b", Cmd: "x", Started: t0, Result: "fail", Ended: Int64Ptr(t0 + 1200)},
		}
		got, ok := FinishedSummary(done, LangEN)
		assert.True(t, ok)
		assert.Equal(t, "[gate] done: ✓ 1 / ✗ 1 (1.2s)", got)
	})
}

func TestRunningBand(t *testing.T) {
	done := RunningEntry{Name: "a", Cmd: "x", Started: t0, Result: "ok", Ended: Int64Ptr(t0 + 700)}
	running := RunningEntry{Name: "b", Cmd: "sleep 9", Started: t0}

	t.Run("is a column of one Text per line while something is unfinished", func(t *testing.T) {
		band, ok := RunningBand([]RunningEntry{done, running}, t0+8000, LangJA)
		assert.True(t, ok)
		var children []any
		for _, line := range []string{"[gate] 実行中:", "  a ✓ (0.7s)", "  b $ sleep 9 (8s)"} {
			children = append(children, RenderElement{Type: "Text", Children: []any{line}})
		}
		assert.Equal(t, RenderElement{Type: "Box", Props: map[string]any{"flexDirection": "column"}, Children: children}, band)
	})

	t.Run("is absent when nothing is listed or everything has finished", func(t *testing.T) {
		_, ok := RunningBand(nil, t0, LangJA)
		assert.False(t, ok)
		_, ok = RunningBand([]RunningEntry{done}, t0, LangJA)
		assert.False(t, ok)
	})
}

func TestFinishedSummary(t *testing.T) {
	ok := func(name string, ended int64) RunningEntry {
		return RunningEntry{Name: name, Cmd: "x", Started: t0, Result: "ok", Ended: Int64Ptr(t0 + ended)}
	}
	fail := func(name string, ended int64) RunningEntry {
		return RunningEntry{Name: name, Cmd: "x", Started: t0, Result: "fail", Ended: Int64Ptr(t0 + ended)}
	}

	t.Run("shows only the counts of passed and failed checks plus the elapsed seconds", func(t *testing.T) {
		got, _ := FinishedSummary([]RunningEntry{ok("a", 700), ok("b", 200), ok("c", 300), ok("d", 400), ok("e", 500), fail("f", 81_000)}, LangJA)
		assert.Equal(t, "[gate] 完了: ✓ 5 / ✗ 1 (81.0s)", got)
	})

	t.Run("omits the failure count when nothing failed", func(t *testing.T) {
		got, _ := FinishedSummary([]RunningEntry{ok("a", 700), ok("b", 81_000)}, LangJA)
		assert.Equal(t, "[gate] 完了: ✓ 2 (81.0s)", got)
	})

	t.Run("omits the success count when nothing passed", func(t *testing.T) {
		got, _ := FinishedSummary([]RunningEntry{fail("a", 12_300), fail("b", 100)}, LangJA)
		assert.Equal(t, "[gate] 完了: ✗ 2 (12.3s)", got)
	})

	t.Run("the seconds span the first start to the last end, not the sum of the checks", func(t *testing.T) {
		entries := []RunningEntry{
			{Name: "a", Cmd: "x", Started: t0, Result: "ok", Ended: Int64Ptr(t0 + 10_000)},
			{Name: "b", Cmd: "x", Started: t0 + 2000, Result: "ok", Ended: Int64Ptr(t0 + 12_000)},
			{Name: "c", Cmd: "x", Started: t0 + 5000, Result: "ok", Ended: Int64Ptr(t0 + 8000)},
		}
		got, _ := FinishedSummary(entries, LangJA)
		assert.Equal(t, "[gate] 完了: ✓ 3 (12.0s)", got)
	})

	t.Run("is absent while something is unfinished or when nothing ran", func(t *testing.T) {
		_, has := FinishedSummary(nil, LangJA)
		assert.False(t, has)
		_, has = FinishedSummary([]RunningEntry{{Name: "a", Cmd: "x", Started: t0}}, LangJA)
		assert.False(t, has)
	})
}

func TestToFixed(t *testing.T) {
	t.Run("matches JS toFixed", func(t *testing.T) {
		assert.Equal(t, "0.3", ToFixed(0.25, 1)) // 等距離は大きい方
		assert.Equal(t, "0.1", ToFixed(0.15, 1)) // 0.15 は 2 進で僅かに小さい
		assert.Equal(t, "12.0", ToFixed(12, 1))
		assert.Equal(t, "81.0", ToFixed(81, 1))
		assert.Equal(t, "10.0", ToFixed(9.96, 1))
		assert.Equal(t, "0.0", ToFixed(0.04, 1))
	})
}
