package hookgate

// tests/broken-rules.spec.ts の移植。
// 壊れた feedback ルール（YAML として読めない・不正な正規表現・enforce がリストでない／要素が辞書でない）が、
// 他の正常なルールまで無効にしないこと、そしてその不備が .errors.jsonl・注入で見えること。
//
// 省略: '/correct reports the broken rules as proposals'（src/correct.ts の correctCommand を使う。/correct は
// TypeScript のまま残り Go には移植しない）。

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func fbtBrokenRuleText(name string, count int, body string) string {
	return "---\nname: " + name + "\ndescription: d\ntype: feedback\ncount: " + strconv.Itoa(count) + "\n" + body + "---\n\n本文\n"
}

func TestBrokenRules(t *testing.T) {
	cd := fbtBrokenRuleText("delegate_no_cd_in_bash", 6, "enforce:\n  - event: pre_bash\n    when: '(^|[;&|]\\s*)cd\\s'\n    message: no cd\n    severity: deny\n")

	// 壊れ方ごとの、同じディレクトリに置く別ファイル（ファイル名は cd.md より前に読まれる aa_ / 後に読まれる zz_ を混ぜる）。
	type brokenCase struct{ label, file, content string }
	yamlErr := brokenCase{"YAML syntax error", "zz_yaml.md", fbtBrokenRuleText("zz_yaml", 3, "enforce:\n  - event: pre_bash\n    when: 'it's'\n    message: x\n")}
	nullEnforce := brokenCase{"enforce: [null]", "aa_null.md", fbtBrokenRuleText("aa_null", 6, "enforce:\n  -\n")}
	dictEnforce := brokenCase{"enforce is a mapping", "aa_dict.md", fbtBrokenRuleText("aa_dict", 6, "enforce:\n  event: pre_bash\n  when: rm\n")}
	cases := []brokenCase{
		yamlErr,
		{"inline flag mid-pattern x(?i)y", "aa_flag.md", fbtBrokenRuleText("aa_flag", 6, "enforce:\n  - event: pre_bash\n    when: 'go\\s+test(?i)\\s'\n    message: x\n    severity: deny\n")},
		{"possessive quantifier a*+", "aa_poss.md", fbtBrokenRuleText("aa_poss", 6, "enforce:\n  - event: pre_bash\n    when: 'cd'\n    unless: 'x*+'\n    message: x\n    severity: deny\n")},
		{"comment group (?#...)", "aa_comment.md", fbtBrokenRuleText("aa_comment", 6, "enforce:\n  - event: pre_bash\n    when: 'cd(?#comment)'\n    message: x\n")},
		{"recursive group (?P>n)", "aa_rec.md", fbtBrokenRuleText("aa_rec", 6, "enforce:\n  - event: pre_bash\n    when: '(?P<n>a)(?P>n)'\n    message: x\n")},
		{"verbose flag (?x)", "aa_verbose.md", fbtBrokenRuleText("aa_verbose", 6, "enforce:\n  - event: pre_bash\n    when: '(?x) c d'\n    message: x\n")},
		nullEnforce,
		dictEnforce,
		{"enforce is a string", "aa_str.md", fbtBrokenRuleText("aa_str", 6, "enforce: pre_bash\n")},
	}

	type env struct {
		dir, proj string
	}
	run := func(t *testing.T, body func(e env)) {
		t.Helper()
		WithTmp(func(dir string) {
			WithTmp(func(proj string) {
				fbtWrite(filepath.Join(dir, "cd.md"), cd)
				body(env{dir, proj})
			})
		})
	}
	ioOf := func(e env, lang ...Lang) Io {
		o := IoOpts{ProjectDir: e.proj, Env: EnvVars{ClaudeFeedbackDir: e.dir}}
		if len(lang) > 0 {
			o.Lang = lang[0]
		}
		return MakeIo(o)
	}
	guard := func(e env, command string) ScriptResult {
		return FeedbackGuard(ioOf(e), Dict{"tool_name": "Bash", "tool_input": Dict{"command": command}})
	}
	errorsOf := func(t *testing.T, e env) []Dict {
		p := filepath.Join(e.dir, ".errors.jsonl")
		if !Exists(p) {
			return []Dict{}
		}
		return fbtJSONLines(t, p)
	}

	t.Run("broken rules do not disable the other rules", func(t *testing.T) {
		for _, c := range cases {
			t.Run(c.label+": the deny rule still denies, the violation is logged and the broken file is recorded", func(t *testing.T) {
				run(t, func(e env) {
					fbtWrite(filepath.Join(e.dir, c.file), c.content)
					r := guard(e, "cd /proj/sub && golangci-lint run")
					assert.Equal(t, 0, r.ExitCode)
					assert.NotContains(t, r.Stderr, "internal error")
					out := fbtParseJSON(t, r.Stdout)["hookSpecificOutput"].(Dict)
					assert.Equal(t, "deny", out["permissionDecision"])
					assert.Contains(t, out["permissionDecisionReason"], "delegate_no_cd_in_bash")
					assert.Contains(t, Read(filepath.Join(e.dir, ".violations.jsonl")), "delegate_no_cd_in_bash")
					logged := errorsOf(t, e)
					require.Len(t, logged, 1)
					assert.Equal(t, "rules", logged[0]["source"])
					assert.Equal(t, filepath.Join(e.dir, c.file), logged[0]["file"])
					assert.NotEqual(t, "", Str(logged[0]["error"]))
					// 無関係なコマンドは通す
					assert.Equal(t, "", guard(e, "ls").Stdout)
				})
			})
		}
	})

	t.Run("the same broken rule is recorded only once in .errors.jsonl", func(t *testing.T) {
		run(t, func(e env) {
			fbtWrite(filepath.Join(e.dir, yamlErr.file), yamlErr.content)
			guard(e, "ls")
			guard(e, "ls")
			_, err := ListRules(ioOf(e))
			require.NoError(t, err)
			assert.Len(t, errorsOf(t, e), 1)
			assert.Equal(t, filepath.Join(e.dir, ".errors.jsonl"), ErrorsLogPath(ioOf(e)))
		})
	})

	t.Run("scanRules returns the file and the reason, and keeps the valid entries of a partly broken rule", func(t *testing.T) {
		run(t, func(e env) {
			fbtWrite(filepath.Join(e.dir, yamlErr.file), yamlErr.content)
			fbtWrite(filepath.Join(e.dir, "mixed.md"),
				fbtBrokenRuleText("mixed", 6, "enforce:\n  -\n  - event: pre_bash\n    when: 'a*+'\n  - event: pre_bash\n    when: 'rm -rf'\n    severity: deny\n"))
			res, err := ScanRules(ioOf(e))
			require.NoError(t, err)
			names := fbtNames(res.Rules)
			assert.ElementsMatch(t, []string{"delegate_no_cd_in_bash", "mixed"}, names)
			for _, r := range res.Rules {
				if r.Name == "mixed" {
					assert.Equal(t, []Dict{{"event": "pre_bash", "when": "rm -rf", "severity": "deny"}}, r.Enforce)
				}
			}
			bases := []string{}
			for _, b := range res.Broken {
				bases = append(bases, filepath.Base(b.Path))
			}
			assert.Equal(t, []string{"zz_yaml.md", "mixed.md", "mixed.md"}, bases)
			require.Len(t, res.Broken, 3)
			assert.True(t, strings.HasPrefix(res.Broken[0].Reason, "ファイルを読めません: "), res.Broken[0].Reason)
			assert.Equal(t, "enforce[0] が辞書ではありません（null）", res.Broken[1].Reason)
			assert.True(t, strings.HasPrefix(res.Broken[2].Reason, "enforce[1].when の正規表現が使えません: "), res.Broken[2].Reason)
			v := EvalPreBash(ioOf(e), res.Rules, "rm -rf x")
			assert.Equal(t, []string{"mixed"}, fbtViolationRules(v))
		})
	})

	t.Run("UserPromptSubmit injects the broken rules (ja / en), even without confirmed rules", func(t *testing.T) {
		run(t, func(e env) {
			require.NoError(t, os.Remove(filepath.Join(e.dir, "cd.md")))
			fbtWrite(filepath.Join(e.dir, yamlErr.file), yamlErr.content)
			ja := FeedbackInject(ioOf(e, LangJA))
			assert.Contains(t, ja.Stdout, "次のルールファイルが読めず無効になっています")
			assert.Contains(t, ja.Stdout, "- "+filepath.Join(e.dir, "zz_yaml.md")+": ファイルを読めません: ")
			assert.NotContains(t, ja.Stdout, "確定フィードバックルール")
			en := FeedbackInject(ioOf(e, LangEN))
			assert.Contains(t, en.Stdout, "The following rule files could not be read and are disabled")
			assert.Contains(t, en.Stdout, "- "+filepath.Join(e.dir, "zz_yaml.md")+": cannot read the file: ")
		})
	})

	t.Run("UserPromptSubmit puts the broken rules before the confirmed rules, and says nothing when nothing is broken", func(t *testing.T) {
		run(t, func(e env) {
			clean := FeedbackInject(ioOf(e))
			assert.NotContains(t, clean.Stdout, "読めず無効")
			fbtWrite(filepath.Join(e.dir, nullEnforce.file), nullEnforce.content)
			r := FeedbackInject(ioOf(e))
			brokenAt := strings.Index(r.Stdout, "読めず無効")
			assert.GreaterOrEqual(t, brokenAt, 0)
			assert.Less(t, brokenAt, strings.Index(r.Stdout, "■ delegate_no_cd_in_bash"))
			assert.Contains(t, r.Stdout, "- "+filepath.Join(e.dir, "aa_null.md")+": enforce[0] が辞書ではありません（null）")
		})
	})

	// 省略: '/correct reports the broken rules as proposals'（correctCommand は TypeScript のまま。dictEnforce は他で使わない）

	t.Run("post_edit and stop_check rules keep working next to a broken file", func(t *testing.T) {
		run(t, func(e env) {
			fbtWrite(filepath.Join(e.dir, yamlErr.file), yamlErr.content)
			fbtWrite(filepath.Join(e.dir, nullEnforce.file), nullEnforce.content)
			fbtWrite(filepath.Join(e.dir, "no_log.md"),
				fbtBrokenRuleText("no_log", 6, "enforce:\n  - event: post_edit\n    path: '**/*.ts'\n    when: 'console\\.log'\n    message: no log\n"))
			fbtWrite(filepath.Join(e.dir, "readme.md"),
				fbtBrokenRuleText("readme", 6, "enforce:\n  - event: stop_check\n    changed: '**/README.md'\n    require_sibling: 'README_ja.md'\n    message: both\n"))
			ts := filepath.Join(e.proj, "a.ts")
			fbtWrite(ts, "console.log(1)\n")
			pe := FeedbackPostEdit(ioOf(e), Dict{"tool_name": "Edit", "tool_input": Dict{"file_path": ts}})
			assert.Contains(t, pe.Stdout, `"decision":"block"`)
			fbtWrite(filepath.Join(e.proj, "README.md"), "")
			fbtWrite(filepath.Join(e.proj, ".claude", ".gate-status", "changed_files.s1.txt"), "README.md\n")
			sc := FeedbackStopCheck(ioOf(e), Dict{"session_id": "s1"})
			assert.Equal(t, 2, sc.ExitCode)
			assert.Contains(t, sc.Stderr, "readme")
		})
	})
}

