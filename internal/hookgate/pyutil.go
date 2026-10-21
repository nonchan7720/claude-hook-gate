package hookgate

// Python 由来の挙動（真偽判定・repr・int()・正規表現の書き方）を Go で再現する小物。
// 動的な JSON / YAML の値は map[string]any / []any / string / float64 / int / bool / nil で表す。

import (
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dlclark/regexp2"
)

// Dict は JSON / YAML のオブジェクト。
type Dict = map[string]any

// IsDict は v がオブジェクトか（TS の isDict）。
func IsDict(v any) bool {
	_, ok := v.(map[string]any)
	return ok
}

// AsDict は v をオブジェクトとして取り出す。
func AsDict(v any) (Dict, bool) {
	d, ok := v.(map[string]any)
	return d, ok
}

// Truthy は Python の bool(value) と同じ真偽判定（空のリスト・辞書、0、空文字は偽）。
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	case float32:
		return x != 0 && !math.IsNaN(float64(x))
	case int:
		return x != 0
	case int64:
		return x != 0
	case int32:
		return x != 0
	case uint64:
		return x != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() { //nolint:exhaustive // 他は常に真
	case reflect.Slice, reflect.Map, reflect.Array:
		return rv.Len() > 0
	case reflect.Pointer, reflect.Interface:
		return !rv.IsNil()
	}
	return true
}

// JSNumber は JS の Number.toString() と同じ書き方で数値を文字列にする。
func JSNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	// 最短の 10 進表現（桁と指数）を取り、JS の書き分け（指数 -7 以上 21 未満は固定小数）に直す。
	e := strconv.FormatFloat(math.Abs(f), 'e', -1, 64)
	mant, expStr, _ := strings.Cut(e, "e")
	exp, _ := strconv.Atoi(expStr)
	digits := strings.Replace(mant, ".", "", 1)
	sign := ""
	if f < 0 {
		sign = "-"
	}
	n := exp + 1 // 小数点の位置（digits の何桁目の後ろか）
	k := len(digits)
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	expSign := "+"
	if n-1 < 0 {
		expSign = "-"
	}
	abs := n - 1
	if abs < 0 {
		abs = -abs
	}
	if k == 1 {
		return sign + digits + "e" + expSign + strconv.Itoa(abs)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + expSign + strconv.Itoa(abs)
}

// Str は JS の String(v) 相当（メッセージへの埋め込み用）。nil は "null"、オブジェクトは "[object Object]"。
func Str(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return JSNumber(x)
	case float32:
		return JSNumber(float64(x))
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case int32:
		return strconv.FormatInt(int64(x), 10)
	case uint64:
		return strconv.FormatUint(x, 10)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e == nil {
				continue
			}
			parts[i] = Str(e)
		}
		return strings.Join(parts, ",")
	case []string:
		return strings.Join(x, ",")
	case map[string]any:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}

// PyRepr は Python の repr() の近似（メッセージに値を埋め込む用）。辞書のキーは順序が保てないので昇順に並べる。
func PyRepr(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case bool:
		if x {
			return "True"
		}
		return "False"
	case float64, float32, int, int64, int32, uint64:
		return Str(x)
	case string:
		quote := "'"
		if strings.Contains(x, "'") && !strings.Contains(x, `"`) {
			quote = `"`
		}
		body := strings.NewReplacer(`\`, `\\`, "\n", `\n`, "\r", `\r`, "\t", `\t`).Replace(x)
		if quote == "'" {
			body = strings.ReplaceAll(body, "'", `\'`)
		}
		return quote + body + quote
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = PyRepr(e)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = PyRepr(k) + ": " + PyRepr(x[k])
		}
		return "{" + strings.Join(parts, ", ") + "}"
	}
	return Str(v)
}

var countStringRe = regexp.MustCompile(`^\s*[+-]?\d+\s*$`)

// ToCount は `int(value or 0)` を try/except で包んだ呼び出しと同じ。変換できなければ 0。
func ToCount(v any) int {
	if !Truthy(v) {
		return 0
	}
	switch x := v.(type) {
	case float64:
		return floatToInt(x)
	case float32:
		return floatToInt(float64(x))
	case int:
		return x
	case int64:
		return int(x)
	case int32:
		return int(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		if !countStringRe.MatchString(x) {
			return 0
		}
		s := strings.TrimSpace(x)
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return int(n)
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0
		}
		return floatToInt(f)
	}
	return 0
}

func floatToInt(f float64) int {
	if math.IsNaN(f) {
		return 0
	}
	t := math.Trunc(f)
	switch {
	case t >= math.MaxInt64:
		return math.MaxInt64
	case t <= math.MinInt64:
		return math.MinInt64
	}
	return int(t)
}

