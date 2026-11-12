package hookgate

// tests/stop-review.spec.ts の移植。

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseStopReview(t *testing.T) {
	_, ok := ParseStopReview(nil)
	assert.False(t, ok)
	_, ok = ParseStopReview(false)
	assert.False(t, ok)
	_, ok = ParseStopReview(Dict{"enabled": false})
	assert.False(t, ok)

	cfg, ok := ParseStopReview(true)
	assert.True(t, ok)
	assert.Equal(t, StopReviewConfig{Effort: "xhigh", Match: []string{}, MaxRounds: 1, Subagents: true}, cfg)

	cfg, _ = ParseStopReview(Dict{"effort": "max", "match": "src/**", "max_rounds": 2, "prompt": " 追加の指示 \n", "subagents": false})
	assert.Equal(t, StopReviewConfig{Effort: "max", Match: []string{"src/**"}, MaxRounds: 2, Prompt: "追加の指示", Subagents: false}, cfg)

	cfg, _ = ParseStopReview(Dict{"effort": "ultra", "max_rounds": 0})
	assert.Equal(t, "xhigh", cfg.Effort)
	assert.Equal(t, 1, cfg.MaxRounds)

	cfg, _ = ParseStopReview(Dict{"effort": false})
	assert.Equal(t, "", cfg.Effort)
}

