package hookgate

// tests/config-dir.spec.ts のうち host-codex（CodexConfigDirs）に触れる部分と、gate.yml の綴り間違い（stop_test_gate.go）の移植。
// config_dir_test.go / config_dir_feedback_test.go は同じ場面を codexDirsForTest（CodexConfigDirs と同じ値の写し）で検証している。
// ここではそれが本物の CodexConfigDirs と一致することと、本物の定数での各場面、gate.yml の case を確かめる。

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCodexConfigDirsConstant(t *testing.T) {
	t.Run("CodexConfigDirs is the reverse of ClaudeConfigDirs, and the hosts expose them", func(t *testing.T) {
		assert.Equal(t, codexDirsForTest, CodexConfigDirs)
		assert.Equal(t, []string{".claude", ".agents"}, ClaudeConfigDirs)
		assert.Equal(t, CodexConfigDirs, CodexHost.ConfigDirNames())
		assert.Equal(t, ClaudeConfigDirs, ClaudeHost.ConfigDirNames())
	})
}

func TestConfigDirWithCodexDirs(t *testing.T) {
	exists := func(p string) bool { _, err := os.Stat(p); return err == nil }

	t.Run("the first existing candidate wins; with none, the first candidate", func(t *testing.T) {
		withDirs(func(proj, _ string) {
			assert.Equal(t, filepath.Join(proj, ".claude"), PickConfigDir(ClaudeConfigDirs, proj, exists))
			assert.Equal(t, filepath.Join(proj, ".agents"), PickConfigDir(CodexConfigDirs, proj, exists))
			require.NoError(t, os.Mkdir(filepath.Join(proj, ".agents"), 0o755))
			assert.Equal(t, filepath.Join(proj, ".agents"), PickConfigDir(ClaudeConfigDirs, proj, exists))
			require.NoError(t, os.Mkdir(filepath.Join(proj, ".claude"), 0o755))
			assert.Equal(t, filepath.Join(proj, ".claude"), PickConfigDir(ClaudeConfigDirs, proj, exists))
			assert.Equal(t, filepath.Join(proj, ".agents"), PickConfigDir(CodexConfigDirs, proj, exists))
			assert.Equal(t, []string{filepath.Join(proj, ".agents", "gate.yaml"), filepath.Join(proj, ".claude", "gate.yaml")},
				ConfigPaths(MakeIo(IoOpts{ProjectDir: proj, ConfigDirNames: CodexConfigDirs}), proj, "gate.yaml"))
		})
	})

	t.Run("Codex prefers .agents over .claude when both have a gate.yaml; Claude Code prefers .claude", func(t *testing.T) {
		withDirs(func(proj, _ string) {
			for _, d := range []string{".agents", ".claude"} {
				require.NoError(t, os.Mkdir(filepath.Join(proj, d), 0o755))
				require.NoError(t, os.WriteFile(filepath.Join(proj, d, "gate.yaml"), []byte(`{"rules":[]}`), 0o644))
			}
			got, _ := FindGateYaml(MakeIo(IoOpts{ProjectDir: proj, ConfigDirNames: CodexConfigDirs}))
			assert.Equal(t, filepath.Join(proj, ".agents", "gate.yaml"), got)
			got, _ = FindGateYaml(MakeIo(IoOpts{ProjectDir: proj}))
			assert.Equal(t, filepath.Join(proj, ".claude", "gate.yaml"), got)
		})
	})

	t.Run("an Io made for the Codex host (MakeOsIo) uses the Codex candidates", func(t *testing.T) {
		withDirs(func(proj, home string) {
			require.NoError(t, os.Mkdir(filepath.Join(proj, ".claude"), 0o755))
			environ := map[string]string{"HOME": home, "CLAUDE_PROJECT_DIR": proj}
			io := MakeOsIo(OsIoInit{Environ: environ, PayloadCwd: proj, ConfigDirNames: CodexHost.ConfigDirNames(), AppName: CodexHost.AppName()})
			assert.Equal(t, CodexConfigDirs, io.ConfigDirNames())
			assert.Equal(t, "Codex", io.AppName())
			// .agents は無く .claude だけがある: 存在する候補（.claude）に決まる。
			assert.Equal(t, filepath.Join(proj, ".claude"), io.ProjectConfigDir())
			require.NoError(t, os.Mkdir(filepath.Join(proj, ".agents"), 0o755))
			io = MakeOsIo(OsIoInit{Environ: environ, PayloadCwd: proj, ConfigDirNames: CodexHost.ConfigDirNames()})
			assert.Equal(t, filepath.Join(proj, ".agents"), io.ProjectConfigDir())
		})
	})
}

func TestGateYmlTypo(t *testing.T) {
	t.Run("the gate.yml typo is reported with the path it was found at, in either directory", func(t *testing.T) {
		withDirs(func(proj, _ string) {
			require.NoError(t, os.Mkdir(filepath.Join(proj, ".agents"), 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(proj, ".agents", "gate.yml"), []byte(`{"rules":[]}`), 0o644))
			r := StopTestGate(MakeIo(IoOpts{ProjectDir: proj}), "rules", Dict{"session_id": "s"})
			assert.Contains(t, r.Stdout, filepath.Join(proj, ".agents", "gate.yml"))
		})
	})

	t.Run("the same typo in .claude is reported too", func(t *testing.T) {
		withDirs(func(proj, _ string) {
			require.NoError(t, os.Mkdir(filepath.Join(proj, ".claude"), 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(proj, ".claude", "gate.yml"), []byte(`{"rules":[]}`), 0o644))
			r := StopTestGate(MakeIo(IoOpts{ProjectDir: proj, ConfigDirNames: CodexConfigDirs}), "rules", Dict{"session_id": "s"})
			assert.Contains(t, r.Stdout, filepath.Join(proj, ".claude", "gate.yml"))
		})
	})
}