func TestEnforceEntriesThatThrowAreSkippedOneByOne(t *testing.T) {
	// ListRules を通さずに作った Rule（検証されていない enforce）でも、評価関数が例外で止まらないこと。
	// TS 版は enforce に文字列などの辞書でない要素や、リストでない値を入れていた。Go の Rule.Enforce は []Dict なので、
	// 辞書でない要素は nil / 空の辞書で、リストでない値は nil で表す（添字がずれないよう、文字列の要素の場所には空の辞書を置く）。
	raw := func(name string, enforce []Dict) Rule {
		return Rule{Name: name, Count: 6, Description: "", Enforce: enforce, Path: "/fb/" + name + ".md", Projects: []string{}, WhenExists: []string{}}
	}

	t.Run("evalPreBash / evalPreEdit / evalPostEdit / evalStopCheck", func(t *testing.T) {
		WithTmp(func(dir string) {
			io := func() Io { return MakeIo(IoOpts{ProjectDir: dir, Env: EnvVars{ClaudeFeedbackDir: dir}}) }
			bad := raw("bad", []Dict{
				nil,
				{},
				{"event": "pre_bash", "when": "x(?i)y"},
				{"event": "pre_edit", "path": "**", "when": "a*+"},
				{"event": "post_edit", "path": "**", "when": "(?#c)"},
				{"event": "stop_check", "changed": []any{nil}, "check": "exit 1"},
			})
			notList := raw("not_list", nil)
			good := raw("good", []Dict{
				{"event": "pre_bash", "when": "rm"},
				{"event": "pre_edit", "path": "**", "when": "rm"},
				{"event": "post_edit", "path": "**", "when": "rm"},
				{"event": "stop_check", "changed": "**", "check": "exit 1"},
			})
			rules := []Rule{bad, notList, good}
			file := filepath.Join(dir, "a.txt")
			fbtWrite(file, "rm\n")
			assert.Equal(t, []string{"good"}, fbtViolationRules(EvalPreBash(io(), rules, "rm x")))
			assert.Equal(t, []string{"good"}, fbtViolationRules(EvalPreEdit(io(), rules, file, "rm")))
			assert.Equal(t, []string{"good"}, fbtViolationRules(EvalPostEdit(io(), rules, file)))
			assert.Equal(t, []string{"good"}, fbtViolationRules(EvalStopCheck(io(), rules, dir, []string{"a.txt"})))
			log := Read(filepath.Join(dir, ".errors.jsonl"))
			assert.Contains(t, log, `"source":"enforce"`)
			assert.Contains(t, log, `"file":"/fb/bad.md"`)
			assert.Contains(t, log, "enforce[2] の評価に失敗しました")
			assert.Contains(t, log, "enforce[3] の評価に失敗しました")
			assert.Contains(t, log, "enforce[4] の評価に失敗しました")
			assert.Contains(t, log, "enforce[5] の評価に失敗しました")
		})
	})
}

