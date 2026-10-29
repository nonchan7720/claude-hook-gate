package hookgate

// Bash コマンドのうち、実行前に「どのファイルに何を書くか」が文面から分かる heredoc の書き込みを取り出す（src/bash-heredoc.ts）。
// PreToolUse(Bash) で Edit / Write と同じ pre_edit の検査（feedback_guard.go）を掛け、PostToolUse(Bash) の
// 実行後の pre_edit（feedback_bash_edit.go）はこれらのファイルを飛ばす（二重に判定しない）ため。
//
// 拾う形（`<<` の直後の `-` と、区切り語の引用 'EOF' / "EOF" / \EOF はどれでもよい）:
//
//	cat > path <<'EOF' ... EOF        cat <<EOF >> path ... EOF        cat - <<EOF > path
//	tee path <<EOF / tee -a path <<EOF
//	cat <<EOF | tee path [| tee -a other] ... EOF
//
// 本文は区切り行まで（`<<-` なら各行の先頭のタブを落とす）で、Write の content と同じく書かれる内容そのもの。
// 区切り語が引用されていない heredoc の `$VAR` や `$(...)` は bash が展開するが、ここでは文面のまま扱う。
//
// 拾わないもの（PostToolUse の実行後の検査に任せる）:
//   - 書き先が `$VAR` / `$(...)` / バッククォートを含む、`~` で始まる（HOME が分からないとき）、/dev/null
//   - 本文を加工するコマンド（`sed ... <<EOF > out`、`cat <<EOF | sort > out`、`python - <<EOF` など）
//   - 区切り行が見つからない heredoc
//   - `cd dir && cat > rel <<EOF` の cd（相対パスは常にコマンドの cwd 起点とみなす）

import (
	"regexp"
	"strings"
)

// HeredocWrite は heredoc による 1 ファイルへの書き込み。
type HeredocWrite struct {
	// File は書き先の絶対パス。
	File string
	// Content は書かれる内容（heredoc の本文。各行に改行付き）。
	Content string
	// Append は `>>` / `tee -a` による追記か。
	Append bool
}

type bhTok struct {
	kind    string // "word" | "op"
	text    string
	dynamic bool
	quoted  bool
}

var bhSplitOps = bashSet("|", "||", "&&", ";", "&", "(", ")")

var bhDigitsRe = regexp.MustCompile(`^\d+$`)

// bhTokenizer は 1 行の字句分解の状態（TokenizeLine）。
type bhTokenizer struct {
	line    string
	i       int
	toks    []bhTok
	word    strings.Builder
	dynamic bool
	quoted  bool
	has     bool
}

func (z *bhTokenizer) at(i int) byte {
	if i < len(z.line) {
		return z.line[i]
	}
	return 0
}

func (z *bhTokenizer) flush() {
	if z.has {
		z.toks = append(z.toks, bhTok{kind: "word", text: z.word.String(), dynamic: z.dynamic, quoted: z.quoted})
	}
	z.word.Reset()
	z.dynamic, z.quoted, z.has = false, false, false
}

func (z *bhTokenizer) op(text string) { z.toks = append(z.toks, bhTok{kind: "op", text: text}) }

// singleQuoted は '...' を語に足す（閉じていなければ行末まで）。
func (z *bhTokenizer) singleQuoted() {
	end := strings.IndexByte(z.line[z.i+1:], '\'')
	if end == -1 {
		z.word.WriteString(z.line[z.i+1:])
		z.i = len(z.line)
	} else {
		z.word.WriteString(z.line[z.i+1 : z.i+1+end])
		z.i = z.i + 1 + end + 1
	}
	z.has, z.quoted = true, true
}

// doubleQuoted は "..." を語に足す。`$` / バッククォートがあれば展開される語（dynamic）。
func (z *bhTokenizer) doubleQuoted() {
	z.i++
	for z.i < len(z.line) && z.line[z.i] != '"' {
		if z.line[z.i] == '\\' && z.i+1 < len(z.line) {
			z.i++
		} else if z.line[z.i] == '$' || z.line[z.i] == '`' {
			z.dynamic = true
		}
		z.word.WriteByte(z.line[z.i])
		z.i++
	}
	z.i++
	z.has, z.quoted = true, true
}

