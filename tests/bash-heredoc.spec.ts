// src/bash-heredoc.ts: Bash コマンドの文面から heredoc の書き込み（書き先と本文）を取り出す。
import { describe, expect, test } from 'bun:test'
import { heredocWrites, tokenizeLine } from '../src/bash-heredoc.ts'

const CWD = '/work/proj'
const writes = (command: string, home?: string) => heredocWrites(command, CWD, home)

describe('tokenizeLine', () => {
  test('splits words, quotes and redirections', () => {
    const toks = tokenizeLine(`cat > "my file.txt" <<'EOF' 2>&1 # comment`)
    expect(toks.map((t) => `${t.kind}:${t.text}`)).toEqual(['word:cat', 'op:>', 'word:my file.txt', 'op:<<', 'word:EOF', 'op:fd', 'word:1'])
    expect(toks[2]?.quoted).toBe(true)
    expect(toks[4]?.quoted).toBe(true)
  })

  test('marks words that bash would expand as dynamic', () => {
    const toks = tokenizeLine('cat > $OUT <<EOF; cat > "a$(x)" <<EOF; cat > \'$lit\' <<EOF')
    const targets = toks.filter((_t, i) => toks[i - 1]?.text === '>')
    expect(targets.map((t) => t.dynamic)).toEqual([true, true, false])
  })
})

describe('heredocWrites', () => {
  test('cat with > and a quoted delimiter', () => {
    expect(writes("cat > src/a.ts <<'EOF'\nconst x: any = 1\nexport {}\nEOF\n")).toEqual([
      { file: '/work/proj/src/a.ts', content: 'const x: any = 1\nexport {}\n', append: false },
    ])
  })

  test('redirection after the heredoc operator, >> is an append', () => {
    expect(writes('cat <<EOF >> notes.md\nline\nEOF')).toEqual([{ file: '/work/proj/notes.md', content: 'line\n', append: true }])
    expect(writes('cat - <<"EOF" >/abs/path.txt\nx\nEOF')).toEqual([{ file: '/abs/path.txt', content: 'x\n', append: false }])
    expect(writes('cat <<\\EOF > a.txt\n$notexpanded\nEOF')).toEqual([{ file: '/work/proj/a.txt', content: '$notexpanded\n', append: false }])
  })

  test('<<- strips leading tabs from the body and the terminator', () => {
    expect(writes('cat > a.txt <<-EOF\n\t\tindented\n\tEOF')).toEqual([{ file: '/work/proj/a.txt', content: 'indented\n', append: false }])
  })

  test('tee, with and without -a, and a tee after a pipe', () => {
    expect(writes('tee a.txt <<EOF\nx\nEOF')).toEqual([{ file: '/work/proj/a.txt', content: 'x\n', append: false }])
    expect(writes('tee -a a.txt b.txt <<EOF\nx\nEOF')).toEqual([
      { file: '/work/proj/a.txt', content: 'x\n', append: true },
      { file: '/work/proj/b.txt', content: 'x\n', append: true },
    ])
    expect(writes('cat <<EOF | tee a.txt | tee -a b.txt\nx\nEOF')).toEqual([
      { file: '/work/proj/a.txt', content: 'x\n', append: false },
      { file: '/work/proj/b.txt', content: 'x\n', append: true },
    ])
  })

  test('several heredocs in one command, the same file twice is joined', () => {
    const cmd = ["cat > a.go <<'EOF'", 'package a', 'EOF', "cat > a_test.go <<'EOF'", 'package a', 'EOF', 'cat >> a.go <<EOF', 'func f() {}', 'EOF'].join('\n')
    expect(writes(cmd)).toEqual([
      { file: '/work/proj/a.go', content: 'package a\nfunc f() {}\n', append: false },
      { file: '/work/proj/a_test.go', content: 'package a\n', append: false },
    ])
  })

  test('commands chained with && and ; on the heredoc line', () => {
    expect(writes("mkdir -p src && cat > src/a.ts <<'EOF' && echo done\nexport {}\nEOF")).toEqual([
      { file: '/work/proj/src/a.ts', content: 'export {}\n', append: false },
    ])
  })

  test('~ is expanded only when HOME is known', () => {
    expect(writes('cat > ~/notes.txt <<EOF\nx\nEOF', '/home/me')).toEqual([{ file: '/home/me/notes.txt', content: 'x\n', append: false }])
    expect(writes('cat > ~/notes.txt <<EOF\nx\nEOF')).toEqual([])
  })

  test('targets that are not known before the command runs are skipped', () => {
    expect(writes('cat > $OUT <<EOF\nx\nEOF')).toEqual([])
    expect(writes('cat > "$(mktemp)" <<EOF\nx\nEOF')).toEqual([])
    expect(writes('cat > `mktemp` <<EOF\nx\nEOF')).toEqual([])
    expect(writes('cat <<EOF > /dev/null\nx\nEOF')).toEqual([])
    expect(writes('cat <<EOF\nx\nEOF')).toEqual([])
  })

  test('commands that transform the body are skipped', () => {
    expect(writes("python - <<'EOF'\nopen('a.txt', 'w').write('x')\nEOF")).toEqual([])
    expect(writes("sed 's/a/b/' > out.txt <<EOF\nabc\nEOF")).toEqual([])
    expect(writes('cat <<EOF | sort > out.txt\nb\na\nEOF')).toEqual([])
    expect(writes('cat -n > out.txt <<EOF\nx\nEOF')).toEqual([])
    expect(writes('cat <<EOF | tee a.txt | sort > b.txt\nx\nEOF')).toEqual([{ file: '/work/proj/a.txt', content: 'x\n', append: false }])
  })

  test('an unterminated heredoc and a here-string are skipped', () => {
    expect(writes("cat > src/a.ts <<'EOF' ... EOF")).toEqual([])
    expect(writes('cat > a.txt <<EOF\nx')).toEqual([])
    expect(writes('cat > a.txt <<< "x"')).toEqual([])
  })

  test('fd redirections are not targets', () => {
    expect(writes('cat <<EOF 2>err.log\nx\nEOF')).toEqual([])
    expect(writes('cat <<EOF > a.txt 2>&1\nx\nEOF')).toEqual([{ file: '/work/proj/a.txt', content: 'x\n', append: false }])
    expect(writes('cat <<EOF &> a.txt\nx\nEOF')).toEqual([{ file: '/work/proj/a.txt', content: 'x\n', append: false }])
  })
})
