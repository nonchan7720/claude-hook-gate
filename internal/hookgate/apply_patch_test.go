package hookgate

// Codex の apply_patch の入力（apply_patch.go）を、ファイルごとの Edit / Write の payload に読み替える。

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

var testPatch = strings.Join([]string{
	"*** Begin Patch",
	"*** Add File: src/new.py",
	`+print("hi")`,
	"+x = 1",
	"*** Update File: src/old.py",
	"@@ def f():",
	"     pass",
	"-    return 1",
	"+    return 2",
	"+    # TODO later",
	"*** End of File",
	"*** Update File: src/moved.py",
	"*** Move to: src/renamed.py",
	"@@",
	"+added",
	"*** Delete File: src/gone.py",
	"*** End Patch",
}, "\n")

func TestParsePatch(t *testing.T) {
	t.Run("ファイルごとに op / path / 追加行を取り出す", func(t *testing.T) {
		assert.Equal(t, []PatchFile{
			{Op: PatchAdd, Path: "src/new.py", Added: "print(\"hi\")\nx = 1"},
			{Op: PatchUpdate, Path: "src/old.py", Added: "    return 2\n    # TODO later"},
			{Op: PatchUpdate, Path: "src/moved.py", MovedTo: "src/renamed.py", Added: "added"},
			{Op: PatchDelete, Path: "src/gone.py", Added: ""},
		}, ParsePatch(testPatch))
	})

	t.Run("パッチの形をしていなければ空", func(t *testing.T) {
		assert.Empty(t, ParsePatch(""))
		assert.Empty(t, ParsePatch("echo hi"))
		assert.Empty(t, ParsePatch("*** Begin Patch\n*** End Patch"))
	})

	t.Run("CRLF と、End Patch の後ろのごみは無視する", func(t *testing.T) {
		files := ParsePatch("*** Begin Patch\r\n*** Add File: a.txt\r\n+one\r\n*** End Patch\r\nEOF\n")
		assert.Equal(t, []PatchFile{{Op: PatchAdd, Path: "a.txt", Added: "one"}}, files)
	})

	t.Run("シェルの heredoc に包まれていても Begin Patch から読む", func(t *testing.T) {
		files := ParsePatch("apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch\nEOF")
		assert.Equal(t, []PatchFile{{Op: PatchAdd, Path: "a.txt", Added: "one"}}, files)
	})
}

func TestPatchText(t *testing.T) {
	t.Run("command → input → patch の順に、パッチを含む文字列を返す", func(t *testing.T) {
		assert.Equal(t, testPatch, PatchText(Dict{"command": testPatch}))
		assert.Equal(t, testPatch, PatchText(Dict{"input": testPatch}))
		assert.Equal(t, testPatch, PatchText(Dict{"patch": testPatch}))
		assert.Equal(t, testPatch, PatchText(Dict{"command": "ls", "input": testPatch}))
		assert.Equal(t, "", PatchText(Dict{"command": "ls"}))
		assert.Equal(t, "", PatchText("nope"))
	})
}

func TestPatchPayloads(t *testing.T) {
	t.Run("相対パスは base 起点、絶対パスはそのまま", func(t *testing.T) {
		assert.Equal(t, "/proj/src/a.py", AbsolutePath("src/a.py", "/proj"))
		assert.Equal(t, "/abs/a.py", AbsolutePath("/abs/a.py", "/proj"))
	})

	t.Run("Add は Write（content）、Update は Edit（new_string）、Delete は除く。移動は移動先のパス", func(t *testing.T) {
		payload := Dict{"session_id": "s", "cwd": "/proj", "tool_name": "apply_patch", "tool_input": Dict{"command": testPatch}, "tool_use_id": "t1", "agent_id": "ag"}
		with := func(name string, input Dict) Dict {
			p := Dict{}
			for k, v := range payload {
				p[k] = v
			}
			p["tool_name"] = name
			p["tool_input"] = input
			return p
		}
		assert.Equal(t, []Dict{
			with("Write", Dict{"file_path": "/proj/src/new.py", "content": "print(\"hi\")\nx = 1"}),
			with("Edit", Dict{"file_path": "/proj/src/old.py", "old_string": "", "new_string": "    return 2\n    # TODO later"}),
			with("Edit", Dict{"file_path": "/proj/src/renamed.py", "old_string": "", "new_string": "added"}),
		}, PatchPayloads(payload, "/proj"))
	})

	t.Run("パッチでない tool_input は空", func(t *testing.T) {
		assert.Empty(t, PatchPayloads(Dict{"tool_name": "apply_patch", "tool_input": Dict{"command": "ls"}}, "/proj"))
		assert.Empty(t, PatchPayloads(Dict{"tool_name": "apply_patch"}, "/proj"))
	})
}
