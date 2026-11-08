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
	"time"

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
			}, Dict{
				// gate は文字列の run_checks を受け付けない（gateListOf）ので、参照として数えない。
				"match": "a", "run": []any{"b"}, "run_checks": "strref",
			}},
			"consistency_checks": []any{
				Dict{"name": "build", "run": []any{"make"}},
				Dict{"name": "orphan", "dir": "pkg", "run": []any{"x"}},
				Dict{"name": "strref", "run": []any{"y"}},
			},
			"session_start": []any{
				"echo hi",
				Dict{"name": "graph", "cmd": "graph", "on": []any{"startup", "clear"}, "background": true},
				Dict{"cmd": "unquoted", "true": "resume", "timeout": 3}, // YAML 1.1 で引用しない on: が読まれた形
				Dict{"name": "no-cmd", "timeout": 5},                    // gate が捨てる要素は出さない
				42,
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
		}, {
			Match:     []string{"a"},
			Options:   []HookListPair{},
			Run:       []HookListRunNode{{Cmd: "b", Notes: []string{}}},
			RunChecks: []string{},
		}}, g.Rules)
		assert.Equal(t, []HookListGateCheck{
			{Name: "build", Referenced: true, Options: []HookListPair{}, Run: []HookListRunNode{{Cmd: "make", Notes: []string{}}}},
			{Name: "orphan", Referenced: false, Options: []HookListPair{{"dir", "pkg"}}, Run: []HookListRunNode{{Cmd: "x", Notes: []string{}}}},
			{Name: "strref", Referenced: false, Options: []HookListPair{}, Run: []HookListRunNode{{Cmd: "y", Notes: []string{}}}},
		}, g.Checks)
		// session_start は gate と同じ parseSessionStartItem で読む（既定の名前・timeout も gate と同じ）。
		assert.Equal(t, []HookListRunNode{
			{Cmd: "echo hi", Name: Slug("echo hi"), Notes: []string{"timeout 10s"}},
			{Cmd: "graph", Name: "graph", Notes: []string{"on: startup, clear", "background", "timeout 10s"}},
			{Cmd: "unquoted", Name: Slug("unquoted"), Notes: []string{"on: resume", "timeout 3s"}},
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
	file := HookListPath(MakeOsIo(OsIoInit{Environ: env, PayloadCwd: proj}), proj)
	assert.Equal(t, "[hook-list] Wrote the list. Open it in a browser: "+file+"\n", stdout.String())
	// 一覧を出すだけなので、エラーのログ（.errors.jsonl）には何も書かない。
	assert.NoFileExists(t, filepath.Join(feedback, ".errors.jsonl"))

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
	saved := hlStartOpener
	defer func() { hlStartOpener = saved }()
	hlStartOpener = func(argv []string) bool {
		runs = append(runs, argv)
		return true
	}
	io := &pathIo{Io: MakeIo(IoOpts{ProjectDir: TmpDir()})}
	// PATH に xdg-open も wslview も無ければ何も起動せず false。
	assert.False(t, hlOpenInBrowser(io, "linux", "/x.html"))
	assert.Empty(t, runs)

	// wslview だけがあればそれで開く。
	bin := TmpDir()
	defer RmTree(bin)
	for _, name := range []string{"wslview", "open"} {
		writeText(filepath.Join(bin, name), "#!/bin/sh\n")
		require.NoError(t, os.Chmod(filepath.Join(bin, name), 0o755))
	}
	io.path = bin
	assert.True(t, hlOpenInBrowser(io, "linux", "/x.html"))
	assert.Equal(t, [][]string{{filepath.Join(bin, "wslview"), "/x.html"}}, runs)

	// macOS は open。
	runs = nil
	assert.True(t, hlOpenInBrowser(io, "darwin", "/x.html"))
	assert.Equal(t, [][]string{{filepath.Join(bin, "open"), "/x.html"}}, runs)
}

func TestHookListStartOpener(t *testing.T) {
	bin := TmpDir()
	defer RmTree(bin)
	script := func(name, body string) string {
		p := filepath.Join(bin, name)
		writeText(p, "#!/bin/sh\n"+body+"\n")
		require.NoError(t, os.Chmod(p, 0o755))
		return p
	}
	assert.True(t, hlStartOpener([]string{script("ok", "exit 0")}))
	assert.False(t, hlStartOpener([]string{script("ng", "exit 3")}))
	assert.False(t, hlStartOpener([]string{filepath.Join(bin, "missing")}))
	// ブラウザを前面で起動して待つ xdg-open のように終わらないものは、待ちきったら開けたとみなし、止めない。
	marker := filepath.Join(bin, "still-running")
	start := time.Now()
	assert.True(t, hlStartOpener([]string{script("slow", "sleep 7; touch "+marker)}))
	assert.GreaterOrEqual(t, time.Since(start), hlOpenWait)
	require.Eventually(t, func() bool { return Exists(marker) }, 5*time.Second, 100*time.Millisecond, "the opener must not be killed")
}

func TestHookListPath(t *testing.T) {
	io := MakeIo(IoOpts{ProjectDir: TmpDir()})
	a, b := HookListPath(io, "/work/my app"), HookListPath(io, "/work/my-app")
	assert.NotEqual(t, a, b, "paths that read the same must not share a file")
	assert.Regexp(t, `/work-my-app-[0-9a-f]{10}\.html$`, a)
	assert.Equal(t, a, HookListPath(io, "/work/my app"))
	long := "/" + strings.Repeat("very-long-directory-name/", 20) + "project"
	assert.Less(t, len(filepath.Base(HookListPath(io, long))), 120)
	// 末尾（プロジェクト名の側）を残す。
	assert.Regexp(t, `-project-[0-9a-f]{10}\.html$`, HookListPath(io, long))
}

func TestHookListScanFeedback(t *testing.T) {
	proj, home, feedback := TmpDir(), TmpDir(), TmpDir()
	defer RmTree(proj)
	defer RmTree(home)
	defer RmTree(feedback)
	rule := func(name, extra string) {
		writeText(filepath.Join(feedback, name+".md"), "---\nname: "+name+"\ndescription: d\ntype: feedback\ncount: 3\n"+extra+"---\n\nbody\n")
	}
	rule("ok", "")
	rule("bad_glob", "projects: ['[unclosed']\n")
	rule("expired", "expires: 2020-01-01\n")
	writeText(filepath.Join(feedback, "unreadable.md"), "---\nname: [x\n---\n")
	io := MakeIo(IoOpts{ProjectDir: proj, Env: EnvVars{Home: home, ClaudeFeedbackDir: feedback}})
	active, inactive, broken := hlScanFeedback(io)
	names := func(rules []Rule) []string {
		out := []string{}
		for _, r := range rules {
			out = append(out, r.Name)
		}
		return out
	}
	// 1 つのルールの glob が壊れていても全体は止まらず、そのルールを読めないものとして出す。
	assert.Equal(t, []string{"ok"}, names(active))
	assert.Equal(t, []string{"expired"}, names(inactive))
	paths := []string{}
	for _, b := range broken {
		paths = append(paths, filepath.Base(b.Path))
	}
	sort.Strings(paths)
	assert.Equal(t, []string{"bad_glob.md", "unreadable.md"}, paths)
	assert.NoFileExists(t, filepath.Join(feedback, ".errors.jsonl"))
}

// pathIo は PATH だけを差し替える。
type pathIo struct {
	Io
	path string
}

func (p *pathIo) Env() EnvVars {
	env := p.Io.Env()
	env.Path = p.path
	return env
}
