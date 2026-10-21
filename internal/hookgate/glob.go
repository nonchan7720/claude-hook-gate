package hookgate

// glob の解釈: * は / を跨がない、** は跨ぐ、{a,b} 展開、?、[..]。
// gate.yaml の match と feedback ルールの path / changed / exclude_path で共通。

import (
	"regexp"
	"strings"
)

func splitTopCommas(s string) []string {
	var parts []string
	depth := 0
	var cur strings.Builder
	for _, c := range s {
		switch {
		case c == '{':
			depth++
			cur.WriteRune(c)
		case c == '}':
			depth--
			cur.WriteRune(c)
		case c == ',' && depth == 0:
			parts = append(parts, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(c)
		}
	}
	return append(parts, cur.String())
}

// ExpandBraces は {a,b} を展開する（入れ子可。要素 1 つの {x} も外す）。
func ExpandBraces(s string) []string {
	depth := 0
	start := -1
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '{':
			if depth == 0 {
				start = i
			}
			depth++
		case '}':
			depth--
			if depth == 0 {
				pre := s[:start]
				inner := s[start+1 : i]
				post := s[i+1:]
				var out []string
				for _, part := range splitTopCommas(inner) {
					out = append(out, ExpandBraces(pre+part+post)...)
				}
				return out
			}
		}
	}
	return []string{s}
}

func writeEscaped(out *strings.Builder, c byte) {
	if strings.IndexByte(".*+?^${}()|[]\\/", c) >= 0 {
		out.WriteByte('\\')
	}
	out.WriteByte(c)
}

// GlobToRegex は glob を正規表現（^...$）の文字列にする。
func GlobToRegex(pat string) string {
	n := len(pat)
	i := 0
	var out strings.Builder
	out.WriteString("^")
	for i < n {
		c := pat[i]
		switch c {
		case '*':
			j := i
			for j < n && pat[j] == '*' {
				j++
			}
			switch {
			case j-i >= 2 && j < n && pat[j] == '/':
				out.WriteString("(?:.*/)?") // **/ は 0 階層も許可
				i = j + 1
			case j-i >= 2:
				out.WriteString(".*")
				i = j
			default:
				out.WriteString("[^/]*")
				i++
			}
		case '?':
			out.WriteString("[^/]")
			i++
		case '[':
			j := i + 1
			if j < n && (pat[j] == '!' || pat[j] == '^') {
				j++
			}
			if j < n && pat[j] == ']' {
				j++
			}
			for j < n && pat[j] != ']' {
				j++
			}
			end := min(j+1, n)
			cls := pat[i:end]
			if strings.HasPrefix(cls, "[!") {
				cls = "[^" + cls[2:]
			}
			out.WriteString(cls)
			i = j + 1
		default:
			writeEscaped(&out, c)
			i++
		}
	}
	out.WriteString("$")
	return out.String()
}

// PatternPair は (展開後パターン文字列, 正規表現)。
type PatternPair struct {
	Text string
	Rx   *regexp.Regexp
}

// MatchPatterns はパターン文字列のリストをブレース展開し、(展開後パターン文字列, 正規表現) のペアを
// match に書かれた順→ブレース展開順で返す。per_file_dir のルート抽出には展開後のパターン文字列自体が必要。
// 不正なパターン（閉じていない [ など）はエラー。
func MatchPatterns(pats []string) ([]PatternPair, error) {
	var pairs []PatternPair
	for _, pat := range pats {
		for _, ex := range ExpandBraces(pat) {
			rx, err := regexp.Compile(GlobToRegex(ex))
			if err != nil {
				return nil, err
			}
			pairs = append(pairs, PatternPair{Text: ex, Rx: rx})
		}
	}
	return pairs, nil
}

// CompileGlobs はパターンのリストを正規表現のリストにする。
func CompileGlobs(patterns []string) ([]*regexp.Regexp, error) {
	pairs, err := MatchPatterns(patterns)
	if err != nil {
		return nil, err
	}
	out := make([]*regexp.Regexp, len(pairs))
	for i, p := range pairs {
		out[i] = p.Rx
	}
	return out, nil
}

// AsList は文字列 or リスト（または未指定）を文字列リストにそろえる。
func AsList(v any) []string {
	switch x := v.(type) {
	case string:
		return []string{x}
	case []string:
		return x
	case []any:
		out := make([]string, len(x))
		for i, e := range x {
			if s, ok := e.(string); ok {
				out[i] = s
			} else {
				out[i] = Str(e)
			}
		}
		return out
	}
	return []string{}
}

// ---- ファイルシステム上の glob（Python の glob.glob(recursive=True) 相当、存在判定だけ） ----

func hasMagic(seg string) bool { return strings.ContainsAny(seg, "*?[") }

// GlobExists は pattern（絶対パス、または base からの相対）にマッチするパスが 1 つでも存在するか。
func GlobExists(io Io, pattern string) bool {
	abs := strings.HasPrefix(pattern, "/")
	var segs []string
	for _, s := range strings.Split(pattern, "/") {
		if s != "" {
			segs = append(segs, s)
		}
	}
	dir := ""
	if abs {
		dir = "/"
	}
	return globWalk(io, dir, segs, 0)
}

func globWalk(io Io, dir string, segs []string, i int) bool {
	if i >= len(segs) {
		if dir == "" {
			return true
		}
		return io.Exists(dir)
	}
	seg := segs[i]
	here := dir
	if dir == "" {
		here = "."
	}
	if seg == "**" {
		if i == len(segs)-1 {
			st, ok := io.Stat(here)
			return ok && st.Kind == KindDir
		}
		if globWalk(io, dir, segs, i+1) {
			return true
		}
		for _, e := range io.List(here) {
			if strings.HasPrefix(e.Name, ".") {
				continue
			}
			sub := Join(dir, e.Name)
			if st, ok := io.Stat(sub); ok && st.Kind == KindDir && globWalk(io, sub, segs, i) {
				return true
			}
		}
		return false
	}
	if !hasMagic(seg) {
		return globWalk(io, Join(dir, seg), segs, i+1)
	}
	rx, err := regexp.Compile(GlobToRegex(seg))
	if err != nil {
		return false
	}
	for _, e := range io.List(here) {
		if strings.HasPrefix(e.Name, ".") && !strings.HasPrefix(seg, ".") {
			continue
		}
		if !rx.MatchString(e.Name) {
			continue
		}
		if globWalk(io, Join(dir, e.Name), segs, i+1) {
			return true
		}
	}
	return false
}
