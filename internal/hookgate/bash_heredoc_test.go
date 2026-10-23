package hookgate

// tests/bash-heredoc.spec.ts の移植。

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

const bhtCwd = "/work/proj"

func bhtWrites(command string) []HeredocWrite { return HeredocWrites(command, bhtCwd, "") }

func TestTokenizeLine(t *testing.T) {
	t.Run("splits words, quotes and redirections", func(t *testing.T) {
		toks := TokenizeLine(`cat > "my file.txt" <<'EOF' 2>&1 # comment`)
		got := make([]string, len(toks))
		for i, tk := range toks {
			got[i] = tk.kind + ":" + tk.text
		}
		assert.Equal(t, []string{"word:cat", "op:>", "word:my file.txt", "op:<<", "word:EOF", "op:fd", "word:1"}, got)
		assert.True(t, toks[2].quoted)
		assert.True(t, toks[4].quoted)
	})

	t.Run("marks words that bash would expand as dynamic", func(t *testing.T) {
		toks := TokenizeLine("cat > $OUT <<EOF; cat > \"a$(x)\" <<EOF; cat > '$lit' <<EOF")
		got := []bool{}
		for i, tk := range toks {
			if i > 0 && toks[i-1].text == ">" {
				got = append(got, tk.dynamic)
			}
		}
		assert.Equal(t, []bool{true, true, false}, got)
	})
}

func TestHeredocWrites(t *testing.T) {
	w := func(file, content string, appendMode bool) HeredocWrite {
		return HeredocWrite{File: file, Content: content, Append: appendMode}
	}

	t.Run("cat with > and a quoted delimiter", func(t *testing.T) {
		assert.Equal(t, []HeredocWrite{w("/work/proj/src/a.ts", "const x: any = 1\nexport {}\n", false)},
			bhtWrites("cat > src/a.ts <<'EOF'\nconst x: any = 1\nexport {}\nEOF\n"))
	})

	t.Run("redirection after the heredoc operator, >> is an append", func(t *testing.T) {
		assert.Equal(t, []HeredocWrite{w("/work/proj/notes.md", "line\n", true)}, bhtWrites("cat <<EOF >> notes.md\nline\nEOF"))
		assert.Equal(t, []HeredocWrite{w("/abs/path.txt", "x\n", false)}, bhtWrites("cat - <<\"EOF\" >/abs/path.txt\nx\nEOF"))
		assert.Equal(t, []HeredocWrite{w("/work/proj/a.txt", "$notexpanded\n", false)}, bhtWrites("cat <<\\EOF > a.txt\n$notexpanded\nEOF"))
	})

	t.Run("<<- strips leading tabs from the body and the terminator", func(t *testing.T) {
		assert.Equal(t, []HeredocWrite{w("/work/proj/a.txt", "indented\n", false)}, bhtWrites("cat > a.txt <<-EOF\n\t\tindented\n\tEOF"))
	})

	t.Run("tee, with and without -a, and a tee after a pipe", func(t *testing.T) {
		assert.Equal(t, []HeredocWrite{w("/work/proj/a.txt", "x\n", false)}, bhtWrites("tee a.txt <<EOF\nx\nEOF"))
		assert.Equal(t, []HeredocWrite{w("/work/proj/a.txt", "x\n", true), w("/work/proj/b.txt", "x\n", true)}, bhtWrites("tee -a a.txt b.txt <<EOF\nx\nEOF"))
		assert.Equal(t, []HeredocWrite{w("/work/proj/a.txt", "x\n", false), w("/work/proj/b.txt", "x\n", true)}, bhtWrites("cat <<EOF | tee a.txt | tee -a b.txt\nx\nEOF"))
	})

	t.Run("several heredocs in one command, the same file twice is joined", func(t *testing.T) {
		cmd := strings.Join([]string{"cat > a.go <<'EOF'", "package a", "EOF", "cat > a_test.go <<'EOF'", "package a", "EOF", "cat >> a.go <<EOF", "func f() {}", "EOF"}, "\n")
		assert.Equal(t, []HeredocWrite{w("/work/proj/a.go", "package a\nfunc f() {}\n", false), w("/work/proj/a_test.go", "package a\n", false)}, bhtWrites(cmd))
	})

	t.Run("commands chained with && and ; on the heredoc line", func(t *testing.T) {
		assert.Equal(t, []HeredocWrite{w("/work/proj/src/a.ts", "export {}\n", false)}, bhtWrites("mkdir -p src && cat > src/a.ts <<'EOF' && echo done\nexport {}\nEOF"))
	})

	t.Run("~ is expanded only when HOME is known", func(t *testing.T) {
		assert.Equal(t, []HeredocWrite{w("/home/me/notes.txt", "x\n", false)}, HeredocWrites("cat > ~/notes.txt <<EOF\nx\nEOF", bhtCwd, "/home/me"))
		assert.Equal(t, []HeredocWrite{}, bhtWrites("cat > ~/notes.txt <<EOF\nx\nEOF"))
	})

	t.Run("targets that are not known before the command runs are skipped", func(t *testing.T) {
		for _, cmd := range []string{"cat > $OUT <<EOF\nx\nEOF", "cat > \"$(mktemp)\" <<EOF\nx\nEOF", "cat > `mktemp` <<EOF\nx\nEOF", "cat <<EOF > /dev/null\nx\nEOF", "cat <<EOF\nx\nEOF"} {
			assert.Equal(t, []HeredocWrite{}, bhtWrites(cmd), cmd)
		}
	})

	t.Run("commands that transform the body are skipped", func(t *testing.T) {
		for _, cmd := range []string{"python - <<'EOF'\nopen('a.txt', 'w').write('x')\nEOF", "sed 's/a/b/' > out.txt <<EOF\nabc\nEOF", "cat <<EOF | sort > out.txt\nb\na\nEOF", "cat -n > out.txt <<EOF\nx\nEOF"} {
			assert.Equal(t, []HeredocWrite{}, bhtWrites(cmd), cmd)
		}
		assert.Equal(t, []HeredocWrite{w("/work/proj/a.txt", "x\n", false)}, bhtWrites("cat <<EOF | tee a.txt | sort > b.txt\nx\nEOF"))
	})

	t.Run("an unterminated heredoc and a here-string are skipped", func(t *testing.T) {
		for _, cmd := range []string{"cat > src/a.ts <<'EOF' ... EOF", "cat > a.txt <<EOF\nx", "cat > a.txt <<< \"x\""} {
			assert.Equal(t, []HeredocWrite{}, bhtWrites(cmd), cmd)
		}
	})

	t.Run("fd redirections are not targets", func(t *testing.T) {
		assert.Equal(t, []HeredocWrite{}, bhtWrites("cat <<EOF 2>err.log\nx\nEOF"))
		assert.Equal(t, []HeredocWrite{w("/work/proj/a.txt", "x\n", false)}, bhtWrites("cat <<EOF > a.txt 2>&1\nx\nEOF"))
		assert.Equal(t, []HeredocWrite{w("/work/proj/a.txt", "x\n", false)}, bhtWrites("cat <<EOF &> a.txt\nx\nEOF"))
	})
}
