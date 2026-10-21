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
