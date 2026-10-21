package hookgate

// shlex.quote / shlex.split（POSIX モード）相当。

import (
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"
)

var shellSafeRe = regexp.MustCompile(`^[A-Za-z0-9@%+=:,./-]+$`)

// ShellQuote は shlex.quote。
func ShellQuote(s string) string {
	if s == "" {
		return "''"
	}
	if shellSafeRe.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

// isJSSpace は JS の正規表現 \s に一致する文字（TS 版は /\s/ で空白を判定している）。
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

var (
	errNoClosingQuotation = errors.New("No closing quotation") //nolint:staticcheck // Python の shlex のメッセージと同じ
	errNoEscapedCharacter = errors.New("No escaped character") //nolint:staticcheck // Python の shlex のメッセージと同じ
)

// ShellSplit は shlex.split（POSIX モード）。引用符が閉じていない・末尾が \ のときはエラー。
func ShellSplit(s string) ([]string, error) {
	out := []string{}
	var cur strings.Builder
	inToken := false
	i := 0
	for i < len(s) {
		c := s[i]
		switch c {
		case '\'':
			end := strings.IndexByte(s[i+1:], '\'')
			if end < 0 {
				return nil, errNoClosingQuotation
			}
			cur.WriteString(s[i+1 : i+1+end])
			inToken = true
			i += end + 2
		case '"':
			i++
			inToken = true
			for {
				if i >= len(s) {
					return nil, errNoClosingQuotation
				}
				d := s[i]
				if d == '"' {
					i++
					break
				}
				if d == '\\' && i+1 < len(s) && strings.IndexByte("\"\\$`\n", s[i+1]) >= 0 {
					cur.WriteByte(s[i+1])
					i += 2
				} else {
					cur.WriteByte(d)
					i++
				}
			}
		case '\\':
			if i+1 >= len(s) {
				return nil, errNoEscapedCharacter
			}
			_, size := utf8.DecodeRuneInString(s[i+1:])
			cur.WriteString(s[i+1 : i+1+size])
			inToken = true
			i += 1 + size
		default:
			r, size := utf8.DecodeRuneInString(s[i:])
			if isJSSpace(r) {
				if inToken {
					out = append(out, cur.String())
				}
				cur.Reset()
				inToken = false
			} else {
				cur.WriteString(s[i : i+size])
				inToken = true
			}
			i += size
		}
	}
	if inToken {
		out = append(out, cur.String())
	}
	return out, nil
}
