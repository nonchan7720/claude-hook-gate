package hookgate

// mod（src/go-bridge.ts）から呼ばれたときに、Progress / Result / Redraw が stderr の行として流れることの確認。

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func TestOsIoEvents(t *testing.T) {
	t.Run("without Events the screen methods do nothing and Every never fires", func(t *testing.T) {
		io := MakeOsIo(OsIoInit{Environ: map[string]string{}})
		io.Progress("x")
		io.Result("y")
		io.Redraw()
		var fired atomic.Int32
		stop := io.Every(1, func() { fired.Add(1) })
		time.Sleep(20 * time.Millisecond)
		stop()
		assert.Equal(t, int32(0), fired.Load())
	})

	t.Run("with Events each update is one prefixed JSON line, and Every fires until stopped", func(t *testing.T) {
		var buf lockedBuffer
		io := MakeOsIo(OsIoInit{Environ: map[string]string{}, Events: &buf})
		io.Progress("評価中: a")
		io.Result("")
		io.Redraw()
		assert.Equal(t, EventLinePrefix+`{"progress":"評価中: a"}`+"\n"+EventLinePrefix+`{"result":""}`+"\n"+EventLinePrefix+`{"redraw":true}`+"\n", buf.String())
		var fired atomic.Int32
		stop := io.Every(5, func() { fired.Add(1) })
		require.Eventually(t, func() bool { return fired.Load() > 0 }, time.Second, 5*time.Millisecond)
		stop()
		stop() // 2 回止めても壊れない
		// 止めた時点で呼び出し中だった 1 回は終わりうるが、それより後には呼ばない。
		n := fired.Load()
		time.Sleep(30 * time.Millisecond)
		assert.LessOrEqual(t, fired.Load(), n+1)
	})
}

func TestCliMainEvents(t *testing.T) {
	proj := TmpDir()
	home := TmpDir()
	t.Cleanup(func() { RmTree(proj); RmTree(home) })
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_PROJECT_DIR", proj)
	t.Setenv("CLAUDE_PLUGIN_ROOT", RepoRoot)
	t.Setenv("CLAUDE_FEEDBACK_DIR", filepath.Join(proj, "fb"))
	t.Setenv("DOGWOOD_BIN", MissingDogwoodBin)
	require.NoError(t, os.MkdirAll(filepath.Join(proj, ".claude"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(proj, ".claude", "gate.yaml"), []byte("rules:\n  - match: '**/*.py'\n    run:\n      - cmd: 'true'\n        name: fmt\n"), 0o644))
	stdin := `{"session_id":"s","cwd":"` + proj + `","tool_name":"Write","tool_input":{"file_path":"` + filepath.Join(proj, "x.py") + `"}}`

	t.Run("FEEDBACK_GATE_EVENTS=stderr streams the gate result to stderr", func(t *testing.T) {
		t.Setenv("FEEDBACK_GATE_EVENTS", "stderr")
		var out, errOut bytes.Buffer
		assert.Equal(t, 0, CliMain(ClaudeHost, []string{"PostToolUse"}, strings.NewReader(stdin), &out, &errOut))
		assert.Contains(t, errOut.String(), EventLinePrefix+`{"redraw":true}`)
		assert.Contains(t, errOut.String(), EventLinePrefix+`{"result":"[gate]`)
	})

	t.Run("without it nothing is streamed", func(t *testing.T) {
		var out, errOut bytes.Buffer
		assert.Equal(t, 0, CliMain(ClaudeHost, []string{"PostToolUse"}, strings.NewReader(stdin), &out, &errOut))
		assert.NotContains(t, errOut.String(), EventLinePrefix)
	})
}