// redirect は `<` / `>` から始まる演算子（<、<<、<<-、<<<、>、>>、記述子の複製）を読む。
func (z *bhTokenizer) redirect(c byte) {
	// 直前に付いた数字はファイル記述子（2> など）: その語は捨て、リダイレクトは対象外にする
	fd := z.has && bhDigitsRe.MatchString(z.word.String())
	if fd {
		z.word.Reset()
		z.has = false
	} else {
		z.flush()
	}
	if c == '<' && z.at(z.i+1) == '<' {
		z.heredocOp()
		return
	}
	text := string(c)
	z.i++
	if c == '>' && z.at(z.i) == '>' {
		text = ">>"
		z.i++
	}
	if z.at(z.i) == '&' {
		// `>&2` / `>&-`: 記述子の複製。次の語は書き先ではない
		text = "fd"
		z.i++
	} else if fd {
		text = "fd"
	}
	z.op(text)
}

// heredocOp は `<<`、`<<-`、`<<<`（here-string）を読む。
func (z *bhTokenizer) heredocOp() {
	if z.at(z.i+2) == '<' {
		z.op("<<<")
		z.i += 3
		return
	}
	z.i += 2
	if z.at(z.i) == '-' {
		z.op("<<-")
		z.i++
	} else {
		z.op("<<")
	}
}

// ampRedirect は `&> path` / `&>> path`（stdout と stderr をまとめて書く。内容は本文のままなので対象にする）を読む。
func (z *bhTokenizer) ampRedirect() {
	z.flush()
	z.i += 2
	if z.at(z.i) == '>' {
		z.op(">>")
		z.i++
	} else {
		z.op(">")
	}
}

// control は `|` / `||` / `&` / `&&` / `;` / `(` / `)` を読む。
func (z *bhTokenizer) control(c byte) {
	z.flush()
	if (c == '|' || c == '&') && z.at(z.i+1) == c {
		z.op(string(c) + string(c))
		z.i += 2
	} else {
		z.op(string(c))
		z.i++
	}
}

// TokenizeLine は 1 行をクォートを考慮して語と演算子に分ける。クォートは外し、`$` / バッククォートを含む（展開される）語は dynamic。
func TokenizeLine(line string) []bhTok {
	z := &bhTokenizer{line: line, toks: []bhTok{}}
	for z.i < len(line) {
		c := line[z.i]
		switch {
		case c == ' ' || c == '\t':
			z.flush()
			z.i++
		case c == '#' && !z.has:
			z.i = len(line)
		case c == '\'':
			z.singleQuoted()
		case c == '"':
			z.doubleQuoted()
		case c == '\\':
			if z.i+1 < len(line) {
				z.word.WriteByte(line[z.i+1])
			}
			z.has, z.quoted = true, true // `\EOF` は引用扱い
			z.i += 2
		case c == '<' || c == '>':
			z.redirect(c)
		case c == '&' && z.at(z.i+1) == '>':
			z.ampRedirect()
		case c == '|' || c == '&' || c == ';' || c == '(' || c == ')':
			z.control(c)
		default:
			if c == '$' || c == '`' {
				z.dynamic = true
			}
			z.word.WriteByte(c)
			z.has = true
			z.i++
		}
	}
	z.flush()
	return z.toks
}

type bhHeredoc struct {
	delim      string
	stripTabs  bool
	content    string
	terminated bool
}

type bhRedirect struct {
	append bool
	target bhTok
}

type bhSegment struct {
	sep       string
	words     []bhTok
	redirects []bhRedirect
	heredocs  []*bhHeredoc
}

// bhSegmentsOf は 1 行の語を `|` / `&&` / `||` / `;` / `&` / `(` / `)` で区切り、各区切りの語・リダイレクト・heredoc に分ける。
func bhSegmentsOf(toks []bhTok) []*bhSegment {
	segs := []*bhSegment{}
	cur := &bhSegment{}
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t.kind == "word" {
			cur.words = append(cur.words, t)
			continue
		}
		if bhSplitOps[t.text] {
			segs = append(segs, cur)
			cur = &bhSegment{sep: t.text}
			continue
		}
		var arg *bhTok
		if i+1 < len(toks) && toks[i+1].kind == "word" {
			arg = &toks[i+1]
			i++
		}
		switch t.text {
		case "<<", "<<-":
			if arg != nil {
				cur.heredocs = append(cur.heredocs, &bhHeredoc{delim: arg.text, stripTabs: t.text == "<<-"})
			}
		case ">", ">>":
			if arg != nil {
				cur.redirects = append(cur.redirects, bhRedirect{append: t.text == ">>", target: *arg})
			}
		}
		// `<`, `<<<`, `fd`: 引数を読み飛ばすだけ
	}
	segs = append(segs, cur)
	return segs
}

func bhNameOf(words []bhTok) string {
	if len(words) == 0 {
		return ""
	}
	t := words[0].text
	if i := strings.LastIndex(t, "/"); i >= 0 {
		return t[i+1:]
	}
	return t
}

