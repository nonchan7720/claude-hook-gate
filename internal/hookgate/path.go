package hookgate

// POSIX パス操作。挙動は Python の os.path（posixpath）に合わせている。filepath は使わない（OS 非依存の純粋な文字列関数）。

import (
	"regexp"
	"strings"
)

// IsAbsolute は先頭が / か。
func IsAbsolute(p string) bool { return strings.HasPrefix(p, "/") }

// Join は Python の os.path.join と同じ。後ろの要素が絶対パスならそこから作り直す（正規化はしない）。
func Join(parts ...string) string {
	out := ""
	for _, part := range parts {
		switch {
		case strings.HasPrefix(part, "/"):
			out = part
		case out == "" || strings.HasSuffix(out, "/"):
			out += part
		default:
			out += "/" + part
		}
	}
	return out
}

// Normpath は Python の os.path.normpath と同じ。
func Normpath(p string) string {
	if p == "" {
		return "."
	}
	abs := strings.HasPrefix(p, "/")
	var out []string
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "", ".":
			continue
		case "..":
			if n := len(out); n > 0 && out[n-1] != ".." {
				out = out[:n-1]
			} else if !abs {
				out = append(out, "..")
			}
		default:
			out = append(out, seg)
		}
	}
	joined := strings.Join(out, "/")
	if abs {
		return "/" + joined
	}
	if joined == "" {
		return "."
	}
	return joined
}

// Dirname は Python の os.path.dirname。
func Dirname(p string) string {
	i := strings.LastIndex(p, "/") + 1
	head := p[:i]
	if head != "" && head != strings.Repeat("/", len(head)) {
		return strings.TrimRight(head, "/")
	}
	return head
}

// Basename は最後の / より後ろ。
func Basename(p string) string {
	return p[strings.LastIndex(p, "/")+1:]
}

var onlyDotsRe = regexp.MustCompile(`^\.+$`)

// Splitext は [拡張子を除いた部分, 拡張子]。先頭のドット（隠しファイル）は拡張子と見なさない。
func Splitext(p string) (string, string) {
	base := Basename(p)
	dot := strings.LastIndex(base, ".")
	if dot <= 0 || onlyDotsRe.MatchString(base[:dot]) {
		return p, ""
	}
	cut := len(p) - len(base) + dot
	return p[:cut], p[cut:]
}

func nonEmptySegments(p string) []string {
	var out []string
	for _, s := range strings.Split(Normpath(p), "/") {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// Relpath は Python の os.path.relpath。引数は絶対パス（または共通の基準からの相対パス）を想定する。
func Relpath(path, start string) string {
	a := nonEmptySegments(path)
	b := nonEmptySegments(start)
	i := 0
	for i < len(a) && i < len(b) && a[i] == b[i] {
		i++
	}
	var rel []string
	for range b[i:] {
		rel = append(rel, "..")
	}
	rel = append(rel, a[i:]...)
	if len(rel) == 0 {
		return "."
	}
	return strings.Join(rel, "/")
}

// ExpandUser は先頭の ~（単独、または ~/ 始まり）を home に展開する。home が空ならそのまま返す。
func ExpandUser(p, home string) string {
	if home == "" {
		return p
	}
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return strings.TrimRight(home, "/") + p[1:]
	}
	return p
}
