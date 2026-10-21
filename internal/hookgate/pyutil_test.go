package hookgate

import (
	"math"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTruthyPyReprToCount(t *testing.T) {
	t.Run("Truthy follows Python", func(t *testing.T) {
		for _, v := range []any{nil, false, "", 0, 0.0, []any{}, map[string]any{}} {
			assert.False(t, Truthy(v), "%v", v)
		}
		for _, v := range []any{true, "a", 1, 0.5, []any{0}, map[string]any{"a": nil}} {
			assert.True(t, Truthy(v), "%v", v)
		}
	})

	t.Run("PyRepr", func(t *testing.T) {
		assert.Equal(t, "None", PyRepr(nil))
		assert.Equal(t, "True", PyRepr(true))
		assert.Equal(t, "3", PyRepr(3.0))
		assert.Equal(t, "'a'", PyRepr("a"))
		assert.Equal(t, `"it's"`, PyRepr("it's"))
		assert.Equal(t, `'a\nb'`, PyRepr("a\nb"))
		assert.Equal(t, "['x', 1, None]", PyRepr([]any{"x", 1, nil}))
		assert.Equal(t, "{'a': 1, 'b': 'c'}", PyRepr(map[string]any{"b": "c", "a": 1}))
	})

	t.Run("ToCount", func(t *testing.T) {
		assert.Equal(t, 3, ToCount(3.9))
		assert.Equal(t, 3, ToCount(3))
		assert.Equal(t, 1, ToCount(true))
		assert.Equal(t, 5, ToCount(" +5 "))
		assert.Equal(t, 0, ToCount("x"))
		assert.Equal(t, 0, ToCount("1.5"))
		assert.Equal(t, 0, ToCount(nil))
		assert.Equal(t, 0, ToCount([]any{1}))
	})

	t.Run("Str and JSNumber follow JS", func(t *testing.T) {
		assert.Equal(t, "30", Str(30.0))
		assert.Equal(t, "1.5", Str(1.5))
		assert.Equal(t, "1e+21", Str(1e21))
		assert.Equal(t, "100000", Str(1e5))
		assert.Equal(t, "1e-7", Str(1e-7))
		assert.Equal(t, "0.000001", Str(1e-6))
		assert.Equal(t, "null", Str(nil))
		assert.Equal(t, "a,b", Str([]any{"a", "b"}))
		assert.Equal(t, "[object Object]", Str(map[string]any{}))
		assert.Equal(t, "NaN", Str(math.NaN()))
	})

	t.Run("JqStr", func(t *testing.T) {
		assert.Equal(t, "", JqStr(nil))
		assert.Equal(t, "", JqStr(false))
		assert.Equal(t, "x", JqStr("x"))
		assert.Equal(t, "3", JqStr(3.0))
		assert.Equal(t, "true", JqStr(true))
		assert.Equal(t, `["<a>"]`, JqStr([]any{"<a>"}))
	})
}

func TestPyRegExp(t *testing.T) {
	match := func(t *testing.T, pattern, flags, text string) bool {
		t.Helper()
		re, err := PyRegExp(pattern, flags)
		require.NoError(t, err)
		return PyMatch(re, text)
	}

	t.Run("lookarounds and backreferences work", func(t *testing.T) {
		assert.True(t, match(t, `foo(?=bar)`, "", "foobar"))
		assert.False(t, match(t, `foo(?!bar)`, "", "foobar"))
		assert.True(t, match(t, `(a)\1`, "", "aa"))
	})

	t.Run("inline flags and named groups", func(t *testing.T) {
		assert.True(t, match(t, `(?i)abc`, "", "xABCx"))
		assert.True(t, match(t, `(?P<x>a)(?P=x)`, "", "aa"))
		assert.True(t, match(t, `(?s)a.b`, "", "a\nb"))
		assert.False(t, match(t, `a.b`, "", "a\nb"))
		_, err := PyRegExp(`(?x) a`, "")
		assert.Error(t, err)
	})

	t.Run("\\A \\Z \\z and $ are strict end-of-string anchors; m makes ^ $ per line", func(t *testing.T) {
		assert.False(t, match(t, `foo$`, "", "foo\n"))
		assert.True(t, match(t, `foo$`, "", "foo"))
		assert.False(t, match(t, `foo\Z`, "m", "foo\nbar"))
		assert.True(t, match(t, `foo\z`, "m", "bar\nfoo"))
		assert.True(t, match(t, `^bar$`, "m", "foo\nbar\nbaz"))
		assert.False(t, match(t, `^bar$`, "", "foo\nbar\nbaz"))
		assert.False(t, match(t, `\Abar`, "m", "foo\nbar"))
		assert.True(t, match(t, `[$]`, "", "a$b"))
	})

	t.Run("a leading ] in a class is a literal", func(t *testing.T) {
		assert.True(t, match(t, `[]a]`, "", "]"))
		assert.True(t, match(t, `[^]a]b`, "", "xb"))
	})

	t.Run("invalid patterns are errors", func(t *testing.T) {
		_, err := PyRegExp(`(`, "")
		assert.Error(t, err)
	})
}

func TestPath(t *testing.T) {
	t.Run("Join / Normpath / Dirname / Basename / Splitext / Relpath / ExpandUser", func(t *testing.T) {
		assert.Equal(t, "/a/b", Join("/x", "/a", "b"))
		assert.Equal(t, "a/b", Join("a", "b"))
		assert.Equal(t, "a/b", Join("a/", "b"))
		assert.Equal(t, "/a/c", Normpath("/a/b/../c/./"))
		assert.Equal(t, "../a", Normpath("../a"))
		assert.Equal(t, ".", Normpath(""))
		assert.Equal(t, "/a", Dirname("/a/b"))
		assert.Equal(t, "/", Dirname("/a"))
		assert.Equal(t, "", Dirname("a"))
		assert.Equal(t, "b", Basename("/a/b"))
		root, ext := Splitext("/a/b.tar.gz")
		assert.Equal(t, []string{"/a/b.tar", ".gz"}, []string{root, ext})
		root, ext = Splitext("/a/.hidden")
		assert.Equal(t, []string{"/a/.hidden", ""}, []string{root, ext})
		assert.Equal(t, "../c", Relpath("/a/c", "/a/b"))
		assert.Equal(t, ".", Relpath("/a", "/a"))
		assert.Equal(t, "/h/x", ExpandUser("~/x", "/h/"))
		assert.Equal(t, "~x", ExpandUser("~x", "/h"))
		assert.Equal(t, "~/x", ExpandUser("~/x", ""))
	})

	t.Run("SplitRoot / Relativize / RootLabel", func(t *testing.T) {
		root, rel := SplitRoot("/p", "/p/.claude/worktrees/w1/src/a.go")
		assert.Equal(t, []string{"/p/.claude/worktrees/w1", "src/a.go"}, []string{root, rel})
		root, rel = SplitRoot("/p", "/p/src/a.go")
		assert.Equal(t, []string{"/p", "src/a.go"}, []string{root, rel})
		root, rel = SplitRoot("/p", "./src/a.go")
		assert.Equal(t, []string{"/p", "src/a.go"}, []string{root, rel})
		assert.Equal(t, "w1/src/a.go", RootLabel("/p/.claude/worktrees/w1", "/p", "src/a.go"))
		assert.Equal(t, "src/a.go", RootLabel("/p", "/p", "src/a.go"))
	})
}

func TestShell(t *testing.T) {
	t.Run("ShellQuote", func(t *testing.T) {
		assert.Equal(t, "''", ShellQuote(""))
		assert.Equal(t, "a/b-c.d", ShellQuote("a/b-c.d"))
		assert.Equal(t, `'a b'`, ShellQuote("a b"))
		assert.Equal(t, `'it'"'"'s'`, ShellQuote("it's"))
	})

	t.Run("ShellSplit", func(t *testing.T) {
		got, err := ShellSplit(`a "b c" 'd e' f\ g "h\"i" j"k"`)
		require.NoError(t, err)
		assert.Equal(t, []string{"a", "b c", "d e", "f g", `h"i`, "jk"}, got)
		got, err = ShellSplit("")
		require.NoError(t, err)
		assert.Empty(t, got)
		got, err = ShellSplit(`'' x`)
		require.NoError(t, err)
		assert.Equal(t, []string{"", "x"}, got)
		_, err = ShellSplit(`"abc`)
		assert.Error(t, err)
		_, err = ShellSplit(`'abc`)
		assert.Error(t, err)
		_, err = ShellSplit(`abc\`)
		assert.Error(t, err)
	})
}

// TestPyRegExpFollowsJSSemantics は mod 側（src/pyutil.ts の pyRegExp: JS の RegExp）と同じルールファイルが同じ結果になることの確認。
// 期待値は node で new RegExp(...).test(...) を実行して得た値（\w \d \b は ASCII、. は JS の改行以外、m フラグの ^ $ は
// \n \r U+2028 U+2029 の前後、\s は Unicode の空白を含む）。
func TestPyRegExpFollowsJSSemantics(t *testing.T) {
	cases := []struct {
		pattern, flags, text string
		want                 bool
	}{
		{"echo \\w+$", "", "echo \u3053\u3093\u306b\u3061\u306f", false},
		{"echo \\w+$", "", "echo hello", true},
		{"echo \\w+$", "", "echo h\u00e9llo", false},
		{"(?i)SLEEP \\d+", "", "sleep \uff11\uff10", false},
		{"(?i)SLEEP \\d+", "", "sleep 10", true},
		{"(?i)SLEEP \\d+", "", "SLEEP 5", true},
		{"TODO$", "m", "x TODO\r\nnext\r\n", true},
		{"TODO$", "m", "x TODO\nnext", true},
		{"TODO$", "m", "TODO\u2028x", true},
		{"TODO$", "m", "TODO\u2029", true},
		{"TODO$", "m", "TODOx", false},
		{"^next", "m", "x\r\nnext", true},
		{"^next", "m", "x\rnext", true},
		{"^next", "m", "x\u2028next", true},
		{"^next", "m", "x\nnext", true},
		{"^next", "m", "xnext", false},
		{"^next", "", "x\nnext", false},
		{"^next", "", "next", true},
		{"TODO$", "", "x TODO\n", false},
		{"TODO$", "", "x TODO", true},
		{"a.b", "", "a\rb", false},
		{"a.b", "", "a\nb", false},
		{"a.b", "", "a\u2028b", false},
		{"a.b", "", "a\u2029b", false},
		{"a.b", "", "a b", true},
		{"a.b", "", "a\u3042b", true},
		{"a.b", "", "a\u0085b", true},
		{"a.b", "s", "a\rb", true},
		{"a.b", "s", "a\nb", true},
		{"a.b", "s", "a\u2028b", true},
		{"a.b", "s", "a b", true},
		{"(?s)a.b", "", "a\nb", true},
		{"(?s)a.b", "", "a\rb", true},
		{"a\\sb", "", "a b", true},
		{"a\\sb", "", "a\u00a0b", true},
		{"a\\sb", "", "a\u3000b", true},
		{"a\\sb", "", "a\ufeffb", true},
		{"a\\sb", "", "a\u2003b", true},
		{"a\\sb", "", "a\u0085b", false},
		{"a\\sb", "", "a\u180eb", false},
		{"a\\sb", "", "a\nb", true},
		{"a\\sb", "", "a\u200bb", false},
		{"a\\Sb", "", "a b", false},
		{"a\\Sb", "", "a\u00a0b", false},
		{"a\\Sb", "", "axb", true},
		{"a\\Sb", "", "a\u3000b", false},
		{"a\\Sb", "", "a\u3042b", true},
		{"a[\\s]b", "", "a b", true},
		{"a[\\s]b", "", "a\u00a0b", true},
		{"a[\\s]b", "", "a\u3000b", true},
		{"a[\\s]b", "", "axb", false},
		{"a[^\\s]b", "", "a b", false},
		{"a[^\\s]b", "", "a\u00a0b", false},
		{"a[^\\s]b", "", "axb", true},
		{"a[^\\s]b", "", "a\u3042b", true},
		{"a[\\sx]b", "", "a\u3000b", true},
		{"a[\\sx]b", "", "axb", true},
		{"a[\\sx]b", "", "ayb", false},
		{"a[\\S]b", "", "a b", false},
		{"a[\\S]b", "", "axb", true},
		{"\\bfoo\\b", "", "foo", true},
		{"\\bfoo\\b", "", "\u3042foo\u3042", true},
		{"\\bfoo\\b", "", "\u00e9foo\u00e9", true},
		{"\\bfoo\\b", "", " foo ", true},
		{"\\bfoo\\b", "", "xfoo", false},
		{"\\Bfoo", "", "\u3042foo", false},
		{"\\Bfoo", "", "xfoo", true},
		{"\\Bfoo", "", " foo", false},
		{"\\W", "", "\u3042", true},
		{"\\W", "", "a", false},
		{"\\W", "", " ", true},
		{"\\D", "", "\uff11", true},
		{"\\D", "", "1", false},
		{"\\D", "", "a", true},
		{"\\d{2,}", "", "12", true},
		{"\\d{2,}", "", "1", false},
		{"\\d{2,}", "", "\uff11\uff12", false},
		{"\\d{2,}", "", "a123", true},
		{"(a)\\1", "", "aa", true},
		{"(a)\\1", "", "ab", false},
		{"(?<n>a)\\k<n>", "", "aa", true},
		{"(?<n>a)\\k<n>", "", "ab", false},
		{"(?P<n>a)(?P=n)", "", "aa", true},
		{"(?P<n>a)(?P=n)", "", "ab", false},
		{"\\x41", "", "A", true},
		{"\\x41", "", "a", false},
		{"\u3042", "", "\u3042", true},
		{"\u3042", "", "ab", false},
		{"\u3042+", "i", "\u3042\u3042\u3042", true},
		{"(?=foo)f", "", "foo", true},
		{"(?<=a)b", "", "ab", true},
		{"(?<=a)b", "", "cb", false},
		{"(?<!a)b", "", "ab", false},
		{"(?<!a)b", "", "cb", true},
		{"(?i)abc", "", "ABC", true},
		{"(?i)abc", "", "abc", true},
		{"(?m)^b$", "", "a\nb\nc", true},
		{"(?m)^b$", "", "a\r\nb\r\nc", true},
		{"(?s)a.b", "m", "a\nb", true},
		{"(?ims)A.B$", "", "xa\nb", true},
		{"abc", "i", "ABC", true},
		{"abc", "i", "aBc", true},
		{"\\Afoo", "m", "foo\nbar", true},
		{"\\Afoo", "m", "bar\nfoo", false},
		{"foo\\Z", "m", "bar\nfoo", true},
		{"foo\\Z", "m", "foo\nbar", false},
		{"x\\Ay", "", "xAy", false},
		{"a\\\\Ab", "", "a\\Ab", true},
		{"[\\Z]", "", "Z", true},
		{"[\\Z]", "", "\\", false},
		{"\\a", "", "a", true},
		{"\\a", "", "\u0007", false},
		{"\\e", "", "e", true},
		{"\\e", "", "\u001b", false},
		{"\\p{L}", "", "p{L}", true},
		{"\\p{L}", "", "a", false},
		{"\\_", "", "_", true},
		{"\\-", "", "-", true},
		{"\\/", "", "/", true},
		{"\\\u3042", "", "\u3042", true},
		{"\\0", "", "\u0000", true},
		{"\\0", "", "0", false},
		{"\\1", "", "\u0001", true},
		{"\\1", "", "1", false},
		{"(a)\\2", "", "a\u0002", true},
		{"(a)\\2", "", "a2", false},
		{"\\cJ", "", "\n", true},
		{"\\u3042", "", "\u3042", true},
		{"\\u{3042}", "", "\u3042", false},
		{"\\x4", "", "x4", true},
		{"a{,3}", "", "a{,3}", true},
		{"a{,3}", "", "a", false},
		{"a{", "", "a{", true},
		{"{", "", "{", true},
		{"}", "", "}", true},
		{"]", "", "]", true},
		{"a]", "", "a]", true},
		{"[a-z-[b]]", "", "a]", true},
		{"[a-z-[b]]", "", "b]", true},
		{"[a-z-[b]]", "", "c", false},
		{"[[]", "", "[", true},
		{"[a[]", "", "[", true},
		{"[a[]", "", "a", true},
		{"[\\d-z]", "", "5", true},
		{"[\\d-z]", "", "-", true},
		{"[\\d-z]", "", "z", true},
		{"[\\w-.]", "", "a", true},
		{"[\\w-.]", "", "-", true},
		{"[\\w-.]", "", ".", true},
		{"^$", "", "", true},
		{"^$", "m", "a\n\nb", true},
		{"^", "m", "", true},
		{"$", "m", "a\r", true},
		{"(?:(a)|b)\\1", "", "b", true},
		{"(?:(a)|b)\\1", "", "aa", true},
		{"(a*)*b", "", "aaab", true},
		{"(a|ab)(c|bcd)(d*)", "", "abcd", true},
		{"(?:)", "", "x", true},
		{"a|", "", "x", true},
		{"\\bsleep\\s+\\d+\\b", "i", "Sleep\u300010", true},
		{"\\bsleep\\s+\\d+\\b", "i", "sleep 10", true},
		{"\\bsleep\\s+\\d+\\b", "i", "sleep\u00a010", true},
		{"^\\s*$", "m", "a\n\u3000\nb", true},
		{"^\\s*$", "m", "a\n \nb", true},
		{"[^\\n]*$", "", "abc\n", true},
		{"[^\\n]*$", "", "abc", true},
		{"\\n", "", "\n", true},
		{"[\\b]", "", "\b", true},
		{"\\B", "", "ab", true},
		{"\\B", "", "", true},
		{"[\\B]", "", "B", true},
		{"\\$", "", "$", true},
		{"\\^", "", "^", true},
		{"[$^]", "m", "^", true},
		{"[$^]", "m", "$", true},
		{"\\.", "", ".", true},
		{"[^a]", "i", "A", false},
		{"(?i)[\u00e0-\u00fd]", "", "\u00c0", true},
		{"\\S+@\\S+", "", "a@b", true},
		{"\\S+@\\S+", "", "\u3042@\u3044", true},
		{"\\t", "", "\t", true},
		{"\\v", "", "\u000b", true},
		{"\\f", "", "\f", true},
		{"\\r$", "m", "a\r\nb", true},
		{"a$\\n", "m", "a\nb", true},
		{"(?<=^)a", "m", "x\na", true},
		{"(?<!^)a", "m", "x\na", false},
		{"(?<!^)a", "m", "xa", true},
		{"foo(?=$)", "m", "foo\r\n", true},
		{"^foo", "im", "x\r\nFOO", true},
		{"x*", "m", "", true},
		{"a\\sb", "s", "a\u3000b", true},
		{"\\d", "i", "\uff11", false},
		{"[\\d]", "", "\uff11", false},
		{"[\\d]", "", "1", true},
		{"[\\w]", "", "\u3042", false},
		{"[\\w]", "", "a", true},
		{"[\\W]", "", "\u3042", true},
		{"[\\W]", "", "a", false},
		{"[\\D]", "", "\uff11", true},
		{"(?<a>x)|(?<a2>y)", "", "y", true},
		{"(?<=\\w)(?=\\W)", "", "a\u3042", true},
		{"\\k", "", "k", true},
		{"\\k<n>", "", "k<n>", true},
	}
	for _, c := range cases {
		re, err := fbCompilePyRegExp(c.pattern, c.flags)
		require.NoError(t, err, "%q", c.pattern)
		assert.Equal(t, c.want, PyMatch(re, c.text), "/%s/%s.test(%q)", c.pattern, c.flags, c.text)
	}
}

// 次の書き方は意図して JS と一致させていない（TestPyRegExpFollowsJSSemantics には入れない）:
// 文字列は UTF-16 ではなくコードポイントで扱う（. が絵文字 1 文字に一致する）、i フラグの大文字小文字の同一視は
// Unicode の単純畳み込み（K ケルビン記号 = k、ß = ẞ）、名前付きグループと名前無しグループを混ぜたときの \N の番号。