func TestNormalizeEnforce(t *testing.T) {
	io := MakeIo(IoOpts{ProjectDir: "/tmp", Lang: LangEN})

	t.Run("empty values are no entries and no problems", func(t *testing.T) {
		for _, v := range []any{nil, "", []any{}, Dict{}} {
			enforce, problems := NormalizeEnforce(io, v)
			assert.Equal(t, []Dict{}, enforce)
			assert.Equal(t, []string{}, problems)
		}
	})

	t.Run("a non-list is dropped with a reason", func(t *testing.T) {
		enforce, problems := NormalizeEnforce(io, Dict{"event": "pre_bash"})
		assert.Equal(t, []Dict{}, enforce)
		assert.Equal(t, []string{"enforce is not a list (mapping). Write each entry as `- event: ...`"}, problems)
		_, problems = NormalizeEnforce(io, "x")
		assert.Equal(t, []string{"enforce is not a list (string). Write each entry as `- event: ...`"}, problems)
	})

	t.Run("non-mapping entries and bad regexes are dropped, the rest is kept", func(t *testing.T) {
		enforce, problems := NormalizeEnforce(io, []any{
			nil,
			[]any{"x"},
			Dict{"event": "pre_bash", "when": "ok"},
			Dict{"event": "pre_edit", "path": "*", "unless": "(?x) a"},
			// stop_check は when / unless を使わないので検査しない
			Dict{"event": "stop_check", "changed": "*", "when": "a*+"},
		})
		assert.Equal(t, []Dict{
			{"event": "pre_bash", "when": "ok"},
			{"event": "stop_check", "changed": "*", "when": "a*+"},
		}, enforce)
		assert.Equal(t, []string{
			"enforce[0] is not a mapping (null)",
			"enforce[1] is not a mapping (list)",
			"enforce[3].unless is not a usable regular expression: unsupported Python inline flag (?x): (?x) a",
		}, problems)
	})
}

