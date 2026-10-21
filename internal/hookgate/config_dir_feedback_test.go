package hookgate

// tests/config-dir.spec.ts のうち feedback ルール（feedback_rules.go）に触れるテストの移植。
// （'the gate.yml typo...' は stop_test_gate.go の移植担当が stop_test_gate_test.go に足す。'the default rules file...' は
// config_dir_test.go にある。）

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFeedbackRulesInClaudeAndAgents(t *testing.T) {
	writeRule := func(dir, name string, count int) {
		fbtWrite(filepath.Join(dir, name+".md"), "---\nname: "+name+"\ndescription: d\ntype: feedback\ncount: "+strconv.Itoa(count)+"\n---\n\n"+name+"\n")
	}

	t.Run("rules from ~/.agents/feedback and <project>/.agents/feedback are read too; the state stays in one directory", func(t *testing.T) {
		withDirs(func(proj, home string) {
			writeRule(filepath.Join(home, ".claude", "feedback"), "global_claude", 3)
			writeRule(filepath.Join(home, ".agents", "feedback"), "global_agents", 3)
			writeRule(filepath.Join(proj, ".agents", "feedback"), "project_agents", 3)
			io := MakeIo(IoOpts{ProjectDir: proj, Env: EnvVars{Home: home}})
			assert.Equal(t, []string{filepath.Join(home, ".claude", "feedback"), filepath.Join(home, ".agents", "feedback")}, FeedbackDirs(io))
			assert.Equal(t, []string{filepath.Join(proj, ".claude", "feedback"), filepath.Join(proj, ".agents", "feedback")}, ProjectFeedbackDirs(io))
			assert.Equal(t, filepath.Join(home, ".claude", "feedback"), FeedbackDir(io))
			assert.Equal(t, filepath.Join(proj, ".agents", "feedback"), ProjectFeedbackDir(io))
			rules, err := ListRules(io)
			require.NoError(t, err)
			names := fbtNames(rules)
			assert.ElementsMatch(t, []string{"global_agents", "global_claude", "project_agents"}, names)
		})
	})

	t.Run("when .agents is a symlink to .claude, each rule is read once (the first candidate wins)", func(t *testing.T) {
		withDirs(func(proj, home string) {
			writeRule(filepath.Join(home, ".claude", "feedback"), "shared", 3)
			require.NoError(t, os.Symlink(filepath.Join(home, ".claude"), filepath.Join(home, ".agents")))
			writeRule(filepath.Join(proj, ".agents", "feedback"), "proj_rule", 4)
			require.NoError(t, os.Symlink(filepath.Join(proj, ".agents"), filepath.Join(proj, ".claude")))
			for _, configDirNames := range [][]string{ClaudeConfigDirs, codexDirsForTest} {
				rules, err := ListRules(MakeIo(IoOpts{ProjectDir: proj, Env: EnvVars{Home: home}, ConfigDirNames: configDirNames}))
				require.NoError(t, err)
				type nameCount struct {
					name  string
					count int
				}
				got := []nameCount{}
				for _, r := range rules {
					got = append(got, nameCount{r.Name, r.Count})
				}
				assert.Equal(t, []nameCount{{"shared", 3}, {"proj_rule", 4}}, got)
			}
		})
	})

	t.Run("CLAUDE_FEEDBACK_DIR replaces the home candidates entirely", func(t *testing.T) {
		withDirs(func(proj, home string) {
			io := MakeIo(IoOpts{ProjectDir: proj, Env: EnvVars{Home: home, ClaudeFeedbackDir: "/override"}})
			assert.Equal(t, []string{"/override"}, FeedbackDirs(io))
			assert.Equal(t, "/override", FeedbackDir(io))
		})
	})
}
