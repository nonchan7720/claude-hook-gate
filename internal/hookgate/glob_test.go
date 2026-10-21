package hookgate

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func globMatches(t *testing.T, pattern, p string) bool {
	t.Helper()
	rxs, err := CompileGlobs([]string{pattern})
	require.NoError(t, err)
	for _, rx := range rxs {
		if rx.MatchString(p) {
			return true
		}
	}
	return false
}

func TestGlobSemantics(t *testing.T) {
	t.Run("* does not cross /, ** does, **/ allows zero levels", func(t *testing.T) {
		assert.True(t, globMatches(t, "*.go", "foo.go"))
		assert.False(t, globMatches(t, "*.go", "pkg/foo.go"))
		assert.True(t, globMatches(t, "**/*.go", "foo.go"))
		assert.True(t, globMatches(t, "**/*.go", "a/b/foo.go"))
		assert.True(t, globMatches(t, "pkg/**", "pkg/a/b.go"))
	})

	t.Run("? and character classes", func(t *testing.T) {
		assert.True(t, globMatches(t, "a?.txt", "ab.txt"))
		assert.False(t, globMatches(t, "a?.txt", "a/.txt"))
		assert.True(t, globMatches(t, "[ab].txt", "a.txt"))
		assert.True(t, globMatches(t, "[!ab].txt", "c.txt"))
		assert.False(t, globMatches(t, "[!ab].txt", "a.txt"))
	})

	t.Run("brace expansion, including nesting and a single alternative", func(t *testing.T) {
		assert.Equal(t, []string{"a.yml", "a.yaml"}, ExpandBraces("a.{yml,yaml}"))
		assert.Equal(t, []string{"ax", "bcx", "bdx"}, ExpandBraces("{a,b{c,d}}x"))
		assert.Equal(t, []string{"only"}, ExpandBraces("{only}"))
		pairs, err := MatchPatterns([]string{"pkg/{a,b}/**"})
		require.NoError(t, err)
		var texts []string
		for _, p := range pairs {
			texts = append(texts, p.Text)
		}
		assert.Equal(t, []string{"pkg/a/**", "pkg/b/**"}, texts)
	})

	t.Run("regex metacharacters in literals are escaped", func(t *testing.T) {
		rxs, err := CompileGlobs([]string{"a+b(c).go"})
		require.NoError(t, err)
		assert.True(t, rxs[0].MatchString("a+b(c).go"))
		assert.False(t, rxs[0].MatchString("aab(c).go"))
	})

	t.Run("non-ASCII literals are matched as-is", func(t *testing.T) {
		assert.True(t, globMatches(t, "docs/日本語*.md", "docs/日本語メモ.md"))
	})

	t.Run("an unclosed character class is an error", func(t *testing.T) {
		_, err := CompileGlobs([]string{"[abc"})
		assert.Error(t, err)
	})
}

// tests/glob.spec.ts の "differences from picomatch" は汎用ライブラリ picomatch との比較なので移植しない。
// 自前実装が picomatch と違う点だけを固定する（Go 版に picomatch は無い）。
func TestGlobOwnBehaviour(t *testing.T) {
	t.Run("** inside a segment crosses directories", func(t *testing.T) {
		assert.True(t, globMatches(t, "a**b", "a/x/b"))
	})

	t.Run("a single-alternative brace is unwrapped", func(t *testing.T) {
		assert.Equal(t, []string{"stem_test.go"}, ExpandBraces("{stem}_test.go"))
	})

	t.Run("the common patterns", func(t *testing.T) {
		for _, c := range []struct {
			pattern, path string
			want          bool
		}{
			{"**/*.go", "a/b/c.go", true},
			{"**/*.go", "c.go", true},
			{"*.md", "README.md", true},
			{"*.md", "docs/README.md", false},
			{"pkg/{domain,infrastructure}/**", "pkg/domain/x.go", true},
			{"pkg/{domain,infrastructure}/**", "pkg/other/x.go", false},
			{"**/*_test.go", "pkg/a_test.go", true},
			{"**/README.md", "README.md", true},
		} {
			assert.Equal(t, c.want, globMatches(t, c.pattern, c.path), "%s %s", c.pattern, c.path)
		}
	})
}

func TestGlobExists(t *testing.T) {
	t.Run("literal, wildcard and recursive patterns", func(t *testing.T) {
		WithTmp(func(dir string) {
			io := MakeIo(IoOpts{ProjectDir: dir})
			Touch(dir, "spec", "models", "user_spec.rb")
			Touch(dir, "lib", "a.rb")
			assert.True(t, GlobExists(io, dir+"/spec/**/user_spec.rb"))
			assert.True(t, GlobExists(io, dir+"/spec/*/user_spec.rb"))
			assert.False(t, GlobExists(io, dir+"/spec/*.rb"))
			assert.True(t, GlobExists(io, dir+"/lib/a.rb"))
			assert.False(t, GlobExists(io, dir+"/lib/b.rb"))
			assert.False(t, GlobExists(io, dir+"/nope/**/x.rb"))
		})
	})

	t.Run("hidden entries are not matched by wildcards unless the pattern says so", func(t *testing.T) {
		WithTmp(func(dir string) {
			io := MakeIo(IoOpts{ProjectDir: dir})
			Touch(filepath.Join(dir, ".hidden"), "x_spec.rb")
			assert.False(t, GlobExists(io, dir+"/**/x_spec.rb"))
			assert.True(t, GlobExists(io, dir+"/.hidden/x_spec.rb"))
			assert.True(t, GlobExists(io, dir+"/.h*/x_spec.rb"))
		})
	})
}