// bhIsPlainCat は `cat` が本文をそのまま流すか（`-` / `--` 以外の引数やオプションがあれば加工されうる）。
func bhIsPlainCat(words []bhTok) bool {
	if bhNameOf(words) != "cat" {
		return false
	}
	for _, w := range words[1:] {
		if w.text != "-" && w.text != "--" {
			return false
		}
	}
	return true
}

var bhTeeFlags = bashSet("-i", "--ignore-interrupts", "-p", "--output-error")

// bhTeeTargets は `tee` の書き先（オプション以外の引数）と追記かどうか。tee でなければ 3 つ目が false。
func bhTeeTargets(words []bhTok) ([]bhTok, bool, bool) {
	if bhNameOf(words) != "tee" {
		return nil, false, false
	}
	var targets []bhTok
	appendMode := false
	for _, w := range words[1:] {
		switch {
		case w.text == "-a" || w.text == "--append":
			appendMode = true
		case bhTeeFlags[w.text] || strings.HasPrefix(w.text, "--output-error="):
		case strings.HasPrefix(w.text, "-") && !w.quoted && w.text != "-":
			return nil, false, false // 知らないオプション
		default:
			targets = append(targets, w)
		}
	}
	return targets, appendMode, true
}

// bhResolveTarget は書き先の語を絶対パスにする。展開される語・/dev/null・HOME 無しの `~` は ok=false。
func bhResolveTarget(t bhTok, cwd, home string) (string, bool) {
	if t.dynamic || t.text == "" || t.text == "/dev/null" || t.text == "-" {
		return "", false
	}
	p := t.text
	if strings.HasPrefix(p, "~") {
		if home == "" {
			return "", false
		}
		p = ExpandUser(p, home)
	}
	if !IsAbsolute(p) {
		p = Join(cwd, p)
	}
	return p, true
}

// HeredocWrites は command に書かれた heredoc の書き込みを、書き先ごとにまとめて返す（出現順。同じファイルへ複数回書く場合は
// 内容を順につなぐ）。相対パスは cwd 起点。
func HeredocWrites(command, cwd, home string) []HeredocWrite {
	lines := strings.Split(command, "\n")
	out := []HeredocWrite{}
	add := func(file, content string, appendMode bool) {
		for i := range out {
			if out[i].File == file {
				out[i].Content += content
				return
			}
		}
		out = append(out, HeredocWrite{File: file, Content: content, Append: appendMode})
	}

	i := 0
	for i < len(lines) {
		segs := bhSegmentsOf(TokenizeLine(lines[i]))
		next := i + 1
	heredocs:
		for _, seg := range segs {
			for _, h := range seg.heredocs {
				var body strings.Builder
				for next < len(lines) {
					l := lines[next]
					if h.stripTabs {
						l = strings.TrimLeft(l, "\t")
					}
					next++
					if l == h.delim {
						h.terminated = true
						break
					}
					body.WriteString(l)
					body.WriteByte('\n')
				}
				h.content = body.String()
				if !h.terminated {
					break heredocs
				}
			}
		}
		i = next

		for s, seg := range segs {
			if len(seg.heredocs) == 0 {
				continue
			}
			h := seg.heredocs[len(seg.heredocs)-1] // 複数あれば最後のものが stdin になる
			if !h.terminated {
				continue
			}
			type target struct {
				file   string
				append bool
			}
			targets := []target{}
			push := func(t bhTok, appendMode bool) {
				if file, ok := bhResolveTarget(t, cwd, home); ok {
					targets = append(targets, target{file, appendMode})
				}
			}
			if teeTargets, teeAppend, ok := bhTeeTargets(seg.words); ok {
				for _, t := range teeTargets {
					push(t, teeAppend)
				}
			} else if !bhIsPlainCat(seg.words) {
				continue
			}
			if n := len(seg.redirects); n > 0 {
				push(seg.redirects[n-1].target, seg.redirects[n-1].append)
			}
			// `| tee path` の連鎖（tee 以外のコマンドに渡った先は本文のままとは限らないので見ない）
			for p := s + 1; p < len(segs) && segs[p].sep == "|"; p++ {
				ps := segs[p]
				pt, pa, ok := bhTeeTargets(ps.words)
				if !ok {
					break
				}
				for _, t := range pt {
					push(t, pa)
				}
				if n := len(ps.redirects); n > 0 {
					push(ps.redirects[n-1].target, ps.redirects[n-1].append)
				}
			}
			for _, t := range targets {
				add(t.file, h.content, t.append)
			}
		}
	}
	return out
}
