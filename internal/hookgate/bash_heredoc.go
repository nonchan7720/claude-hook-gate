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

// TokenizeLine は 1 行をクォートを考慮して語と演算子に分ける。クォートは外し、`$` / バッククォートを含む（展開される）語は dynamic。
func TokenizeLine(line string) []bhTok {
	toks := []bhTok{}
	var word strings.Builder
	dynamic, quoted, has := false, false, false
	flush := func() {
		if has {
			toks = append(toks, bhTok{kind: "word", text: word.String(), dynamic: dynamic, quoted: quoted})
		}
		word.Reset()
		dynamic, quoted, has = false, false, false
	}
	op := func(text string) { toks = append(toks, bhTok{kind: "op", text: text}) }
	at := func(i int) byte {
		if i < len(line) {
			return line[i]
		}
		return 0
	}
	i := 0
	for i < len(line) {
		c := line[i]
		switch {
		case c == ' ' || c == '\t':
			flush()
			i++
		case c == '#' && !has:
			i = len(line)
		case c == '\'':
			end := strings.IndexByte(line[i+1:], '\'')
			if end == -1 {
				word.WriteString(line[i+1:])
				i = len(line)
			} else {
				word.WriteString(line[i+1 : i+1+end])
				i = i + 1 + end + 1
			}
			has, quoted = true, true
		case c == '"':
			i++
			for i < len(line) && line[i] != '"' {
				if line[i] == '\\' && i+1 < len(line) {
					i++
				} else if line[i] == '$' || line[i] == '`' {
					dynamic = true
				}
				word.WriteByte(line[i])
				i++
			}
			i++
			has, quoted = true, true
		case c == '\\':
			if i+1 < len(line) {
				word.WriteByte(line[i+1])
			}
			has, quoted = true, true // `\EOF` は引用扱い
			i += 2
		case c == '<' || c == '>':
			// 直前に付いた数字はファイル記述子（2> など）: その語は捨て、リダイレクトは対象外にする
			fd := has && bhDigitsRe.MatchString(word.String())
			if fd {
				word.Reset()
				has = false
			} else {
				flush()
			}
			if c == '<' && at(i+1) == '<' && at(i+2) == '<' {
				op("<<<")
				i += 3
				continue
			}
			if c == '<' && at(i+1) == '<' {
				i += 2
				if at(i) == '-' {
					op("<<-")
					i++
				} else {
					op("<<")
				}
				continue
			}
			text := string(c)
			i++
			if c == '>' && at(i) == '>' {
				text = ">>"
				i++
			}
			if at(i) == '&' {
				// `>&2` / `>&-`: 記述子の複製。次の語は書き先ではない
				text = "fd"
				i++
			} else if fd {
				text = "fd"
			}
			op(text)
		case c == '&' && at(i+1) == '>':
			// `&> path` / `&>> path`: stdout と stderr をまとめて書く（内容は本文のままなので対象にする）
			flush()
			i += 2
			if at(i) == '>' {
				op(">>")
				i++
			} else {
				op(">")
			}
		case c == '|' || c == '&' || c == ';' || c == '(' || c == ')':
			flush()
			if (c == '|' || c == '&') && at(i+1) == c {
				op(string(c) + string(c))
				i += 2
			} else {
				op(string(c))
				i++
			}
		default:
			if c == '$' || c == '`' {
				dynamic = true
			}
			word.WriteByte(c)
			has = true
			i++
		}
	}
	flush()
	return toks
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

// bhTeeTargets は `tee` の書き先（オプション以外の引数）と追記かどうか。tee でなければ ok=false。
func bhTeeTargets(words []bhTok) (targets []bhTok, appendMode, ok bool) {
	if bhNameOf(words) != "tee" {
		return nil, false, false
	}
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