// ToFixed は JS の Number.prototype.toFixed(digits)（2 つの候補が等距離なら大きい方）。
func ToFixed(x float64, digits int) string {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return JSNumber(x)
	}
	neg := x < 0
	if neg {
		x = -x
	}
	// 2 進数の厳密な 10 進展開を十分長く取り、そこで半分切り上げする。
	s := strconv.FormatFloat(x, 'f', 1100, 64)
	intPart, frac, _ := strings.Cut(s, ".")
	kept := intPart + frac[:digits]
	roundUp := frac[digits] >= '5'
	b := []byte(kept)
	if roundUp {
		i := len(b) - 1
		for ; i >= 0; i-- {
			if b[i] == '9' {
				b[i] = '0'
				continue
			}
			b[i]++
			break
		}
		if i < 0 {
			b = append([]byte{'1'}, b...)
		}
	}
	out := string(b)
	if digits > 0 {
		out = out[:len(out)-digits] + "." + out[len(out)-digits:]
	}
	if neg && strings.Trim(out, "0.") != "" {
		out = "-" + out
	}
	return out
}

var (
	inlineFlagsRe = regexp.MustCompile(`^\(\?([aiLmsux]+)\)`)
	namedGroupRe  = regexp.MustCompile(`\(\?P<([A-Za-z_]\w*)>`)
	namedBackRe   = regexp.MustCompile(`\(\?P=([A-Za-z_]\w*)\)`)
)

// regexMatchTimeout は破滅的バックトラックで hook が止まらないための上限（TS 版には無い安全弁）。
const regexMatchTimeout = 10 * time.Second

// PyRegExp は Python の re 形式の正規表現を regexp2 の正規表現にする。flags は JS 流の "i" "m" "s" の並び。
// 先頭の (?i) / (?s) / (?m) と名前付きグループ (?P<name>...) / (?P=name) を読み替え、\A（文字列の先頭）と
// \Z / \z（文字列の末尾）は m の有無によらず文字列の端だけに一致させる。m フラグ無しの $ も JS と同じく
// 文字列の末尾だけに一致する（.NET 系の「末尾の改行の前」には一致しない）。
// TS 版（mod 側の src/pyutil.ts）は JS の RegExp なので、同じルールファイルが同じ結果になるよう JS の意味に寄せる:
// regexp2.ECMAScript で \w \d \b を ASCII だけにし、残りの違い（. ^ $ \s が見る改行・空白の範囲）は translateJS で書き換える。
// 対応できない書き方（先頭の (?x) など）や不正な正規表現はエラー（呼び出し側がその要素だけを無効にする）。
func PyRegExp(source, flags string) (*regexp2.Regexp, error) {
	src := source
	fl := flags
	if m := inlineFlagsRe.FindStringSubmatch(src); m != nil {
		src = src[len(m[0]):]
		if strings.Contains(m[1], "x") {
			return nil, fmt.Errorf("unsupported Python inline flag (?x): %s", source)
		}
		for _, c := range m[1] {
			if strings.ContainsRune("ims", c) && !strings.ContainsRune(fl, c) {
				fl += string(c)
			}
		}
	}
	src = translateJS(src, strings.Contains(fl, "m"), strings.Contains(fl, "s"))
	src = namedGroupRe.ReplaceAllString(src, "(?<$1>")
	src = namedBackRe.ReplaceAllString(src, `\k<$1>`)
	// ECMAScript は IgnoreCase / Multiline としか組めない（Singleline も使えない）ので、m と s は translateJS が引き受ける。
	opts := regexp2.RegexOptions(regexp2.ECMAScript)
	if strings.Contains(fl, "i") {
		opts |= regexp2.IgnoreCase
	}
	re, err := regexp2.Compile(src, opts)
	if err != nil {
		return nil, err
	}
	re.MatchTimeout = regexMatchTimeout
	return re, nil
}

// PyMatch は re が s のどこかに一致するか（JS の RegExp.test）。タイムアウトなどのエラーは不一致。
func PyMatch(re *regexp2.Regexp, s string) bool {
	ok, err := re.MatchString(s)
	return err == nil && ok
}

const (
	// jsSpaceSet は JS の \s（WhiteSpace + LineTerminator）。ECMAScript モードの \s は ASCII の空白だけなので展開する。
	jsSpaceSet = `\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`
	// jsLineTerminators は JS の LineTerminator（. の除外と m フラグ付き ^ $ が見る改行）。
	jsLineTerminators = `\n\r\u2028\u2029`
	// jsWordBoundary / jsNotWordBoundary は JS の \b / \B（単語文字は ASCII の [A-Za-z0-9_] だけ）。
	// regexp2 は ECMAScript モードでも \b だけは Unicode の単語文字で判定するので展開する。
	jsWordBoundary    = `(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))`
	jsNotWordBoundary = `(?:(?<=[A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<![A-Za-z0-9_])(?![A-Za-z0-9_]))`
)