func TestStopReview(t *testing.T) {
	ioOf := func(proj string) Io { return MakeIo(IoOpts{ProjectDir: proj, Lang: "ja"}) }
	run := func(proj string, payload Dict) ScriptResult {
		p := Dict{"session_id": "sess1"}
		for k, v := range payload {
			p[k] = v
		}
		return StopReview(ioOf(proj), p)
	}
	note := func(proj, stateID string, rels ...string) {
		paths := make([]string, len(rels))
		for i, r := range rels {
			paths[i] = filepath.Join(proj, r)
		}
		NotePendingReview(ioOf(proj), stateID, paths)
	}
	reasonOf := func(stdout string) string {
		var v struct{ Reason string }
		lines := strings.Split(strings.TrimSpace(stdout), "\n")
		must(jsonUnmarshal(lines[len(lines)-1], &v))
		return v.Reason
	}

	t.Run("gate.yaml が無い・stop_review が無いときは何もしない（控えは消す）", func(t *testing.T) {
		WithTmp(func(proj string) {
			assert.Equal(t, 0, run(proj, nil).ExitCode)
			WriteGateYaml(proj, Dict{"rules": []any{}})
			note(proj, "sess1", "a.ts")
			r := run(proj, nil)
			assert.Equal(t, 0, r.ExitCode)
			assert.Equal(t, "", r.Stdout)
			assert.False(t, Exists(ReviewPendingPath(ioOf(proj), "sess1")))
		})
	})

	t.Run("変更があれば 1 回ブロックし、effort のスキルと変更ファイルを reason に入れる。次の Stop は通す", func(t *testing.T) {
		WithTmp(func(proj string) {
			WriteGateYaml(proj, Dict{"stop_review": Dict{"effort": "high", "prompt": "マイグレーションも確認"}})
			assert.Equal(t, 0, run(proj, nil).ExitCode)
			note(proj, "sess1", "src/a.ts", "README.md")
			r := run(proj, nil)
			assert.Equal(t, 2, r.ExitCode)
			reason := reasonOf(r.Stdout)
			assert.Contains(t, reason, "[stop-review]")
			assert.Contains(t, reason, "1/1")
			assert.Contains(t, reason, "feedback-gate:effort-high")
			assert.Contains(t, reason, "- src/a.ts")
			assert.Contains(t, reason, "- README.md")
			assert.True(t, strings.HasSuffix(reason, "マイグレーションも確認"))

			again := run(proj, Dict{"stop_hook_active": true})
			assert.Equal(t, 0, again.ExitCode)
			assert.True(t, again.ReportConsumed)
			assert.False(t, Exists(ReviewRoundsPath(ioOf(proj), "sess1")))
			assert.False(t, run(proj, Dict{"stop_hook_active": true}).ReportConsumed)
		})
	})

	t.Run("見直し中の修正は max_rounds 回まで再度見直させる", func(t *testing.T) {
		WithTmp(func(proj string) {
			WriteGateYaml(proj, Dict{"stop_review": Dict{"max_rounds": 2}})
			note(proj, "sess1", "a.ts")
			assert.Equal(t, 2, run(proj, nil).ExitCode)
			note(proj, "sess1", "b.ts")
			second := run(proj, Dict{"stop_hook_active": true})
			assert.Equal(t, 2, second.ExitCode)
			assert.Contains(t, reasonOf(second.Stdout), "2/2")
			assert.NotContains(t, reasonOf(second.Stdout), "- a.ts")
			note(proj, "sess1", "c.ts")
			assert.Equal(t, 0, run(proj, Dict{"stop_hook_active": true}).ExitCode)
			note(proj, "sess1", "d.ts")
			assert.Equal(t, 2, run(proj, nil).ExitCode)
		})
	})

	t.Run("中断などで回数が残っていても、新しいターンの Stop（stop_hook_active でない）は 1 回目から見直す", func(t *testing.T) {
		WithTmp(func(proj string) {
			WriteGateYaml(proj, Dict{"stop_review": true})
			note(proj, "sess1", "a.ts")
			assert.Equal(t, 2, run(proj, nil).ExitCode)
			note(proj, "sess1", "b.ts")
			next := run(proj, nil)
			assert.Equal(t, 2, next.ExitCode)
			assert.Contains(t, reasonOf(next.Stdout), "1/1")
			note(proj, "sess1", "c.ts")
			assert.Equal(t, 0, run(proj, Dict{"stop_hook_active": true}).ExitCode)
		})
	})

	t.Run("match に合う変更だけを対象にする", func(t *testing.T) {
		WithTmp(func(proj string) {
			WriteGateYaml(proj, Dict{"stop_review": Dict{"match": []any{"src/**/*.ts"}}})
			note(proj, "sess1", "README.md")
			assert.Equal(t, 0, run(proj, nil).ExitCode)
			note(proj, "sess1", "README.md", "src/x/a.ts")
			r := run(proj, nil)
			assert.Equal(t, 2, r.ExitCode)
			assert.Contains(t, reasonOf(r.Stdout), "- src/x/a.ts")
			assert.NotContains(t, reasonOf(r.Stdout), "README.md")
		})
	})

	t.Run("effort: false ならスキルの手順を出さない。英語の文面", func(t *testing.T) {
		WithTmp(func(proj string) {
			WriteGateYaml(proj, Dict{"stop_review": Dict{"effort": false}})
			note(proj, "sess1", "a.ts")
			r := StopReview(MakeIo(IoOpts{ProjectDir: proj, Lang: "en"}), Dict{"session_id": "sess1"})
			reason := reasonOf(r.Stdout)
			assert.Contains(t, reason, "Before you stop")
			assert.NotContains(t, reason, "feedback-gate:effort-")
		})
	})

	t.Run("サブエージェントは自分の控えだけを見る。subagents: false なら行わない", func(t *testing.T) {
		WithTmp(func(proj string) {
			WriteGateYaml(proj, Dict{"stop_review": true})
			note(proj, "sess1--ag1", "a.ts")
			assert.Equal(t, 0, run(proj, nil).ExitCode)
			assert.Equal(t, 2, run(proj, Dict{"agent_id": "ag1"}).ExitCode)

			WriteGateYaml(proj, Dict{"stop_review": Dict{"subagents": false}})
			note(proj, "sess1--ag1", "a.ts")
			assert.Equal(t, 0, run(proj, Dict{"agent_id": "ag1"}).ExitCode)
		})
	})

	t.Run("変更ファイルが多いときは 30 件で切る", func(t *testing.T) {
		WithTmp(func(proj string) {
			WriteGateYaml(proj, Dict{"stop_review": true})
			rels := make([]string, 33)
			for i := range rels {
				rels[i] = fmt.Sprintf("f%d.ts", i)
			}
			note(proj, "sess1", rels...)
			reason := reasonOf(run(proj, nil).Stdout)
			assert.Len(t, regexp.MustCompile(`(?m)^- f\d+\.ts$`).FindAllString(reason, -1), 30)
			assert.Contains(t, reason, "3")
		})
	})

	t.Run("RecordChanges が控えに足し、AllStop / SubagentStop が見直しでブロックする", func(t *testing.T) {
		WithTmp(func(proj string) {
			WriteGateYaml(proj, Dict{"stop_review": true})
			file := filepath.Join(proj, "a.ts")
			writeText(file, "")
			RecordChanges(ioOf(proj), Dict{"session_id": "sess1", "tool_input": Dict{"file_path": file}})
			r := AllStop(ioOf(proj), Dict{"session_id": "sess1"})
			assert.Equal(t, 2, r.ExitCode)
			assert.Contains(t, reasonOf(r.Stdout), "- a.ts")
			assert.Equal(t, 0, AllStop(ioOf(proj), Dict{"session_id": "sess1", "stop_hook_active": true}).ExitCode)

			RecordChanges(ioOf(proj), Dict{"session_id": "sess1", "agent_id": "ag1", "tool_input": Dict{"file_path": file}})
			sub := SubagentStop(ioOf(proj), "sess1", Dict{"session_id": "sess1", "agent_id": "ag1"})
			if assert.NotNil(t, sub.Outcome.Block) {
				assert.Contains(t, *sub.Outcome.Block, "[stop-review]")
			}
		})
	})

	t.Run("SessionStart(startup) で控えを消す", func(t *testing.T) {
		WithTmp(func(proj string) {
			WriteGateYaml(proj, Dict{"stop_review": true})
			note(proj, "sess1", "a.ts")
			note(proj, "sess1--ag1", "a.ts")
			ResetGate(ioOf(proj), Dict{"session_id": "sess1", "source": "startup"})
			assert.False(t, Exists(ReviewPendingPath(ioOf(proj), "sess1")))
			assert.False(t, Exists(ReviewPendingPath(ioOf(proj), "sess1--ag1")))
		})
	})
}
