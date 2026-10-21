package hookgate

// tests/feedback-inject.spec.ts の移植。

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func fbtRunInject(feedbackDir string, lang ...Lang) ScriptResult {
	opts := IoOpts{ProjectDir: feedbackDir, Env: EnvVars{ClaudeFeedbackDir: feedbackDir}}
	if len(lang) > 0 {
		opts.Lang = lang[0]
	}
	return FeedbackInject(MakeIo(opts))
}

func fbtInjectRule(dir, name string, count int, description, extra string) {
	content := fmt.Sprintf("---\nname: %s\ndescription: %s\ntype: feedback\ncount: %d\n%s---\n\n%s の本文の第一段落。ここが注入される。\n\n**Why:** 理由の説明。\n", name, description, count, extra, name)
	fbtWrite(filepath.Join(dir, name+".md"), content)
}

func TestFeedbackInject(t *testing.T) {
	t.Run("only count >= 3 is included", func(t *testing.T) {
		WithTmp(func(tmp string) {
			fbtInjectRule(tmp, "high", 5, "desc", "")
			fbtInjectRule(tmp, "low", 1, "desc", "")
			r := fbtRunInject(tmp)
			assert.Equal(t, 0, r.ExitCode)
			assert.Contains(t, r.Stdout, "high")
			assert.NotContains(t, r.Stdout, "low")
		})
	})

	t.Run("the header and the rule titles follow the language", func(t *testing.T) {
		WithTmp(func(tmp string) {
			fbtInjectRule(tmp, "high", 5, "desc", "")
			ja := fbtRunInject(tmp, LangJA)
			assert.True(t, strings.HasPrefix(ja.Stdout, "# 確定フィードバックルール（count >= 3）\n"))
			assert.Contains(t, ja.Stdout, "■ high (これまで 5 回指摘されています)")
			en := fbtRunInject(tmp, LangEN)
			assert.True(t, strings.HasPrefix(en.Stdout,
				"# Confirmed feedback rules (count >= 3)\nThese rules were pointed out repeatedly and are confirmed. A hook blocks violations.\n\n"))
			assert.Contains(t, en.Stdout, "■ high (pointed out 5 times so far)")
			assert.Contains(t, en.Stdout, "high の本文の第一段落")
		})
	})

	t.Run("sorted by count desc then name asc", func(t *testing.T) {
		WithTmp(func(tmp string) {
			fbtInjectRule(tmp, "bbb", 3, "desc", "")
			fbtInjectRule(tmp, "aaa", 3, "desc", "")
			fbtInjectRule(tmp, "zzz", 6, "desc", "")
			r := fbtRunInject(tmp)
			posZzz := strings.Index(r.Stdout, "zzz")
			posAaa := strings.Index(r.Stdout, "aaa")
			posBbb := strings.Index(r.Stdout, "bbb")
			assert.GreaterOrEqual(t, posZzz, 0)
			assert.Less(t, posZzz, posAaa)
			assert.Less(t, posAaa, posBbb)
		})
	})

	t.Run("all rules output in full even over 3000 chars", func(t *testing.T) {
		WithTmp(func(tmp string) {
			for i := 0; i < 80; i++ {
				fbtInjectRule(tmp, fmt.Sprintf("rule_%03d", i), 3, strings.Repeat("あ", 80), "")
			}
			r := fbtRunInject(tmp)
			assert.Greater(t, len([]rune(r.Stdout)), 3000)
			for i := 0; i < 80; i++ {
				name := fmt.Sprintf("rule_%03d", i)
				assert.Contains(t, r.Stdout, name)
				assert.Contains(t, r.Stdout, strings.Repeat("あ", 80))
				assert.Contains(t, r.Stdout, name+" の本文の第一段落。ここが注入される。")
			}
		})
	})

	t.Run("no rules produces no output", func(t *testing.T) {
		WithTmp(func(tmp string) {
			fbtInjectRule(tmp, "low", 1, "desc", "")
			r := fbtRunInject(tmp)
			assert.Equal(t, 0, r.ExitCode)
			assert.Equal(t, "", strings.TrimSpace(r.Stdout))
		})
	})

	t.Run("injects count >= 3 rules from the project .claude/feedback directory", func(t *testing.T) {
		WithTmp(func(tmp string) {
			globalDir := filepath.Join(tmp, "global")
			projectDir := filepath.Join(tmp, "project")
			projectFeedback := filepath.Join(projectDir, ".claude", "feedback")
			require.NoError(t, os.MkdirAll(globalDir, 0o755))
			require.NoError(t, os.MkdirAll(projectFeedback, 0o755))
			fbtInjectRule(projectFeedback, "proj_high", 4, "desc", "")
			fbtInjectRule(projectFeedback, "proj_low", 1, "desc", "")
			r := FeedbackInject(MakeIo(IoOpts{ProjectDir: projectDir, Env: EnvVars{ClaudeFeedbackDir: globalDir}}))
			assert.Equal(t, 0, r.ExitCode)
			assert.Contains(t, r.Stdout, "proj_high")
			assert.NotContains(t, r.Stdout, "proj_low")
		})
	})

	t.Run("expired rules are not injected", func(t *testing.T) {
		WithTmp(func(tmp string) {
			fbtInjectRule(tmp, "fresh", 4, "desc", "expires: 2999-12-31\n")
			fbtInjectRule(tmp, "stale", 4, "desc", "expires: 2020-01-01\n")
			r := fbtRunInject(tmp)
			assert.Contains(t, r.Stdout, "fresh")
			assert.NotContains(t, r.Stdout, "stale")
		})
	})

	t.Run("never fails hard when the feedback directory does not exist", func(t *testing.T) {
		r := fbtRunInject("/no/such/feedback/dir")
		assert.Equal(t, 0, r.ExitCode)
		assert.Equal(t, "", r.Stdout)
	})
}