// translateJS は Python 形式の正規表現（regexp2 の ECMAScript モードに渡すもの）を JS の RegExp と同じ意味にする。
//   - 文字クラスの外の \A は \A、\Z / \z は \z（文字列の端だけ）。
//   - m フラグ無しの $ は \z。m フラグ付きの ^ $ は JS の改行（\n \r U+2028 U+2029）の前後に一致させる。
//   - \b \B は ASCII の単語文字で判定する（regexp2 は ECMAScript モードでも \b だけ Unicode で判定する）。
//   - . は s フラグ付きなら全文字、無しなら JS の改行以外。
//   - \s \S は JS の空白の範囲に広げる（クラスの中の \s も展開。クラスの中の \S は ASCII のまま）。
//   - JS では恒等エスケープになる \a \e \p などの英字は、.NET 系の意味にならないよう英字そのものにする。
//   - 文字クラスの中の [ は JS では文字なので \[ にする（.NET の差集合 [a-z-[aeiou]] を避ける）。
//   - 文字クラス先頭の ]（Python では []] / [^]] の ] は文字）は \] にする。
func translateJS(src string, multiline, dotAll bool) string {
	var out strings.Builder
	inClass := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		if c == '\\' {
			if i+1 >= len(src) {
				out.WriteByte(c)
				break
			}
			i++
			writeJSEscape(&out, src[i], inClass)
			continue
		}
		if inClass {
			switch c {
			case ']':
				inClass = false
				out.WriteByte(c)
			case '[':
				out.WriteString(`\[`)
			default:
				out.WriteByte(c)
			}
			continue
		}
		switch c {
		case '[':
			inClass = true
			out.WriteByte(c)
			if i+1 < len(src) && src[i+1] == '^' {
				i++
				out.WriteByte(src[i])
			}
			if i+1 < len(src) && src[i+1] == ']' {
				i++
				out.WriteString(`\]`)
			}
		case '.':
			if dotAll {
				out.WriteString(`[\s\S]`)
			} else {
				out.WriteString(`[^` + jsLineTerminators + `]`)
			}
		case '^':
			if multiline {
				out.WriteString(`(?:\A|(?<=[` + jsLineTerminators + `]))`)
			} else {
				out.WriteByte(c)
			}
		case '$':
			if multiline {
				out.WriteString(`(?:\z|(?=[` + jsLineTerminators + `]))`)
			} else {
				out.WriteString(`\z`)
			}
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

// writeJSEscape は `\<next>` を JS と同じ意味になる書き方で out に書く（バックスラッシュの次の 1 バイトが next）。
func writeJSEscape(out *strings.Builder, next byte, inClass bool) {
	switch {
	case !inClass && next == 'A':
		out.WriteString(`\A`)
	case !inClass && (next == 'Z' || next == 'z'):
		out.WriteString(`\z`)
	case next == 's' && inClass:
		out.WriteString(jsSpaceSet)
	case next == 's':
		out.WriteString(`[` + jsSpaceSet + `]`)
	case next == 'S' && !inClass:
		out.WriteString(`[^` + jsSpaceSet + `]`)
	case next == 'b' && !inClass:
		out.WriteString(jsWordBoundary)
	case next == 'B' && !inClass:
		out.WriteString(jsNotWordBoundary)
	case next >= 0x80, isIdentityEscapeLetter(next, inClass):
		// 恒等エスケープ: バックスラッシュを落とす（非 ASCII の文字の続きのバイトは呼び出し側の次の周回でそのまま写る）
		out.WriteByte(next)
	default:
		out.WriteByte('\\')
		out.WriteByte(next)
	}
}

// isIdentityEscapeLetter は \<c> が JS（u フラグ無し）では c そのものを表す英字・_ か。
// JS が意味を持たせている d D w W s S b B f n r t v c x u k 0-9 は含まない（B は文字クラスの中では恒等）。
func isIdentityEscapeLetter(c byte, inClass bool) bool {
	switch {
	case c == '_':
		return true
	case c == 'B':
		return inClass
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
		return !strings.ContainsRune("dDwWsSbfnrtvcxuk", rune(c))
	}
	return false
}

// JqStr は jq の `.x // empty`（null / false は空）+ `-r`（文字列はそのまま）に相当する取り出し。
func JqStr(v any) string {
	if v == nil {
		return ""
	}
	if b, ok := v.(bool); ok && !b {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return JSONStringify(v)
}
