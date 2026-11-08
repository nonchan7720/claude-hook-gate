package hookgate

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func nrtRule(name, description string, count int) string {
	return "---\nname: " + name + "\ndescription: " + description + "\ntype: feedback\ncount: " + strconv.Itoa(count) + "\n---\n\n本文\n"
}

func TestFeedbackNewRule(t *testing.T) {
	setup := func(t *testing.T) (string, string) {
		t.Helper()
		fb, proj := t.TempDir(), t.TempDir()
		fbtWrite(filepath.Join(fb, "test_mocking.md"), nrtRule("test_mocking", "Do not mock the database in integration tests", 3))
		fbtWrite(filepath.Join(fb, "commit_style.md"), nrtRule("commit_style", "Write commit messages in English", 1))
		return fb, proj
	}
	run := func(fb, proj string, payload Dict, lang ...Lang) ScriptResult {
		opts := IoOpts{ProjectDir: proj, Cwd: proj, Env: EnvVars{ClaudeFeedbackDir: fb}}
		if len(lang) > 0 {
			opts.Lang = lang[0]
		}
		return FeedbackGuard(MakeIo(opts), payload)
	}
	write := func(file, content string, session ...string) Dict {
		sid := "sess-new-rule"
		if len(session) > 0 {
			sid = session[0]
		}
		return Dict{"session_id": sid, "tool_name": "Write", "tool_input": Dict{"file_path": file, "content": content}}
	}
	decision := func(t *testing.T, stdout string) Dict {
		t.Helper()
		return fbtParseJSON(t, stdout)["hookSpecificOutput"].(Dict)
	}

	t.Run("denies the first creation of a new rule file and lists existing rules, similar first", func(t *testing.T) {
		fb, proj := setup(t)
		hs := decision(t, run(fb, proj, write(filepath.Join(fb, "mock_tests.md"), nrtRule("mock_tests", "Avoid mocks in tests", 1))).Stdout)
		assert.Equal(t, "deny", hs["permissionDecision"])
		reason := Str(hs["permissionDecisionReason"])
		assert.Contains(t, reason, "mock_tests.md")
		assert.Contains(t, reason, "★ test_mocking (count: 3")
		assert.Contains(t, reason, "- commit_style (count: 1")
		assert.Less(t, strings.Index(reason, "test_mocking"), strings.Index(reason, "commit_style"))
		assert.Contains(t, reason, "count を 1 上げ")
		assert.Contains(t, reason, "似ているもの 1 件")
		assert.NotContains(t, reason, "newRule.")
	})

	t.Run("the same write passes the second time in the session", func(t *testing.T) {
		fb, proj := setup(t)
		payload := write(filepath.Join(fb, "new_topic.md"), nrtRule("new_topic", "Something else", 1))
		assert.Equal(t, "deny", decision(t, run(fb, proj, payload).Stdout)["permissionDecision"])
		assert.Empty(t, strings.TrimSpace(run(fb, proj, payload).Stdout))
	})

	t.Run("a new rule file in the project feedback dir is checked too", func(t *testing.T) {
		fb, proj := setup(t)
		dir := filepath.Join(proj, ".claude", "feedback")
		require.NoError(t, os.MkdirAll(dir, 0o755))
		hs := decision(t, run(fb, proj, write(filepath.Join(dir, "commit_language.md"), nrtRule("commit_language", "commit messages", 1))).Stdout)
		assert.Contains(t, Str(hs["permissionDecisionReason"]), "★ commit_style")
	})

	t.Run("updating an existing rule file is not stopped", func(t *testing.T) {
		fb, proj := setup(t)
		r := run(fb, proj, write(filepath.Join(fb, "test_mocking.md"), nrtRule("test_mocking", "Do not mock", 4)))
		assert.Empty(t, strings.TrimSpace(r.Stdout))
	})

	t.Run("not stopped without existing rules, without a session id, or outside the feedback dirs", func(t *testing.T) {
		fb, proj := setup(t)
		empty := t.TempDir()
		assert.Empty(t, strings.TrimSpace(run(empty, proj, write(filepath.Join(empty, "first.md"), nrtRule("first", "x", 1))).Stdout))
		noSession := Dict{"tool_name": "Write", "tool_input": Dict{"file_path": filepath.Join(fb, "other.md"), "content": nrtRule("other", "x", 1)}}
		assert.Empty(t, strings.TrimSpace(run(fb, proj, noSession).Stdout))
		assert.Empty(t, strings.TrimSpace(run(fb, proj, write(filepath.Join(proj, "README.md"), "# readme")).Stdout))
		assert.Empty(t, strings.TrimSpace(run(fb, proj, write(filepath.Join(fb, "sub", "nested.md"), nrtRule("nested", "x", 1))).Stdout))
	})

	t.Run("a heredoc that creates a rule file is checked like Write", func(t *testing.T) {
		fb, proj := setup(t)
		file := filepath.Join(fb, "mocking_policy.md")
		command := "cat > " + file + " <<'EOF'\n" + nrtRule("mocking_policy", "mocking in tests", 1) + "EOF\n"
		r := run(fb, proj, Dict{"session_id": "sess-new-rule-heredoc", "tool_name": "Bash", "tool_input": Dict{"command": command}, "cwd": proj})
		hs := decision(t, r.Stdout)
		assert.Equal(t, "deny", hs["permissionDecision"])
		assert.Contains(t, Str(hs["permissionDecisionReason"]), "★ test_mocking")
	})

	t.Run("english messages", func(t *testing.T) {
		fb, proj := setup(t)
		r := run(fb, proj, write(filepath.Join(fb, "zzz.md"), nrtRule("zzz", "unrelated", 1), "sess-new-rule-en"), LangEN)
		reason := Str(decision(t, r.Stdout)["permissionDecisionReason"])
		assert.Contains(t, reason, "check the existing rules")
		assert.Contains(t, reason, "raise its count by 1")
	})
}

func TestSimilarity(t *testing.T) {
	assert.GreaterOrEqual(t, SimilarityScore(SimilarityTokens("test_mocking"), SimilarityTokens("mock tests")), 2)
	assert.Equal(t, 0, SimilarityScore(SimilarityTokens("commit_style"), SimilarityTokens("tsconfig rootdir")))
	assert.GreaterOrEqual(t, SimilarityScore(SimilarityTokens("テストでモックを使わない"), SimilarityTokens("モックを避ける")), 2)
}
