package hookgate

// `feedback-gate codex install-hooks`（codex_install_hooks.go）: plugins/codex/hooks/hooks.json を ${PLUGIN_ROOT} を解決して
// 設定層の hooks.json に写す。既存の他の hook は残し、このプラグインのものだけを置き換える。

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func installHooks(t *testing.T, env map[string]string, cwd string, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := CodexInstallHooks(args, env, cwd, &out, &errOut)
	return code, out.String(), errOut.String()
}

func readHooksJSON(t *testing.T, path string) Dict {
	t.Helper()
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var d Dict
	require.NoError(t, json.Unmarshal(data, &d))
	return d
}

func hookCommands(t *testing.T, doc Dict, event string) []string {
	t.Helper()
	hooks, _ := doc["hooks"].(Dict)
	groups, _ := hooks[event].([]any)
	var cmds []string
	for _, g := range groups {
		gm, _ := g.(Dict)
		hs, _ := gm["hooks"].([]any)
		for _, h := range hs {
			hm, _ := h.(Dict)
			cmds = append(cmds, strOf(hm["command"]))
		}
	}
	return cmds
}

func TestCodexInstallHooks(t *testing.T) {
	// プラグインのルートはこのリポジトリ（plugins/codex/hooks/hooks.json がある）。
	events := []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SubagentStop"}

	t.Run("writes every event of the plugin's hooks.json into $CODEX_HOME/hooks.json with ${PLUGIN_ROOT} resolved", func(t *testing.T) {
		home := TmpDir()
		defer RmTree(home)
		code, out, errOut := installHooks(t, map[string]string{"HOME": home}, RepoRoot)
		require.Equal(t, 0, code, errOut)
		assert.Equal(t, "", errOut)
		target := filepath.Join(home, ".codex", "hooks.json")
		assert.Contains(t, out, "added 7 hook group(s)")
		assert.Contains(t, out, target)
		doc := readHooksJSON(t, target)
		hooks := doc["hooks"].(Dict)
		assert.Len(t, hooks, len(events))
		for _, e := range events {
			cmds := hookCommands(t, doc, e)
			require.Len(t, cmds, 1, e)
			assert.Equal(t, `bash "`+RepoRoot+`/plugins/codex/scripts/hook.sh" `+e, cmds[0])
		}
		// PostToolUse / Stop / SubagentStop の timeout はそのまま。
		groups := hooks["PostToolUse"].([]any)
		h := groups[0].(Dict)["hooks"].([]any)[0].(Dict)
		assert.Equal(t, float64(600), h["timeout"])
		assert.Equal(t, "Bash|apply_patch|spawn_agent", groups[0].(Dict)["matcher"])
	})

	t.Run("CODEX_HOME wins over HOME; --root points at the plugin; running twice keeps one copy; other hooks and keys stay", func(t *testing.T) {
		dir := TmpDir()
		defer RmTree(dir)
		codexHome := filepath.Join(dir, "codex-home")
		target := filepath.Join(codexHome, "hooks.json")
		require.NoError(t, os.MkdirAll(codexHome, 0o755))
		existing := `{
  "extra": true,
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo mine"}]}
    ],
    "Stop": [
      {"hooks": [{"type": "command", "command": "bash /old/plugins/codex/scripts/hook.sh Stop"}]}
    ]
  }
}
`
		require.NoError(t, os.WriteFile(target, []byte(existing), 0o644))
		env := map[string]string{"HOME": filepath.Join(dir, "unused-home"), "CODEX_HOME": codexHome}
		code, out, errOut := installHooks(t, env, dir, "--root", RepoRoot)
		require.Equal(t, 0, code, errOut)
		// 古いルートの写し（/old/...）は置き換えられる。
		assert.Contains(t, out, "replaced 7 hook group(s)")
		assert.NoFileExists(t, filepath.Join(dir, "unused-home", ".codex", "hooks.json"))
		doc := readHooksJSON(t, target)
		assert.Equal(t, true, doc["extra"])
		assert.Equal(t, []string{"echo mine", `bash "` + RepoRoot + `/plugins/codex/scripts/hook.sh" PreToolUse`}, hookCommands(t, doc, "PreToolUse"))
		assert.Equal(t, []string{`bash "` + RepoRoot + `/plugins/codex/scripts/hook.sh" Stop`}, hookCommands(t, doc, "Stop"))

		code, _, errOut = installHooks(t, env, dir, "--root", RepoRoot)
		require.Equal(t, 0, code, errOut)
		doc = readHooksJSON(t, target)
		assert.Len(t, hookCommands(t, doc, "PreToolUse"), 2)
		assert.Len(t, hookCommands(t, doc, "Stop"), 1)
		// キーの順序はファイルのまま（extra が先、PreToolUse が先）。
		text, _ := os.ReadFile(target)
		assert.Less(t, strings.Index(string(text), `"extra"`), strings.Index(string(text), `"hooks"`))
		assert.Less(t, strings.Index(string(text), `"PreToolUse"`), strings.Index(string(text), `"SessionStart"`))

		// --remove はこのプラグインのものだけを外し、他の hook と他のキーは残す。
		code, out, errOut = installHooks(t, env, dir, "--root", RepoRoot, "--remove")
		require.Equal(t, 0, code, errOut)
		assert.Contains(t, out, "removed 7 feedback-gate hook group(s)")
		doc = readHooksJSON(t, target)
		assert.Equal(t, true, doc["extra"])
		assert.Equal(t, []string{"echo mine"}, hookCommands(t, doc, "PreToolUse"))
		assert.Nil(t, doc["hooks"].(Dict)["Stop"])
		assert.Len(t, doc["hooks"].(Dict), 1)
		code, out, _ = installHooks(t, env, dir, "--root", RepoRoot, "--remove")
		assert.Equal(t, 0, code)
		assert.Contains(t, out, "nothing to do")
	})

	t.Run("--project writes <dir>/.codex/hooks.json, --to any file; relative paths are against cwd", func(t *testing.T) {
		dir := TmpDir()
		defer RmTree(dir)
		env := map[string]string{"HOME": dir, "PLUGIN_ROOT": RepoRoot}
		code, _, errOut := installHooks(t, env, dir, "--project")
		require.Equal(t, 0, code, errOut)
		assert.FileExists(t, filepath.Join(dir, ".codex", "hooks.json"))
		code, _, errOut = installHooks(t, env, dir, "--project", "sub")
		require.Equal(t, 0, code, errOut)
		assert.FileExists(t, filepath.Join(dir, "sub", ".codex", "hooks.json"))
		code, _, errOut = installHooks(t, env, dir, "--to", "etc/hooks.json")
		require.Equal(t, 0, code, errOut)
		doc := readHooksJSON(t, filepath.Join(dir, "etc", "hooks.json"))
		assert.Len(t, doc["hooks"].(Dict), len(events))
		assert.NoFileExists(t, filepath.Join(dir, ".codex", "hooks.json.tmp"))
	})

	t.Run("--print prints the hooks.json and writes nothing; --toml prints [hooks] tables for requirements.toml", func(t *testing.T) {
		home := TmpDir()
		defer RmTree(home)
		env := map[string]string{"HOME": home}
		code, out, errOut := installHooks(t, env, RepoRoot, "--print")
		require.Equal(t, 0, code, errOut)
		assert.NoFileExists(t, filepath.Join(home, ".codex", "hooks.json"))
		var doc Dict
		require.NoError(t, json.Unmarshal([]byte(out), &doc))
		assert.Len(t, doc["hooks"].(Dict), len(events))
		assert.True(t, strings.HasPrefix(out, "{\n  \"hooks\": {\n    \"SessionStart\""))

		code, out, errOut = installHooks(t, env, RepoRoot, "--toml")
		require.Equal(t, 0, code, errOut)
		assert.NoFileExists(t, filepath.Join(home, ".codex", "hooks.json"))
		assert.Contains(t, out, "[[hooks.PreToolUse]]\nmatcher = \"Bash|apply_patch|spawn_agent|send_input\"\n\n[[hooks.PreToolUse.hooks]]\ntype = \"command\"\ncommand = \"bash \\\""+RepoRoot+"/plugins/codex/scripts/hook.sh\\\" PreToolUse\"\n")
		assert.Contains(t, out, "[[hooks.PostToolUse.hooks]]\ntype = \"command\"\ncommand = \"bash \\\""+RepoRoot+"/plugins/codex/scripts/hook.sh\\\" PostToolUse\"\ntimeout = 600\n")
		assert.Contains(t, out, "allow_managed_hooks_only")
		for _, e := range events {
			assert.Contains(t, out, "[[hooks."+e+"]]\n")
		}
	})

	t.Run("errors: no plugin at the root, invalid target JSON (kept as is), bad arguments, no HOME", func(t *testing.T) {
		dir := TmpDir()
		defer RmTree(dir)
		code, _, errOut := installHooks(t, map[string]string{"HOME": dir}, dir)
		assert.Equal(t, 1, code)
		assert.Contains(t, errOut, "not a feedback-gate plugin root")
		assert.NoFileExists(t, filepath.Join(dir, ".codex", "hooks.json"))

		target := filepath.Join(dir, ".codex", "hooks.json")
		require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
		require.NoError(t, os.WriteFile(target, []byte("{ not json"), 0o644))
		code, _, errOut = installHooks(t, map[string]string{"HOME": dir}, RepoRoot)
		assert.Equal(t, 1, code)
		assert.Contains(t, errOut, "not valid JSON")
		text, _ := os.ReadFile(target)
		assert.Equal(t, "{ not json", string(text))

		for _, args := range [][]string{{"--bogus"}, {"--to"}, {"--print", "--toml"}, {"--toml", "--remove"}, {"--print", "--remove"}, {"--to", "a", "--project"}, {"--to", "a", "--toml"}} {
			code, _, errOut = installHooks(t, map[string]string{"HOME": dir}, RepoRoot, args...)
			assert.Equal(t, 1, code, args)
			assert.Contains(t, errOut, "usage: feedback-gate codex install-hooks", args)
		}
		code, _, errOut = installHooks(t, map[string]string{}, RepoRoot)
		assert.Equal(t, 1, code)
		assert.Contains(t, errOut, "neither CODEX_HOME nor HOME")
	})

	t.Run("--print with --to merges with that file and writes nothing (for a file only root may write)", func(t *testing.T) {
		dir := TmpDir()
		defer RmTree(dir)
		target := filepath.Join(dir, "etc", "hooks.json")
		require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
		existing := `{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo admin"}]}]}, "note": "keep"}` + "\n"
		require.NoError(t, os.WriteFile(target, []byte(existing), 0o644))
		env := map[string]string{"HOME": dir}
		code, out, errOut := installHooks(t, env, dir, "--root", RepoRoot, "--print", "--to", target)
		require.Equal(t, 0, code, errOut)
		text, _ := os.ReadFile(target)
		assert.Equal(t, existing, string(text), "the target is not written")
		var doc Dict
		require.NoError(t, json.Unmarshal([]byte(out), &doc))
		assert.Equal(t, "keep", doc["note"])
		assert.Equal(t, []string{"echo admin", `bash "` + RepoRoot + `/plugins/codex/scripts/hook.sh" Stop`}, hookCommands(t, doc, "Stop"))
		assert.Len(t, doc["hooks"].(Dict), len(events))
		// 無いファイルを指しても、テンプレートだけが出る。--remove --print は外した結果を出す。
		code, out, errOut = installHooks(t, env, dir, "--root", RepoRoot, "--print", "--to", filepath.Join(dir, "none.json"))
		require.Equal(t, 0, code, errOut)
		require.NoError(t, json.Unmarshal([]byte(out), &doc))
		assert.Len(t, doc["hooks"].(Dict), len(events))
		assert.NoFileExists(t, filepath.Join(dir, "none.json"))
		code, out, errOut = installHooks(t, env, dir, "--root", RepoRoot, "--print", "--remove", "--to", target)
		require.Equal(t, 0, code, errOut)
		require.NoError(t, json.Unmarshal([]byte(out), &doc))
		assert.Equal(t, []string{"echo admin"}, hookCommands(t, doc, "Stop"))
		// 対象が壊れた JSON なら、--print でもエラー。
		require.NoError(t, os.WriteFile(target, []byte("{ nope"), 0o644))
		code, _, errOut = installHooks(t, env, dir, "--root", RepoRoot, "--print", "--to", target)
		assert.Equal(t, 1, code)
		assert.Contains(t, errOut, "not valid JSON")
	})

	t.Run("MergeCodexHooks: a group is the plugin's only when every command is plugins/codex/scripts/hook.sh", func(t *testing.T) {
		groups, err := LoadCodexHooksTemplate(RepoRoot)
		require.NoError(t, err)
		mixed := OMap{{"hooks", OMap{{"Stop", []any{
			OMap{{"hooks", []any{
				OMap{{"type", "command"}, {"command", "bash /x/plugins/codex/scripts/hook.sh Stop"}},
				OMap{{"type", "command"}, {"command", "echo also"}},
			}}},
		}}}}}
		out, removed, added := MergeCodexHooks(mixed, groups, false)
		assert.Equal(t, 0, removed)
		assert.Equal(t, len(groups), added)
		stop := out.get("hooks").(OMap).get("Stop").([]any)
		assert.Len(t, stop, 2)
	})
}
