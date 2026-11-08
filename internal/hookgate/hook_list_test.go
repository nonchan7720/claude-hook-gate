package hookgate

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/nonchan7720/claude-hook-gate/webui"
)

func TestHookListTemplateHasOnePlaceholder(t *testing.T) {
	assert.Equal(t, 1, strings.Count(webui.HookListHTML, "__HOOK_LIST_DATA__"))
	assert.Equal(t, 1, strings.Count(webui.HookListHTML, `"__HOOK_LIST_DATA__"`))
}

func TestHookListRunNodes(t *testing.T) {
	items := []any{
		"bun run lint",
		Dict{"parallel": []any{Dict{"name": "tc", "cmd": "tsc"}, Dict{"cmd": "bun test", "share": false, "files": false, "timeout": 60}}},
		Dict{"name": "no-cmd"},
	}
	assert.Equal(t, []HookListRunNode{
		{Cmd: "bun run lint", Notes: []string{}},
		{Parallel: []HookListRunNode{
			{Cmd: "tsc", Name: "tc", Notes: []string{}},
			{Cmd: "bun test", Notes: []string{"timeout 60s", "share: false", "files: false"}},
		}},
	}, HookListRunNodes(items))
}

func TestHookListGateModel(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		g := HookListGateModel(nil, "", "")
		assert.Nil(t, g.Path)
		assert.Empty(t, g.Rules)
	})
	t.Run("unreadable", func(t *testing.T) {
		g := HookListGateModel(nil, "/p/.claude/gate.yaml", "bad indent")
		require.NotNil(t, g.Error)
		assert.Equal(t, "bad indent", *g.Error)
	})
	t.Run("phases", func(t *testing.T) {
		cfg := Dict{
			"max_parallel": 3,
			"rules": []any{Dict{
				"match": "src/**/*.ts", "per_file_dir": "pattern_root", "timeout": 120,
				"run": []any{"bun run lint"}, "run_checks": []any{"build"},
			}},
			"consistency_checks": []any{Dict{"name": "build", "run": []any{"make"}}, Dict{"name": "orphan", "dir": "pkg", "run": []any{"x"}}},
			"session_start": []any{
				"echo hi",
				Dict{"name": "graph", "cmd": "graph", "on": []any{"startup", "clear"}, "background": true},
				Dict{"cmd": "unquoted", "true": "resume"}, // YAML 1.1 で引用しない on: が読まれた形
			},
		}
		g := HookListGateModel(cfg, "/p/.claude/gate.yaml", "")
		require.NotNil(t, g.Path)
		assert.Nil(t, g.Error)
		assert.Equal(t, []HookListGateRule{{
			Match:     []string{"src/**/*.ts"},
			Options:   []HookListPair{{"per_file_dir", "pattern_root"}, {"timeout", "120s"}},
			Run:       []HookListRunNode{{Cmd: "bun run lint", Notes: []string{}}},
			RunChecks: []string{"build"},
		}}, g.Rules)
		assert.Equal(t, []HookListGateCheck{
			{Name: "build", Referenced: true, Options: []HookListPair{}, Run: []HookListRunNode{{Cmd: "make", Notes: []string{}}}},
			{Name: "orphan", Referenced: false, Options: []HookListPair{{"dir", "pkg"}}, Run: []HookListRunNode{{Cmd: "x", Notes: []string{}}}},
		}, g.Checks)
		assert.Equal(t, []HookListRunNode{
			{Cmd: "echo hi", Notes: []string{}},
			{Cmd: "graph", Name: "graph", Notes: []string{"on: startup, clear", "background"}},
			{Cmd: "unquoted", Notes: []string{"on: resume"}},
		}, g.SessionStart)
		assert.Equal(t, []HookListPair{{"max_parallel", "3"}}, g.Settings)
	})
}

func TestHookListRuleModel(t *testing.T) {
	dirs := []string{"/p/.claude/feedback", "/p/.agents/feedback"}
	rule := Rule{
		Name: "go_errors", Count: 3, Path: "/p/.claude/feedback/go_errors.md",
		Files: []string{"**/*.go"}, ExcludeFiles: []string{"**/*_test.go"},
		Enforce: []Dict{
			{"event": "post_edit", "path": []any{"**/*.go"}, "when": "return err$", "message": "wrap"},
			{"event": "stop_check", "changed": "**/*.go", "check": "gofmt -l $FILE", "severity": "warn"},
		},
	}
	assert.Equal(t, HookListRule{
		Name: "go_errors", Scope: "project", Count: 3, Level: "confirmed",
		Inject: HookListInject{Kind: "files", Files: []string{"**/*.go"}, Exclude: []string{"**/*_test.go"}},
		Enforce: []HookListEnforce{
			{Event: "post_edit", Severity: "block", Fields: []HookListPair{{"path", "**/*.go"}, {"when", "return err$"}, {"message", "wrap"}}},
			{Event: "stop_check", Severity: "warn", Fields: []HookListPair{{"changed", "**/*.go"}, {"check", "gofmt -l $FILE"}}},
		},
		Path: "/p/.claude/feedback/go_errors.md",
	}, HookListRuleModel(rule, dirs))

	global := HookListRuleModel(Rule{Name: "x", Count: 1, Path: "/h/.claude/feedback/x.md"}, dirs)
	assert.Equal(t, "global", global.Scope)
	assert.Equal(t, "provisional", global.Level)
	assert.Equal(t, "none", global.Inject.Kind)
	assert.Equal(t, "deny", HookListRuleModel(Rule{Name: "y", Count: 5}, dirs).Level)
	assert.Equal(t, "prompt", HookListRuleModel(Rule{Name: "y", Count: 5}, dirs).Inject.Kind)
}

