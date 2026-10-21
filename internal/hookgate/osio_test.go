package hookgate

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOsIoRun(t *testing.T) {
	io := MakeIo(IoOpts{ProjectDir: t.TempDir()})

	t.Run("runs argv directly and captures output and exit code", func(t *testing.T) {
		r := io.Run([]string{"sh", "-c", "echo out; echo err >&2; exit 3"}, RunOptions{})
		assert.Equal(t, RunResult{ExitCode: 3, Stdout: "out\n", Stderr: "err\n"}, r)
	})

	t.Run("stdin, cwd and env overlay; CLAUDE_AGENT_ID is never inherited", func(t *testing.T) {
		t.Setenv("CLAUDE_AGENT_ID", "leak")
		t.Setenv("KEEP_ME", "kept")
		dir := TmpDir()
		defer RmTree(dir)
		r := io.Run([]string{"sh", "-c", `cat; pwd; echo "[$CLAUDE_AGENT_ID][$KEEP_ME][$X]"`}, RunOptions{Stdin: "in\n", Cwd: dir, Env: map[string]string{"X": "1"}})
		assert.Equal(t, "in\n"+dir+"\n[][kept][1]\n", r.Stdout)
	})

	t.Run("a timeout kills the whole process group", func(t *testing.T) {
		r := io.Run([]string{"sh", "-c", "sleep 30 & sleep 30"}, RunOptions{TimeoutMs: 200})
		assert.True(t, r.TimedOut)
		assert.Equal(t, 1, r.ExitCode)
	})

	t.Run("a command that cannot start reports an error with exit code 1", func(t *testing.T) {
		r := io.Run([]string{"/no/such/command"}, RunOptions{})
		assert.Equal(t, 1, r.ExitCode)
		assert.NotEmpty(t, r.Error)
		assert.Equal(t, 1, io.Run(nil, RunOptions{}).ExitCode)
	})

	t.Run("the command is looked up in the PATH given by the overlay", func(t *testing.T) {
		dir := TmpDir()
		defer RmTree(dir)
		bin := filepath.Join(dir, "mytool")
		require.NoError(t, os.WriteFile(bin, []byte("#!/bin/sh\necho tool\n"), 0o755))
		r := io.Run([]string{"mytool"}, RunOptions{Env: map[string]string{"PATH": dir + ":" + os.Getenv("PATH")}})
		assert.Equal(t, "tool\n", r.Stdout)
	})
}

func TestOsIoFiles(t *testing.T) {
	dir := TmpDir()
	defer RmTree(dir)
	io := MakeOsIo(OsIoInit{Environ: map[string]string{"HOME": dir, "CLAUDE_PROJECT_DIR": dir, "CLAUDE_PLUGIN_ROOT": "/plug", "LANG": "ja_JP.UTF-8"}, PayloadCwd: "/cwd"})

	t.Run("properties come from the environment", func(t *testing.T) {
		assert.Equal(t, dir, io.ProjectDir())
		assert.Equal(t, "/cwd", io.Cwd())
		assert.Equal(t, "/plug", io.PluginRoot())
		assert.Equal(t, LangJA, io.Lang())
		assert.True(t, io.AutoCount())
		assert.Equal(t, filepath.Join(dir, ".claude"), io.ProjectConfigDir())
		assert.Equal(t, dir, io.Env().Home)
	})

	t.Run("write creates parents; read, stat, list, remove", func(t *testing.T) {
		p := filepath.Join(dir, "a", "b", "c.txt")
		require.NoError(t, io.WriteFile(p, "hello"))
		got, ok := io.ReadFile(p)
		assert.True(t, ok)
		assert.Equal(t, "hello", got)
		_, ok = io.ReadFile(filepath.Join(dir, "nope"))
		assert.False(t, ok)
		st, ok := io.Stat(p)
		assert.True(t, ok)
		assert.Equal(t, KindFile, st.Kind)
		assert.EqualValues(t, 5, st.Size)
		entries := io.List(filepath.Join(dir, "a"))
		require.Len(t, entries, 1)
		assert.Equal(t, DirEntry{Name: "b", Kind: KindDir}, entries[0])
		assert.Empty(t, io.List(filepath.Join(dir, "nope")))
		assert.False(t, io.IsExecutable(p))
		io.RemoveDir(filepath.Join(dir, "a", "b")) // not empty: silent no-op
		assert.True(t, io.Exists(p))
		io.RemoveFiles([]string{p, filepath.Join(dir, "missing")})
		assert.False(t, io.Exists(p))
		io.RemoveDir(filepath.Join(dir, "a", "b"))
		assert.False(t, io.Exists(filepath.Join(dir, "a", "b")))
		io.RemoveTree(filepath.Join(dir, "a"))
		assert.False(t, io.Exists(filepath.Join(dir, "a")))
	})

	t.Run("RemoveDir never removes a file", func(t *testing.T) {
		p := Touch(dir, "keep.txt")
		io.RemoveDir(p)
		assert.True(t, io.Exists(p))
	})

	t.Run("Which finds executables on PATH", func(t *testing.T) {
		bin := filepath.Join(dir, "bin")
		require.NoError(t, os.MkdirAll(bin, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(bin, "tool"), []byte("#!/bin/sh\n"), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(bin, "data"), []byte("x"), 0o644))
		wio := MakeIo(IoOpts{ProjectDir: dir, Env: EnvVars{Path: ":" + bin}})
		got, ok := Which(wio, "tool")
		assert.True(t, ok)
		assert.Equal(t, filepath.Join(bin, "tool"), got)
		_, ok = Which(wio, "data")
		assert.False(t, ok)
		_, ok = Which(wio, "nothing")
		assert.False(t, ok)
		got, ok = Which(wio, filepath.Join(bin, "tool"))
		assert.True(t, ok)
		assert.Equal(t, filepath.Join(bin, "tool"), got)
	})
}
