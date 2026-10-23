package hookgate

// tests/feedback-bash-edit.spec.ts のうち、BashStarted / BashChanges（Bash が書き換えたファイルの検出）を通して
// FeedbackBashEdits を呼ぶテストの移植。feedback_bash_edit_test.go に置いた、検出を通さずに直接呼ぶテストの残り。
// 実際に git リポジトリを作り（bash_changes_test.go のヘルパー bctGit / bctGitAt / bctSetMtime を使う）、mtime を動かす。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fbsEnv struct {
	t    *testing.T
	proj string
	fb   string
}

func fbsRun(t *testing.T, body func(e fbsEnv)) {
	t.Helper()
	proj := TmpDir("bash-edit-proj-")
	fb := TmpDir("bash-edit-fb-")
	t.Cleanup(func() { RmTree(proj); RmTree(fb) })
	body(fbsEnv{t: t, proj: proj, fb: fb})
}

func (e fbsEnv) io(autoCount *bool) Io {
	return MakeIo(IoOpts{ProjectDir: e.proj, Now: func() int64 { return bctT0 }, Env: EnvVars{ClaudeFeedbackDir: e.fb}, AutoCount: autoCount})
}

func (e fbsEnv) payload(command string, extra Dict) Dict {
	if command == "" {
		command = "cat > src/a.ts <<'EOF' ... EOF"
	}
	p := Dict{"session_id": "sess-1", "tool_name": "Bash", "tool_input": Dict{"command": command}, "tool_use_id": "tu1", "cwd": e.proj}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func (e fbsEnv) writeRule(name string, count int, enforce []string) {
	content := strings.Join(append(append([]string{"---", "name: " + name, "description: test", "type: feedback", "count: " + strconv.Itoa(count), "enforce:"}, enforce...), "---", "", "body", ""), "\n")
	fbtWrite(filepath.Join(e.fb, name+".md"), content)
}

func (e fbsEnv) consoleLogPost(count int) {
	e.writeRule("no_console_log", count, []string{
		"  - event: post_edit",
		"    path: 'src/**/*.ts'",
		`    when: '^\s*console\.log\('`,
		"    message: 'console.log を残さない'",
	})
}

func (e fbsEnv) noAnyPre(count int) {
	e.writeRule("no_any", count, []string{"  - event: pre_edit", "    path: 'src/**/*.ts'", `    when: ':\s*any\b'`, "    message: 'any を書かない'"})
}

// initRepo は git init して src/old.ts をコミットした PJ（開始時刻より前のコミット）を作る。
func (e fbsEnv) initRepo(gate bool) {
	if gate {
		WriteGateYaml(e.proj, Dict{"rules": []any{}})
	}
	bctGitAt(e.t, bctT0-3_600_000, e.proj, "init", "-q")
	bctGitAt(e.t, bctT0-3_600_000, e.proj, "config", "user.email", "t@example.com")
	bctGitAt(e.t, bctT0-3_600_000, e.proj, "config", "user.name", "t")
	fbtWrite(filepath.Join(e.proj, ".gitignore"), ".claude/.gate-status/\n")
	fbtWrite(filepath.Join(e.proj, "src", "old.ts"), "export const x: any = 1\n")
	bctGitAt(e.t, bctT0-3_600_000, e.proj, "add", ".")
	bctGitAt(e.t, bctT0-3_600_000, e.proj, "commit", "-q", "-m", "init")
}

// bashWrite は Bash が書いたことにする（開始以降の mtime）。
func (e fbsEnv) bashWrite(rel, text string) string {
	abs := filepath.Join(e.proj, rel)
	fbtWrite(abs, text)
	bctSetMtime(e.t, abs, bctT0+500)
	return abs
}

func (e fbsEnv) runBash(write func(), p Dict) ScriptResult {
	BashStarted(e.io(nil), p)
	write()
	return BashChanges(e.io(nil), p)
}

func (e fbsEnv) countOf(name string) int {
	n, ok := ReadCountLine(Read(filepath.Join(e.fb, name+".md")))
	require.True(e.t, ok)
	return n
}

func fbsJSON(t *testing.T, text string) Dict {
	t.Helper()
	var d Dict
	require.NoError(t, json.Unmarshal([]byte(text), &d), text)
	return d
}

func TestBashEditsAreCheckedByFeedbackRules(t *testing.T) {
	t.Run("a file written by Bash is blocked by a post_edit rule, like Edit / Write (with gate.yaml)", func(t *testing.T) {
		fbsRun(t, func(e fbsEnv) {
			e.initRepo(true)
			e.consoleLogPost(4)
			r := e.runBash(func() { e.bashWrite("src/a.ts", "console.log(1)\n") }, e.payload("", nil))
			out := fbsJSON(t, r.Stdout)
			assert.Equal(t, "block", out["decision"])
			assert.Contains(t, out["reason"], "no_console_log (count: 4): console.log を残さない (src/a.ts: content matched")
		})
	})

	t.Run("works without gate.yaml, keeping state out of the project", func(t *testing.T) {
		fbsRun(t, func(e fbsEnv) {
			e.initRepo(false)
			e.consoleLogPost(4)
			BashStarted(e.io(nil), e.payload("", nil))
			// 開始時刻は feedback 側の状態置き場に置く（PJ の .claude/ には何も作らない）
			names := func() []string {
				entries, err := os.ReadDir(filepath.Join(e.fb, ".bash_started"))
				require.NoError(t, err)
				out := []string{}
				for _, en := range entries {
					out = append(out, en.Name())
				}
				return out
			}
			assert.Equal(t, []string{"bash_started.sess-1--tu1.json"}, names())
			e.bashWrite("src/a.ts", "console.log(1)\n")
			r := BashChanges(e.io(nil), e.payload("", nil))
			assert.Equal(t, "block", fbsJSON(t, r.Stdout)["decision"])
			assert.False(t, Exists(filepath.Join(e.proj, ".claude")))
			assert.Equal(t, []string{}, names())
		})
	})

	t.Run("a clean file and files outside path are not blocked; count 1 only warns", func(t *testing.T) {
		fbsRun(t, func(e fbsEnv) {
			e.initRepo(false)
			e.consoleLogPost(1)
			r := e.runBash(func() {
				e.bashWrite("src/a.ts", "console.log(1)\n")
				e.bashWrite("src/b.ts", "export {}\n")
				e.bashWrite("other/c.ts", "console.log(1)\n")
			}, e.payload("", nil))
			assert.Equal(t, "", r.Stdout)
			lines := strings.Split(strings.TrimRight(r.Stderr, "\n"), "\n")
			assert.Equal(t, "[feedback-post-edit] warn: no_console_log (count: 1): console.log を残さない (src/a.ts)", lines[0])
			// 残りは count の自動引き上げの通知だけ
			require.Len(t, lines, 2)
			assert.Contains(t, lines[1], "no_console_log の count を 1 → 2 に上げました")
		})
	})

	t.Run("violations in several files are merged into one block", func(t *testing.T) {
		fbsRun(t, func(e fbsEnv) {
			e.initRepo(false)
			e.consoleLogPost(4)
			r := e.runBash(func() {
				e.bashWrite("src/a.ts", "console.log(1)\n")
				e.bashWrite("src/b.ts", "console.log(2)\n")
			}, e.payload("", nil))
			reason := Str(fbsJSON(t, r.Stdout)["reason"])
			assert.Contains(t, reason, "(src/a.ts: ")
			assert.Contains(t, reason, "(src/b.ts: ")
		})
	})

	t.Run("git history / working-tree commands are not checked", func(t *testing.T) {
		fbsRun(t, func(e fbsEnv) {
			e.initRepo(false)
			e.consoleLogPost(4)
			r := e.runBash(func() { e.bashWrite("src/a.ts", "console.log(1)\n") }, e.payload("git checkout -b feature", nil))
			assert.Equal(t, "", r.Stdout)
			assert.Equal(t, "", r.Stderr)
		})
	})

	t.Run("violations are logged", func(t *testing.T) {
		fbsRun(t, func(e fbsEnv) {
			e.initRepo(false)
			e.consoleLogPost(4)
			e.runBash(func() { e.bashWrite("src/a.ts", "console.log(1)\n") }, e.payload("", nil))
			lines := strings.Split(strings.TrimSpace(Read(filepath.Join(e.fb, ".violations.jsonl"))), "\n")
			require.Len(t, lines, 1)
			got := fbsJSON(t, lines[0])
			assert.Equal(t, "no_console_log", got["rule"])
			assert.Equal(t, "post_edit", got["event"])
			assert.Equal(t, "block", got["severity"])
		})
	})

	t.Run("a broken rule file elsewhere does not disable the post_edit / pre_edit checks; it is logged", func(t *testing.T) {
		fbsRun(t, func(e fbsEnv) {
			e.initRepo(false)
			e.consoleLogPost(4)
			// YAML として読めないファイル
			fbtWrite(filepath.Join(e.fb, "aa_yaml.md"), "---\nname: aa_yaml\ncount: 3\nenforce:\n  - event: post_edit\n    path: 'it's'\n---\n")
			// Python 互換でない正規表現の要素（その要素だけ捨てる）と、enforce が辞書でないルール
			e.writeRule("aa_regex", 4, []string{"  - event: post_edit", "    path: 'src/**/*.ts'", "    when: 'x(?i)y'", "    message: 'x'"})
			e.writeRule("aa_null", 4, []string{"  -"})
			// 同じルール内の壊れた要素は飛ばし、正しい要素（pre_edit）は効く
			e.writeRule("no_any", 3, []string{
				"  - event: pre_edit",
				"    path: 'src/**/*.ts'",
				"    when: '(?<'",
				"    message: 'x'",
				"  - event: pre_edit",
				"    path: 'src/**/*.ts'",
				`    when: ':\s*any\b'`,
				"    message: 'any を書かない'",
			})
			r := e.runBash(func() { e.bashWrite("src/a.ts", "console.log(1)\nexport const y: any = 2\n") }, e.payload("", nil))
			reason := Str(fbsJSON(t, r.Stdout)["reason"])
			assert.Contains(t, reason, "no_console_log (count: 4): console.log を残さない (src/a.ts: ")
			assert.Contains(t, reason, "no_any (count: 3): any を書かない (src/a.ts: ")
			errors := Read(filepath.Join(e.fb, ".errors.jsonl"))
			for _, f := range []string{"aa_yaml", "aa_regex", "aa_null", "no_any"} {
				assert.Contains(t, errors, filepath.Join(e.fb, f+".md"))
			}
			// 壊れた要素を持つルールでも count の自動引き上げは frontmatter の count 行だけを書き換える
			noAny := Read(filepath.Join(e.fb, "no_any.md"))
			n, ok := ReadCountLine(noAny)
			require.True(t, ok)
			assert.Equal(t, 4, n)
			assert.Contains(t, noAny, "when: '(?<'")
			n, ok = ReadCountLine(Read(filepath.Join(e.fb, "aa_yaml.md")))
			require.True(t, ok)
			assert.Equal(t, 3, n)
		})
	})

	t.Run("count auto bump", func(t *testing.T) {
		t.Run("a post_edit violation in a file written by Bash raises the count once per session", func(t *testing.T) {
			fbsRun(t, func(e fbsEnv) {
				e.initRepo(false)
				e.consoleLogPost(3)
				r := e.runBash(func() { e.bashWrite("src/a.ts", "console.log(1)\n") }, e.payload("", nil))
				assert.Equal(t, 4, e.countOf("no_console_log"))
				reason := Str(fbsJSON(t, r.Stdout)["reason"])
				assert.Contains(t, reason, "no_console_log (count: 3)")
				assert.Contains(t, reason, "no_console_log の count を 3 → 4 に上げました")

				// 同じセッションでの 2 回目は上げない
				r2 := e.runBash(func() { e.bashWrite("src/b.ts", "console.log(2)\n") }, e.payload("", Dict{"tool_use_id": "tu2"}))
				assert.Contains(t, fbsJSON(t, r2.Stdout)["reason"], "no_console_log (count: 4)")
				assert.NotContains(t, r2.Stdout, "上げました")
				assert.Equal(t, 4, e.countOf("no_console_log"))

				// 別のセッションならまた上がる
				e.runBash(func() { e.bashWrite("src/c.ts", "console.log(3)\n") }, e.payload("", Dict{"session_id": "sess-2"}))
				assert.Equal(t, 5, e.countOf("no_console_log"))
			})
		})

		t.Run("a warn-level violation also raises the count, with the note on stderr", func(t *testing.T) {
			fbsRun(t, func(e fbsEnv) {
				e.initRepo(false)
				e.consoleLogPost(1)
				r := e.runBash(func() { e.bashWrite("src/a.ts", "console.log(1)\n") }, e.payload("", nil))
				assert.Equal(t, "", r.Stdout)
				assert.Contains(t, r.Stderr, "no_console_log の count を 1 → 2 に上げました")
				assert.Equal(t, 2, e.countOf("no_console_log"))
			})
		})

		t.Run("a pre_edit violation detected after the command raises the count", func(t *testing.T) {
			fbsRun(t, func(e fbsEnv) {
				e.initRepo(false)
				e.noAnyPre(3)
				r := e.runBash(func() { e.bashWrite("src/new.ts", "export const y: any = 2\n") }, e.payload("", nil))
				assert.Contains(t, fbsJSON(t, r.Stdout)["reason"], "no_any の count を 3 → 4 に上げました")
				assert.Equal(t, 4, e.countOf("no_any"))
			})
		})

		t.Run("autoCount=false leaves the count alone", func(t *testing.T) {
			fbsRun(t, func(e fbsEnv) {
				e.initRepo(false)
				e.consoleLogPost(4)
				p := e.payload("", nil)
				off := false
				BashStarted(e.io(&off), p)
				e.bashWrite("src/a.ts", "console.log(1)\n")
				r := BashChanges(e.io(&off), p)
				assert.Equal(t, "block", fbsJSON(t, r.Stdout)["decision"])
				assert.NotContains(t, r.Stdout, "上げました")
				assert.Equal(t, 4, e.countOf("no_console_log"))
			})
		})
	})

	t.Run("pre_edit (checked after the command)", func(t *testing.T) {
		t.Run("a new file whose content matches when is blocked, saying it was detected after the command", func(t *testing.T) {
			fbsRun(t, func(e fbsEnv) {
				e.initRepo(false)
				e.noAnyPre(5)
				r := e.runBash(func() { e.bashWrite("src/a.ts", "export const y: any = 2\n") }, e.payload("", nil))
				reason := Str(fbsJSON(t, r.Stdout)["reason"])
				assert.Contains(t, reason, "[feedback-guard] no_any (count: 5): any を書かない (src/a.ts: content matched")
				assert.Contains(t, reason, "実行後に検知しました")
			})
		})

		t.Run("only the lines this command added to a tracked file are matched", func(t *testing.T) {
			fbsRun(t, func(e fbsEnv) {
				e.initRepo(false)
				e.noAnyPre(5)
				// old.ts には元から ": any" があるが、このコマンドが足したのは別の行
				clean := e.runBash(func() { e.bashWrite("src/old.ts", "export const x: any = 1\nexport const z = 3\n") }, e.payload("", nil))
				assert.Equal(t, "", clean.Stdout)
				dirty := e.runBash(
					func() {
						e.bashWrite("src/old.ts", "export const x: any = 1\nexport const z = 3\nexport const w: any = 4\n")
					},
					e.payload("sed -i ...", Dict{"tool_use_id": "tu2"}),
				)
				assert.Contains(t, fbsJSON(t, dirty.Stdout)["reason"], "no_any")
			})
		})

		t.Run("lines committed within the same command are matched", func(t *testing.T) {
			fbsRun(t, func(e fbsEnv) {
				e.initRepo(false)
				e.noAnyPre(5)
				p := e.payload("cat > src/old.ts && git commit -am wip", nil)
				BashStarted(e.io(nil), p)
				e.bashWrite("src/old.ts", "export const x: any = 1\nexport const w: any = 4\n")
				bctGitAt(t, bctT0+1000, e.proj, "commit", "-qam", "wip")
				r := BashChanges(e.io(nil), p)
				assert.Contains(t, fbsJSON(t, r.Stdout)["reason"], "no_any")
			})
		})

		t.Run("absent_sibling: an implementation written without its test is blocked; with the test it passes", func(t *testing.T) {
			fbsRun(t, func(e fbsEnv) {
				e.initRepo(false)
				e.writeRule("tdd", 4, []string{"  - event: pre_edit", "    path: 'src/**/*.ts'", "    absent_sibling: '{stem}.test.ts'", "    message: 'テストを先に書く'"})
				bad := e.runBash(func() { e.bashWrite("src/foo.ts", "export {}\n") }, e.payload("", nil))
				assert.Contains(t, fbsJSON(t, bad.Stdout)["reason"], "tdd (count: 4): テストを先に書く (src/foo.ts: missing test file: foo.test.ts)")
				// 違反で count が 5（deny）に上がるので、残しておくと次の実行でも block になる。テストのある側だけを確かめる。
				require.NoError(t, os.Remove(filepath.Join(e.proj, "src", "foo.ts")))
				good := e.runBash(func() {
					e.bashWrite("src/bar.ts", "export {}\n")
					e.bashWrite("src/bar.test.ts", "test\n")
				}, e.payload("python3 gen.py", Dict{"tool_use_id": "tu2"}))
				assert.Equal(t, "", good.Stdout)
			})
		})

		t.Run("a heredoc write judged by PreToolUse is not checked again by pre_edit; post_edit still runs", func(t *testing.T) {
			fbsRun(t, func(e fbsEnv) {
				e.initRepo(false)
				e.noAnyPre(5)
				e.consoleLogPost(5)
				command := "cat > src/a.ts <<'EOF'\nexport const y: any = 2\nconsole.log(1)\nEOF"
				r := e.runBash(func() { e.bashWrite("src/a.ts", "export const y: any = 2\nconsole.log(1)\n") }, e.payload(command, nil))
				reason := Str(fbsJSON(t, r.Stdout)["reason"])
				assert.Contains(t, reason, "no_console_log")
				assert.NotContains(t, reason, "no_any")
				// 同じコマンドが heredoc 以外でも書いたファイルは、これまでどおり実行後に pre_edit を掛ける
				r2 := e.runBash(func() { e.bashWrite("src/b.ts", "export const y: any = 2\n") }, e.payload(command+"\npython3 gen.py", Dict{"tool_use_id": "tu2"}))
				assert.Contains(t, Str(fbsJSON(t, r2.Stdout)["reason"]), "no_any (count: 5): any を書かない (src/b.ts")
			})
		})

		t.Run("an ask already answered for the same file in this session is downgraded to warn", func(t *testing.T) {
			fbsRun(t, func(e fbsEnv) {
				e.initRepo(false)
				e.noAnyPre(3)
				first := e.runBash(func() { e.bashWrite("src/a.ts", "export const y: any = 2\n") }, e.payload("", nil))
				assert.Equal(t, "block", fbsJSON(t, first.Stdout)["decision"])
				second := e.runBash(func() { e.bashWrite("src/a.ts", "export const y: any = 3\n") }, e.payload("sed -i ...", Dict{"tool_use_id": "tu2"}))
				assert.Equal(t, "", second.Stdout)
				// 1 回目の違反で count は 4 に上がっている（4 でもまだ ask なので、承認済みとして warn に落ちる）
				assert.Contains(t, second.Stderr, "[feedback-guard] warn: no_any (count: 4)")
			})
		})
	})
}
