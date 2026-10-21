package hookgate

// tests/bash-changes.spec.ts の移植。実際に git リポジトリを作り（git init / commit）、mtime を os.Chtimes で動かす。

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const bctT0 int64 = 1_700_000_000_000

func bctGit(t *testing.T, cwd string, args ...string) {
	t.Helper()
	cmd := exec.CommandContext(context.Background(), "git", args...)
	cmd.Dir = cwd
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
}

// bctGitAt はコミット日時を ms で指定して git を呼ぶ（コミット履歴から拾う判定を、T0 基準の時計に合わせる）。
func bctGitAt(t *testing.T, ms int64, cwd string, args ...string) {
	t.Helper()
	date := "@" + strconv.FormatInt(ms/1000, 10) + " +0000"
	cmd := exec.CommandContext(context.Background(), "git", args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
}

// bctInitRepo は git init して、tracked.txt / old.txt（と gate.yaml）をコミットした PJ を作る。
func bctInitRepo(t *testing.T, proj string, gateYaml bool) {
	t.Helper()
	if gateYaml {
		WriteGateYaml(proj, Dict{"rules": []any{}})
	}
	bctGit(t, proj, "init", "-q")
	bctGit(t, proj, "config", "user.email", "t@example.com")
	bctGit(t, proj, "config", "user.name", "t")
	writeText(filepath.Join(proj, ".gitignore"), ".claude/.gate-status/\nignored.txt\n")
	writeText(filepath.Join(proj, "tracked.txt"), "a\n")
	writeText(filepath.Join(proj, "old.txt"), "a\n")
	bctGit(t, proj, "add", ".")
	// 開始時刻（T0）より前のコミットにしておく。後のコミットは「このコマンドが触ったファイル」の候補になるため。
	bctGitAt(t, bctT0-3_600_000, proj, "commit", "-q", "-m", "init")
}

func bctSetMtime(t *testing.T, p string, ms int64) {
	t.Helper()
	ts := time.UnixMilli(ms)
	require.NoError(t, os.Chtimes(p, ts, ts))
}

func bctPayload(extra Dict) Dict {
	p := Dict{
		"session_id":  "sess-1",
		"tool_name":   "Bash",
		"tool_input":  Dict{"command": "bun run format"},
		"tool_use_id": "tu1",
	}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func bctSorted(s []string) []string {
	out := slices.Clone(s)
	slices.Sort(out)
	return out
}

type bctClock struct{ t int64 }

// bctRun は一時プロジェクトと空の feedback ディレクトリ（実環境の ~/.claude/feedback を読まないため）を用意する。
func bctRun(t *testing.T, body func(proj, fb string, clock *bctClock, io Io)) {
	t.Helper()
	proj := TmpDir()
	fb := TmpDir("bash-changes-fb-")
	t.Cleanup(func() { RmTree(proj); RmTree(fb) })
	clock := &bctClock{t: bctT0}
	io := MakeIo(IoOpts{ProjectDir: proj, Now: func() int64 { return clock.t }, Env: EnvVars{ClaudeFeedbackDir: fb}})
	body(proj, fb, clock, io)
}

func TestMentionsWorktree(t *testing.T) {
	t.Run("matches the worktree path, not a name that only shares its prefix", func(t *testing.T) {
		assert.True(t, MentionsWorktree("cd .claude/worktrees/w && bun test", "w"))
		assert.True(t, MentionsWorktree("cat > /p/.claude/worktrees/w/a.ts", "w"))
		assert.True(t, MentionsWorktree("ls .claude/worktrees/w", "w"))
		assert.False(t, MentionsWorktree("ls .claude/worktrees/w-2/a", "w"))
		assert.False(t, MentionsWorktree("bun run format", "w"))
	})
}

func TestSkipCommandRe(t *testing.T) {
	t.Run("matches git history / worktree commands", func(t *testing.T) {
		for _, c := range []string{"git rebase -i", "git checkout -b x", "git stash pop", "git worktree add ../x", "git -C sub pull --rebase", "cd x && git merge main"} {
			assert.True(t, SkipCommandRe.MatchString(c), c)
		}
	})
	t.Run("does not match read-only git or other commands", func(t *testing.T) {
		for _, c := range []string{
			"git status",
			"git diff",
			"git log",
			"bun run format",
			"sed -i 's/a/b/' x.txt",
			`git commit -m "fix checkout flow"`,
			`git add -A && git commit -m "restore the reset button"`,
			"git -C .claude/worktrees/w commit -m merge",
		} {
			assert.False(t, SkipCommandRe.MatchString(c), c)
		}
	})
}

func TestIsReadOnlyCommand(t *testing.T) {
	t.Run("accepts commands that only read", func(t *testing.T) {
		for _, c := range []string{
			"ls -la",
			"cat src/a.ts | head -20",
			"grep -rn foo src && git status",
			"git -C sub log --oneline -5; git diff HEAD~1",
			`rg "x" --glob "*.ts" 2>/dev/null`,
			`find . -name "*.go" | wc -l`,
			"FOO=1 env | sort | uniq -c",
			"cd src && ls $(git rev-parse --show-toplevel)",
			"sed -n 1,20p a.ts",
			"go list ./... && go env GOPATH",
			"cat a.txt > /dev/null 2>&1",
			`echo "hello" && pwd`,
			"/usr/bin/grep x y",
			"time ls",
		} {
			assert.True(t, IsReadOnlyCommand(c), c)
		}
	})
	t.Run("rejects commands that may write", func(t *testing.T) {
		for _, c := range []string{
			"",
			"echo x > a.txt",
			"cat a >> b",
			"sed -i s/a/b/ x.txt",
			"sed -ni p x.txt",
			"sort -o out in",
			`find . -name "*.tmp" -delete`,
			`find . -exec rm {} \;`,
			`awk '{system("rm x")}' f`,
			"ls | xargs rm",
			"cat a | tee b",
			"bun run format",
			"python3 x.py",
			"git checkout -- .",
			"git diff --output=p.diff",
			"ls && make",
			"go build ./...",
			"cat <<EOF > x\nhi\nEOF",
			"ls $(touch x)",
			"ls `rm x`",
			"ls; (rm x)",
			"sudo ls",
		} {
			assert.False(t, IsReadOnlyCommand(c), c)
		}
	})
}

func TestRecordBashChanges(t *testing.T) {
	t.Run("does not record anything for a read-only command, even when a file was written meanwhile", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			p := bctPayload(Dict{"tool_input": Dict{"command": "grep -rn foo . | head"}})
			BashStarted(io, p)
			assert.False(t, Exists(StatePath(proj, "bash_started", "sess-1--tu1", "json")))
			// 別のセッションがその間に書いたファイル
			writeText(filepath.Join(proj, "tracked.txt"), "edited by another session\n")
			bctSetMtime(t, filepath.Join(proj, "tracked.txt"), bctT0+500)
			assert.Empty(t, RecordBashChanges(io, p))
			assert.False(t, Exists(ChangedPath(proj, "sess-1")))
		})
	})

	t.Run("does not record files another session already holds in its gate state (same working tree)", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			require.NoError(t, os.MkdirAll(filepath.Dir(ChangedPath(proj, "sess-2")), 0o755))
			writeText(ChangedPath(proj, "sess-2"), filepath.Join(proj, "tracked.txt")+"\n")
			writeText(StatePath(proj, "gate_failed", "sess-3--agent-9", "txt"), filepath.Join(proj, "old.txt")+"\n")
			// 自分のセッションのサブエージェント分は他人扱いしない
			writeText(StatePath(proj, "gate_passed", "sess-1--agent-1", "txt"), filepath.Join(proj, "mine.txt")+"\n")
			p := bctPayload(Dict{"tool_input": Dict{"command": "bun run format"}})
			BashStarted(io, p)
			for _, f := range []string{"tracked.txt", "old.txt", "mine.txt", "new.txt"} {
				writeText(filepath.Join(proj, f), "changed\n")
				bctSetMtime(t, filepath.Join(proj, f), bctT0+500)
			}
			want := []string{filepath.Join(proj, "mine.txt"), filepath.Join(proj, "new.txt")}
			assert.Equal(t, want, bctSorted(RecordBashChanges(io, p)))
			assert.Equal(t, want, bctSorted(ChangedLines(proj, "sess-1")))
		})
	})

	t.Run("records only files whose mtime is at or after the start", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			// 開始前から変更されていた古いファイル
			writeText(filepath.Join(proj, "old.txt"), "edited before\n")
			bctSetMtime(t, filepath.Join(proj, "old.txt"), bctT0-60_000)
			BashStarted(io, bctPayload(nil))
			writeText(filepath.Join(proj, "tracked.txt"), "edited by bash\n")
			bctSetMtime(t, filepath.Join(proj, "tracked.txt"), bctT0+1000)
			got := RecordBashChanges(io, bctPayload(nil))
			assert.Equal(t, []string{filepath.Join(proj, "tracked.txt")}, got)
			assert.Equal(t, []string{filepath.Join(proj, "tracked.txt")}, ChangedLines(proj, "sess-1"))
		})
	})

	t.Run("picks up both modified and untracked files, but not ignored ones", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			BashStarted(io, bctPayload(nil))
			writeText(filepath.Join(proj, "tracked.txt"), "changed\n")
			writeText(filepath.Join(proj, "new.txt"), "new\n")
			writeText(filepath.Join(proj, "ignored.txt"), "ignored\n")
			for _, f := range []string{"tracked.txt", "new.txt", "ignored.txt"} {
				bctSetMtime(t, filepath.Join(proj, f), bctT0+500)
			}
			got := RecordBashChanges(io, bctPayload(nil))
			assert.Equal(t, []string{filepath.Join(proj, "new.txt"), filepath.Join(proj, "tracked.txt")}, bctSorted(got))
		})
	})

	t.Run("keeps a file whose mtime is within the 2s slack before the start", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			BashStarted(io, bctPayload(nil))
			writeText(filepath.Join(proj, "tracked.txt"), "changed\n")
			bctSetMtime(t, filepath.Join(proj, "tracked.txt"), bctT0-1500)
			assert.Equal(t, []string{filepath.Join(proj, "tracked.txt")}, RecordBashChanges(io, bctPayload(nil)))
		})
	})

	t.Run("does nothing without gate.yaml (and without post_edit / pre_edit feedback rules)", func(t *testing.T) {
		bctRun(t, func(proj, fb string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, false)
			BashStarted(io, bctPayload(nil))
			assert.False(t, Exists(StatePath(proj, "bash_started", "sess-1", "json")))
			assert.False(t, Exists(StatePath(proj, "bash_started", "sess-1--tu1", "json")))
			assert.False(t, Exists(filepath.Join(fb, ".bash_started")))
			writeText(filepath.Join(proj, "tracked.txt"), "changed\n")
			bctSetMtime(t, filepath.Join(proj, "tracked.txt"), bctT0+500)
			assert.Empty(t, RecordBashChanges(io, bctPayload(nil)))
			assert.False(t, Exists(ChangedPath(proj, "sess-1")))
		})
	})

	t.Run("does nothing without bash_started or with a different tool_use_id", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			writeText(filepath.Join(proj, "tracked.txt"), "changed\n")
			bctSetMtime(t, filepath.Join(proj, "tracked.txt"), bctT0+500)
			assert.Empty(t, RecordBashChanges(io, bctPayload(nil)))
			BashStarted(io, bctPayload(Dict{"tool_use_id": "other"}))
			assert.Empty(t, RecordBashChanges(io, bctPayload(nil)))
			assert.False(t, Exists(ChangedPath(proj, "sess-1")))
			// 別の tool_use_id の開始時刻は別のファイルなので、残ったまま（次の Bash の開始時か、セッション開始時に掃かれる）
			assert.True(t, Exists(StatePath(proj, "bash_started", "sess-1--other", "json")))
			assert.False(t, Exists(StatePath(proj, "bash_started", "sess-1--tu1", "json")))
		})
	})

	t.Run("keys the start time by tool_use_id and removes it once used", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			BashStarted(io, bctPayload(Dict{"tool_use_id": "toolu_01/AB"}))
			// ファイル名に使えない文字は _ に置き換える
			assert.True(t, Exists(StatePath(proj, "bash_started", "sess-1--toolu_01_AB", "json")))
			assert.False(t, Exists(StatePath(proj, "bash_started", "sess-1", "json")))
			writeText(filepath.Join(proj, "new.txt"), "new\n")
			bctSetMtime(t, filepath.Join(proj, "new.txt"), bctT0+500)
			assert.Equal(t, []string{filepath.Join(proj, "new.txt")}, RecordBashChanges(io, bctPayload(Dict{"tool_use_id": "toolu_01/AB"})))
			assert.False(t, Exists(StatePath(proj, "bash_started", "sess-1--toolu_01_AB", "json")))
		})
	})

	t.Run("falls back to the state id when there is no tool_use_id", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			p := bctPayload(Dict{"tool_use_id": nil, "agent_id": "a1"})
			BashStarted(io, p)
			assert.True(t, Exists(StatePath(proj, "bash_started", "sess-1--a1", "json")))
			writeText(filepath.Join(proj, "new.txt"), "new\n")
			bctSetMtime(t, filepath.Join(proj, "new.txt"), bctT0+500)
			assert.Equal(t, []string{filepath.Join(proj, "new.txt")}, RecordBashChanges(io, p))
			assert.False(t, Exists(StatePath(proj, "bash_started", "sess-1--a1", "json")))
		})
	})

	t.Run("sweeps start files of the same session older than 2h, keeping recent ones and other sessions", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			old := StatePath(proj, "bash_started", "sess-1--failed", "json")
			recent := StatePath(proj, "bash_started", "sess-1--running", "json")
			other := StatePath(proj, "bash_started", "sess-2--failed", "json")
			for _, f := range []struct {
				path string
				ms   int64
			}{
				{old, bctT0 - 3*60*60*1000},
				{recent, bctT0 - 60*1000},
				{other, bctT0 - 3*60*60*1000},
			} {
				writeText(f.path, "{}\n")
				bctSetMtime(t, f.path, f.ms)
			}
			BashStarted(io, bctPayload(nil))
			assert.False(t, Exists(old))
			assert.True(t, Exists(recent))
			assert.True(t, Exists(other))
			assert.True(t, Exists(StatePath(proj, "bash_started", "sess-1--tu1", "json")))
		})
	})

	t.Run("does not record for git history commands", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			p := bctPayload(Dict{"tool_input": Dict{"command": "git checkout -b feature"}})
			BashStarted(io, p)
			writeText(filepath.Join(proj, "tracked.txt"), "changed\n")
			bctSetMtime(t, filepath.Join(proj, "tracked.txt"), bctT0+500)
			assert.Empty(t, RecordBashChanges(io, p))
			assert.False(t, Exists(ChangedPath(proj, "sess-1")))
		})
	})

	t.Run("does not duplicate lines when called twice; the second call returns nothing", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			writeText(filepath.Join(proj, "tracked.txt"), "changed\n")
			bctSetMtime(t, filepath.Join(proj, "tracked.txt"), bctT0+500)
			BashStarted(io, bctPayload(nil))
			assert.Len(t, RecordBashChanges(io, bctPayload(nil)), 1)
			BashStarted(io, bctPayload(Dict{"tool_use_id": "tu2"}))
			assert.Empty(t, RecordBashChanges(io, bctPayload(Dict{"tool_use_id": "tu2"})))
			assert.Equal(t, []string{filepath.Join(proj, "tracked.txt")}, ChangedLines(proj, "sess-1"))
		})
	})

	t.Run("excludes files under .claude/.gate-status/", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			// .gitignore されていなくても除外される
			writeText(filepath.Join(proj, ".gitignore"), "ignored.txt\n")
			bctSetMtime(t, filepath.Join(proj, ".gitignore"), bctT0-60_000)
			BashStarted(io, bctPayload(nil))
			state := filepath.Join(proj, ".claude", ".gate-status", "gate_trace.sess-1.jsonl")
			writeText(state, "{}\n")
			bctSetMtime(t, state, bctT0+500)
			writeText(filepath.Join(proj, "new.txt"), "new\n")
			bctSetMtime(t, filepath.Join(proj, "new.txt"), bctT0+500)
			got := RecordBashChanges(io, bctPayload(nil))
			assert.Equal(t, []string{filepath.Join(proj, "new.txt")}, got)
		})
	})

	t.Run("records under the agent-suffixed state id of PostToolUse even when PreToolUse had no agent id", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			// エンジンは classic.PreToolUse にエージェント ID を渡さない。PostToolUse（stdin JSON）には agent_id が入る。
			BashStarted(io, bctPayload(nil))
			assert.True(t, Exists(StatePath(proj, "bash_started", "sess-1--tu1", "json")))
			writeText(filepath.Join(proj, "new.txt"), "new\n")
			bctSetMtime(t, filepath.Join(proj, "new.txt"), bctT0+500)
			assert.Equal(t, []string{filepath.Join(proj, "new.txt")}, RecordBashChanges(io, bctPayload(Dict{"agent_id": "a1"})))
			assert.Equal(t, []string{filepath.Join(proj, "new.txt")}, ChangedLines(proj, "sess-1--a1"))
			assert.False(t, Exists(ChangedPath(proj, "sess-1")))
		})
	})

	t.Run("keeps the commands of two agents apart by tool_use_id", func(t *testing.T) {
		bctRun(t, func(proj, _ string, clock *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			BashStarted(io, bctPayload(Dict{"tool_use_id": "tu-a"}))
			clock.t = bctT0 + 10_000
			BashStarted(io, bctPayload(Dict{"tool_use_id": "tu-b"}))
			writeText(filepath.Join(proj, "a.txt"), "a\n")
			bctSetMtime(t, filepath.Join(proj, "a.txt"), bctT0+1000)
			writeText(filepath.Join(proj, "b.txt"), "b\n")
			bctSetMtime(t, filepath.Join(proj, "b.txt"), bctT0+11_000)
			// b の開始（T0+10s）より前に書かれた a.txt は b のものではない
			assert.Equal(t, []string{filepath.Join(proj, "b.txt")}, RecordBashChanges(io, bctPayload(Dict{"tool_use_id": "tu-b", "agent_id": "b"})))
			got := RecordBashChanges(io, bctPayload(Dict{"tool_use_id": "tu-a", "agent_id": "a"}))
			assert.Equal(t, []string{filepath.Join(proj, "a.txt"), filepath.Join(proj, "b.txt")}, bctSorted(got))
			assert.Equal(t, []string{filepath.Join(proj, "a.txt"), filepath.Join(proj, "b.txt")}, bctSorted(ChangedLines(proj, "sess-1--a")))
			assert.Equal(t, []string{filepath.Join(proj, "b.txt")}, ChangedLines(proj, "sess-1--b"))
		})
	})

	t.Run("records files committed within the same command", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			BashStarted(io, bctPayload(Dict{"tool_input": Dict{"command": "cat > a.txt <<EOF ... EOF && git add -A && git commit -m wip"}}))
			writeText(filepath.Join(proj, "a.txt"), "new\n")
			writeText(filepath.Join(proj, "tracked.txt"), "changed\n")
			for _, f := range []string{"a.txt", "tracked.txt"} {
				bctSetMtime(t, filepath.Join(proj, f), bctT0+500)
			}
			bctGit(t, proj, "add", "-A")
			bctGitAt(t, bctT0+1000, proj, "commit", "-q", "-m", "wip")
			got := RecordBashChanges(io, bctPayload(Dict{"tool_input": Dict{"command": "git commit"}}))
			assert.Equal(t, []string{filepath.Join(proj, "a.txt"), filepath.Join(proj, "tracked.txt")}, bctSorted(got))
		})
	})

	t.Run("does not record files of commits made before the start", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			writeText(filepath.Join(proj, "a.txt"), "new\n")
			bctSetMtime(t, filepath.Join(proj, "a.txt"), bctT0-60_000)
			bctGit(t, proj, "add", "-A")
			bctGitAt(t, bctT0-60_000, proj, "commit", "-q", "-m", "earlier")
			BashStarted(io, bctPayload(nil))
			assert.Empty(t, RecordBashChanges(io, bctPayload(nil)))
		})
	})

	t.Run("records files written into a worktree under .claude/worktrees while cwd is the main checkout", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			bctGitAt(t, bctT0-3_600_000, proj, "worktree", "add", "-q", ".claude/worktrees/w", "-b", "w")
			wt := filepath.Join(proj, ".claude", "worktrees", "w")
			p := bctPayload(Dict{"cwd": proj, "tool_input": Dict{"command": "cat > " + wt + "/new.txt <<'EOF'\nnew\nEOF\nsed -i s/a/changed/ .claude/worktrees/w/tracked.txt"}})
			BashStarted(io, p)
			writeText(filepath.Join(wt, "new.txt"), "new\n")
			writeText(filepath.Join(wt, "tracked.txt"), "changed\n")
			for _, f := range []string{"new.txt", "tracked.txt"} {
				bctSetMtime(t, filepath.Join(wt, f), bctT0+500)
			}
			got := RecordBashChanges(io, p)
			want := []string{filepath.Join(wt, "new.txt"), filepath.Join(wt, "tracked.txt")}
			assert.Equal(t, want, bctSorted(got))
			assert.Equal(t, want, bctSorted(ChangedLines(proj, "sess-1")))
		})
	})

	t.Run("does not record files written meanwhile in a worktree the command does not mention (another session editing there)", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			bctInitRepo(t, proj, true)
			bctGitAt(t, bctT0-3_600_000, proj, "worktree", "add", "-q", ".claude/worktrees/other", "-b", "other")
			bctGitAt(t, bctT0-3_600_000, proj, "worktree", "add", "-q", ".claude/worktrees/other-2", "-b", "other-2")
			other := filepath.Join(proj, ".claude", "worktrees", "other")
			// other-2 だけを指すコマンド。other は名前の接頭辞が同じだけで、指していない。
			p := bctPayload(Dict{"cwd": proj, "tool_input": Dict{"command": "echo x > new.txt && ls .claude/worktrees/other-2"}})
			BashStarted(io, p)
			writeText(filepath.Join(proj, "new.txt"), "x\n")
			writeText(filepath.Join(other, "red.test.ts"), "expect(1).toBe(2)\n")
			for _, f := range []string{filepath.Join(proj, "new.txt"), filepath.Join(other, "red.test.ts")} {
				bctSetMtime(t, f, bctT0+500)
			}
			assert.Equal(t, []string{filepath.Join(proj, "new.txt")}, RecordBashChanges(io, p))
		})
	})

	t.Run("returns nothing outside a git repository", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			WriteGateYaml(proj, Dict{"rules": []any{}})
			BashStarted(io, bctPayload(nil))
			assert.Empty(t, RecordBashChanges(io, bctPayload(nil)))
		})
	})
}

func TestBashChanges(t *testing.T) {
	t.Run("runs the rules phase only when something was recorded", func(t *testing.T) {
		bctRun(t, func(proj, _ string, _ *bctClock, io Io) {
			WriteGateYaml(proj, Dict{"rules": []any{Dict{"match": "**/*.txt", "run": []any{"echo lint-failed; exit 1"}}}})
			bctInitRepo(t, proj, false)
			BashStarted(io, bctPayload(nil))
			none := BashChanges(io, bctPayload(nil))
			assert.Equal(t, 0, none.ExitCode)
			assert.NotContains(t, none.Stdout+none.Stderr, "lint-failed")
			BashStarted(io, bctPayload(Dict{"tool_use_id": "tu2"}))
			writeText(filepath.Join(proj, "new.txt"), "new\n")
			bctSetMtime(t, filepath.Join(proj, "new.txt"), bctT0+500)
			r := BashChanges(io, bctPayload(Dict{"tool_use_id": "tu2"}))
			assert.Contains(t, r.Stdout+r.Stderr, "lint-failed")
		})
	})
}
