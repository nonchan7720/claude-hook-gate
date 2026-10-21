//go:build !windows

package hookgate

// osIo.Run がコマンドの終了で返ること（孫がパイプを握っていても）と、hook のプロセスがシグナルで止められたとき子の
// プロセスグループを道連れにすることの確認。Node 版の tests/node-io.spec.ts に対応する。

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOsIoRunGrandchildHoldingPipes(t *testing.T) {
	io := MakeIo(IoOpts{ProjectDir: t.TempDir()})

	t.Run("returns when the command exits even if a background grandchild still holds stdout/stderr", func(t *testing.T) {
		// sleep は stdout / stderr のパイプを継いだままバックグラウンドに残る（dev サーバーやデーモンと同じ形）。
		started := time.Now()
		r := io.Run([]string{"sh", "-c", "sleep 20 & echo done"}, RunOptions{})
		assert.Equal(t, RunResult{ExitCode: 0, Stdout: "done\n"}, r)
		assert.Less(t, time.Since(started), 5*time.Second)
	})

	t.Run("the exit code of the command is kept when the pipes are dropped after the grace period", func(t *testing.T) {
		started := time.Now()
		r := io.Run([]string{"sh", "-c", "sleep 20 & echo bye; exit 4"}, RunOptions{})
		assert.Equal(t, 4, r.ExitCode)
		assert.Equal(t, "bye\n", r.Stdout)
		assert.False(t, r.TimedOut)
		assert.Empty(t, r.Error)
		assert.Less(t, time.Since(started), 5*time.Second)
	})

	t.Run("the timeout kills the process group and reports timedOut", func(t *testing.T) {
		started := time.Now()
		r := io.Run([]string{"sh", "-c", "sleep 20; echo late"}, RunOptions{TimeoutMs: 300})
		assert.True(t, r.TimedOut)
		assert.Equal(t, 1, r.ExitCode)
		assert.Empty(t, r.Stdout)
		assert.Less(t, time.Since(started), 5*time.Second)
	})
}

var (
	gateBinOnce sync.Once
	gateBinPath string
	errGateBin  error
)

// builtGateBin は feedback-gate バイナリをテストバイナリごとに 1 度だけビルドする。
func builtGateBin(t *testing.T) string {
	t.Helper()
	gateBinOnce.Do(func() {
		dir, err := os.MkdirTemp("", "feedback-gate-bin-")
		if err != nil {
			errGateBin = err
			return
		}
		gateBinPath = filepath.Join(dir, "feedback-gate")
		cmd := exec.CommandContext(context.Background(), "go", "build", "-o", gateBinPath, "./cmd/feedback-gate")
		cmd.Dir = repoRoot()
		if out, err := cmd.CombinedOutput(); err != nil {
			errGateBin = errors.New("go build failed: " + err.Error() + "\n" + string(out))
		}
	})
	require.NoError(t, errGateBin)
	return gateBinPath
}

func repoRoot() string {
	abs, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		panic(err)
	}
	return abs
}

// startHook は `feedback-gate claude PostToolUse` を、**/*.py にマッチするルールが gateCmd を走らせる一時プロジェクトで起動する。
func startHook(t *testing.T, gateCmd string) (*exec.Cmd, context.CancelFunc) {
	t.Helper()
	bin := builtGateBin(t)
	proj := t.TempDir()
	home := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(proj, ".claude"), 0o755))
	yaml, err := json.Marshal(map[string]any{"rules": []any{map[string]any{"match": "**/*.py", "run": []string{gateCmd}}}})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(proj, ".claude", "gate.yaml"), yaml, 0o644))
	file := filepath.Join(proj, "x.py")
	require.NoError(t, os.WriteFile(file, []byte("x = 1\n"), 0o644))
	payload, err := json.Marshal(map[string]any{
		"session_id": "s", "cwd": proj, "tool_name": "Write", "tool_input": map[string]any{"file_path": file},
		"tool_response": map[string]any{}, "tool_use_id": "t1",
	})
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	cmd := exec.CommandContext(ctx, bin, "claude", "PostToolUse")
	cmd.Dir = proj
	cmd.Stdin = strings.NewReader(string(payload))
	cmd.Env = append(os.Environ(),
		"HOME="+home,
		"CLAUDE_PROJECT_DIR="+proj,
		"CLAUDE_PLUGIN_ROOT="+repoRoot(),
		"DOGWOOD_BIN="+filepath.Join(home, "no-such-dogwood"),
	)
	return cmd, cancel
}

func TestHookProcessExitsWithGrandchild(t *testing.T) {
	cmd, cancel := startHook(t, "sh -c 'sleep 20 & echo hi'")
	defer cancel()
	started := time.Now()
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "output: %s", out)
	assert.Less(t, time.Since(started), 5*time.Second)
}

// processGone は pid のプロセスが消えた（または reap 待ちのゾンビ）かどうか。
func processGone(pid int) bool {
	if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
		return true
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return os.IsNotExist(err)
	}
	// "pid (comm) S ..." — comm に括弧が入りうるので最後の ) 以降を見る
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	return i >= 0 && i+2 < len(s) && s[i+2] == 'Z'
}

func TestHookProcessForwardsSignalToChildGroups(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	cmd, cancel := startHook(t, "sh -c 'echo $$ > "+pidFile+"; sleep 30'")
	defer cancel()
	require.NoError(t, cmd.Start())
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	// コマンドが走り出す（PID が書かれる）のを待つ
	var pid int
	require.Eventually(t, func() bool {
		b, err := os.ReadFile(pidFile)
		if err != nil {
			return false
		}
		p, err := strconv.Atoi(strings.TrimSpace(string(b)))
		pid = p
		return err == nil && p > 0
	}, 5*time.Second, 20*time.Millisecond)
	defer func() { _ = syscall.Kill(-pid, syscall.SIGKILL) }()
	time.Sleep(300 * time.Millisecond)

	require.NoError(t, cmd.Process.Signal(syscall.SIGTERM))
	select {
	case err := <-done:
		var exitErr *exec.ExitError
		require.ErrorAs(t, err, &exitErr)
		ws, ok := exitErr.Sys().(syscall.WaitStatus)
		require.True(t, ok)
		assert.True(t, ws.Signaled(), "the hook must terminate by the signal, got %v", exitErr)
		assert.Equal(t, syscall.SIGTERM, ws.Signal())
	case <-time.After(2 * time.Second):
		t.Fatal("the hook process did not terminate within 2s of SIGTERM")
	}

	gone := false
	for range 100 {
		if processGone(pid) {
			gone = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	assert.True(t, gone, "the gate command's process group (pid %d) must be killed with the hook", pid)
}