func TestPyRegExpPythonOnlyAnchorsAndFlags(t *testing.T) {
	// TS の pyRegExp(...).test(...) に当たるのは、JS で不正な書き方も弾く compilePyRegExp + PyMatch。
	test := func(t *testing.T, source, flags, s string) bool {
		t.Helper()
		re, err := fbCompilePyRegExp(source, flags)
		require.NoError(t, err, source)
		return PyMatch(re, s)
	}

	t.Run("\\A / \\Z / \\z match only at the start / end of the whole string, also with the m flag", func(t *testing.T) {
		assert.True(t, test(t, `\Afoo`, "m", "foo\nbar"))
		assert.False(t, test(t, `\Afoo`, "m", "bar\nfoo"))
		assert.True(t, test(t, `foo\Z`, "m", "bar\nfoo"))
		assert.False(t, test(t, `foo\Z`, "m", "foo\nbar"))
		assert.True(t, test(t, `foo\z`, "", "foo"))
		assert.True(t, test(t, `\AA\Z`, "", "A"))
		// JS のままだと \A は "A"、\Z は "Z" に一致してしまう
		assert.False(t, test(t, `x\Ay`, "", "xAy"))
	})

	t.Run("escaped backslashes and character classes are left alone", func(t *testing.T) {
		assert.True(t, test(t, `a\\Ab`, "", `a\Ab`))
		assert.True(t, test(t, `[]a]`, "", "]"))
		assert.False(t, test(t, `[^]a]`, "", "]"))
		assert.True(t, test(t, `[^]a]`, "", "b"))
	})

	t.Run("(?x) and invalid patterns throw", func(t *testing.T) {
		_, err := fbCompilePyRegExp("(?x) a b", "")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "(?x)")
		_, err = fbCompilePyRegExp("(?ix)a", "")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "(?x)")
		for _, p := range []string{"x(?i)y", "a*+", "(?#c)", "(?P>n)"} {
			_, err := fbCompilePyRegExp(p, "")
			assert.Error(t, err, p)
		}
	})
}