func TestHookListInactiveReason(t *testing.T) {
	exp := int64(1767311999000) // 2026-01-01T23:59:59Z
	assert.Equal(t, "expires（2026-01-01）を過ぎている", HookListInactiveReason(Rule{Expires: &exp}, exp+1, LangJA))
	assert.Equal(t, "projects がこのプロジェクトに一致せず無効", HookListInactiveReason(Rule{Projects: []string{"~/x/**"}}, 0, LangJA))
	assert.Equal(t, "projects / when_exists do not match this project, so the rule is inactive",
		HookListInactiveReason(Rule{Projects: []string{"a"}, WhenExists: []string{"b"}}, 0, LangEN))
}

func TestHookListLabels(t *testing.T) {
	ja, en := HookListLabels(LangJA), HookListLabels(LangEN)
	keys := func(m map[string]string) []string {
		out := []string{}
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	assert.Equal(t, keys(ja), keys(en))
	assert.Equal(t, "Bash の実行前にコマンド文字列を検査", ja["event.pre_bash"])
	assert.Equal(t, "on", en["on"])
}

var hookListDataRe = regexp.MustCompile(`<script id="hook-list-data" type="application/json">([\s\S]*?)</script>`)

func TestHookListMain(t *testing.T) {
	proj, home, feedback := TmpDir(), TmpDir(), TmpDir()
	defer RmTree(proj)
	defer RmTree(home)
	defer RmTree(feedback)
	WriteGateYaml(proj, Dict{"rules": []any{Dict{"match": "**/*.py", "run": []any{"echo </script><b>"}}}})
	writeText(filepath.Join(feedback, "no_force.md"), "---\nname: no_force\ndescription: d\ntype: feedback\ncount: 5\nenforce:\n  - event: pre_bash\n    when: 'push --force'\n---\n\nbody\n")
	writeText(filepath.Join(feedback, "old.md"), "---\nname: old\ndescription: d\ntype: feedback\ncount: 3\nexpires: 2020-01-01\n---\n\nbody\n")
	env := map[string]string{
		"HOME": home, "CLAUDE_FEEDBACK_DIR": feedback, "CLAUDE_PROJECT_DIR": proj, "PATH": os.Getenv("PATH"),
		"CLAUDE_PLUGIN_OPTION_language": "en", "CLAUDE_PLUGIN_OPTION_agentLaunchGuard": "true",
	}
	var stdout, stderr bytes.Buffer
	code := HookListMain(ClaudeHost, []string{"--no-open"}, env, proj, &stdout, &stderr)
	require.Equal(t, 0, code, stderr.String())
	slug := strings.Trim(regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(proj, "-"), "-")
	file := filepath.Join(home, ".claude", "feedback-gate", "hook-list", slug+".html")
	assert.Equal(t, "[hook-list] Wrote the list. Open it in a browser: "+file+"\n", stdout.String())

	html := Read(file)
	// コマンドの中の </script> がデータの script 要素を閉じない。
	assert.NotContains(t, html, "echo </script>")
	m := hookListDataRe.FindStringSubmatch(html)
	require.NotNil(t, m)
	var model HookListModel
	require.NoError(t, json.Unmarshal([]byte(m[1]), &model))
	assert.Equal(t, proj, model.Project)
	assert.Equal(t, "en", model.Lang)
	assert.Equal(t, "echo </script><b>", model.Gate.Rules[0].Run[0].Cmd)
	require.Len(t, model.Feedback.Rules, 1)
	assert.Equal(t, "no_force", model.Feedback.Rules[0].Name)
	assert.Equal(t, []HookListEnforce{{Event: "pre_bash", Severity: "deny", Fields: []HookListPair{{"when", "push --force"}}}}, model.Feedback.Rules[0].Enforce)
	assert.Equal(t, []HookListInactive{{Name: "old", Reason: "expires (2020-01-01) has passed", Path: filepath.Join(feedback, "old.md")}}, model.Feedback.Inactive)
	assert.Equal(t, HookListOptions{AgentLaunchGuard: true, AutoCount: true, Language: "en"}, model.Options)
}

func TestHookListOpenInBrowser(t *testing.T) {
	var runs [][]string
	io := &recordingRunIo{Io: MakeIo(IoOpts{ProjectDir: TmpDir()}), runs: &runs}
	// PATH に xdg-open も wslview も無ければ何も起動せず false。
	io.path = ""
	assert.False(t, hlOpenInBrowser(io, "linux", "/x.html"))
	assert.Empty(t, runs)

	// wslview だけがあればそれで開く。
	bin := TmpDir()
	defer RmTree(bin)
	writeText(filepath.Join(bin, "wslview"), "#!/bin/sh\n")
	require.NoError(t, os.Chmod(filepath.Join(bin, "wslview"), 0o755))
	io.path = bin
	assert.True(t, hlOpenInBrowser(io, "linux", "/x.html"))
	assert.Equal(t, [][]string{{"wslview", "/x.html"}}, runs)

	// macOS は open。
	runs = nil
	writeText(filepath.Join(bin, "open"), "#!/bin/sh\n")
	require.NoError(t, os.Chmod(filepath.Join(bin, "open"), 0o755))
	assert.True(t, hlOpenInBrowser(io, "darwin", "/x.html"))
	assert.Equal(t, [][]string{{"open", "/x.html"}}, runs)
}

// recordingRunIo は Run を記録するだけ（実際には何も起動しない）。PATH を差し替える。
type recordingRunIo struct {
	Io
	runs *[][]string
	path string
}

func (r *recordingRunIo) Env() EnvVars {
	env := r.Io.Env()
	env.Path = r.path
	return env
}

func (r *recordingRunIo) Run(argv []string, _ RunOptions) RunResult {
	*r.runs = append(*r.runs, argv)
	return RunResult{}
}
