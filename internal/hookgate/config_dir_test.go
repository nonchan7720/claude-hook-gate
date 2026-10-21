package hookgate

// 設定ディレクトリの候補（.claude / .agents）: どちらにあっても読め、状態ファイルは 1 か所に置く。
// tests/config-dir.spec.ts のうち feedback ルール（feedback_rules.go）と gate.yml の綴り間違い（stop_test_gate.go）に
// 触れるテストは、それらのモジュールの移植担当が feedback_rules_test.go / stop_test_gate_test.go に足す。

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Codex の候補は逆順（host_codex.go の CODEX_CONFIG_DIRS）。
var codexDirsForTest = []string{".agents", ".claude"}

func withDirs(body func(proj, home string)) {
	proj := TmpDir()
	home := TmpDir()
	defer RmTree(proj)
	defer RmTree(home)
	body(proj, home)
}

func TestPickConfigDirAndConfigPaths(t *testing.T) {
	t.Run("the first existing candidate wins; with none, the first candidate", func(t *testing.T) {
		withDirs(func(proj, _ string) {
			exists := func(p string) bool { _, err := os.Stat(p); return err == nil }
			assert.Equal(t, filepath.Join(proj, ".claude"), PickConfigDir(ClaudeConfigDirs, proj, exists))
			assert.Equal(t, filepath.Join(proj, ".agents"), PickConfigDir(codexDirsForTest, proj, exists))
			require.NoError(t, os.Mkdir(filepath.Join(proj, ".agents"), 0o755))
			assert.Equal(t, filepath.Join(proj, ".agents"), PickConfigDir(ClaudeConfigDirs, proj, exists))
			require.NoError(t, os.Mkdir(filepath.Join(proj, ".claude"), 0o755))
			assert.Equal(t, filepath.Join(proj, ".claude"), PickConfigDir(ClaudeConfigDirs, proj, exists))
			assert.Equal(t, filepath.Join(proj, ".agents"), PickConfigDir(codexDirsForTest, proj, exists))
			assert.Equal(t, []string{filepath.Join(proj, ".agents", "gate.yaml"), filepath.Join(proj, ".claude", "gate.yaml")},
				ConfigPaths(MakeIo(IoOpts{ProjectDir: proj, ConfigDirNames: codexDirsForTest}), proj, "gate.yaml"))
		})
	})
}

func TestGateYamlAndStateDir(t *testing.T) {
	t.Run("Claude Code finds .agents/gate.yaml when .claude has none, and keeps the state next to it", func(t *testing.T) {
		withDirs(func(proj, _ string) {
			require.NoError(t, os.Mkdir(filepath.Join(proj, ".agents"), 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(proj, ".agents", "gate.yaml"), []byte(`{"rules":[]}`), 0o644))
			io := MakeIo(IoOpts{ProjectDir: proj})
			got, ok := FindGateYaml(io)
			assert.True(t, ok)
			assert.Equal(t, filepath.Join(proj, ".agents", "gate.yaml"), got)
			assert.Equal(t, filepath.Join(proj, ".agents", ".gate-status"), GateStatusDir(io))
		})
	})

	t.Run("Codex prefers .agents over .claude when both have a gate.yaml; Claude Code prefers .claude", func(t *testing.T) {
		withDirs(func(proj, _ string) {
			for _, d := range []string{".agents", ".claude"} {
				require.NoError(t, os.Mkdir(filepath.Join(proj, d), 0o755))
				require.NoError(t, os.WriteFile(filepath.Join(proj, d, "gate.yaml"), []byte(`{"rules":[]}`), 0o644))
			}
			got, _ := FindGateYaml(MakeIo(IoOpts{ProjectDir: proj, ConfigDirNames: codexDirsForTest}))
			assert.Equal(t, filepath.Join(proj, ".agents", "gate.yaml"), got)
			got, _ = FindGateYaml(MakeIo(IoOpts{ProjectDir: proj}))
			assert.Equal(t, filepath.Join(proj, ".claude", "gate.yaml"), got)
		})
	})

	t.Run("no gate.yaml anywhere", func(t *testing.T) {
		withDirs(func(proj, _ string) {
			_, ok := FindGateYaml(MakeIo(IoOpts{ProjectDir: proj}))
			assert.False(t, ok)
		})
	})
}

func TestDefaultRulesFileLookup(t *testing.T) {
	t.Run("the default rules file is looked up in ~/.claude and ~/.agents", func(t *testing.T) {
		withDirs(func(proj, home string) {
			require.NoError(t, os.MkdirAll(filepath.Join(home, ".agents", "feedback-gate"), 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(home, ".agents", "feedback-gate", "feedback_rules.md"), []byte("AGENTS RULES\n"), 0o644))
			assert.Equal(t, "AGENTS RULES", LoadRules(MakeIo(IoOpts{ProjectDir: proj, Env: EnvVars{Home: home}}), nil))
		})
	})

	t.Run("a configured rulesFile wins, ~ expands to HOME; otherwise the bundled rules", func(t *testing.T) {
		withDirs(func(proj, home string) {
			require.NoError(t, os.WriteFile(filepath.Join(home, "mine.md"), []byte("MINE\n"), 0o644))
			io := MakeIo(IoOpts{ProjectDir: proj, Env: EnvVars{Home: home}})
			assert.Equal(t, "MINE", LoadRules(io, "~/mine.md"))
			bundled, err := os.ReadFile(filepath.Join(RepoRoot, "rules", "feedback_rules.md"))
			require.NoError(t, err)
			assert.Equal(t, string(bundled)[:10], LoadRules(io, "~/missing.md")[:10])
		})
	})
}
