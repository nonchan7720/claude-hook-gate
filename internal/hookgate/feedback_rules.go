package hookgate

// feedback ルール共通モジュール。
//
// グローバル (~/.claude/feedback/*.md) とプロジェクト (<projectDir>/.claude/feedback/*.md) の
// 両ディレクトリから frontmatter を全件読み（同名はプロジェクト側が優先）、count に応じた強制力
// （severity: deny / ask（pre_*）・block（stop_check / post_edit） / warn）を解決する。
// PreToolUse hook (feedback_guard.go) / PostToolUse hook (feedback_post_edit.go, feedback_bash_edit.go) /
// Stop hook (feedback_stop_check.go) / UserPromptSubmit hook (feedback_inject.go) から使う
// 共通ロジックのみを持つ。
//
// enforce スキーマ（frontmatter に追記する形式）
//
// enforce:
//   - event: pre_bash          # PreToolUse(Bash) でコマンド文字列を検査
//     when: '正規表現'          # 必須。command にマッチしたら候補
//     unless: '正規表現'        # 任意。マッチすれば違反ではない
//     check: 'shell cmd'       # 任意。非0終了で違反確定（when と AND）
//     message: '違反時の指示文'
//     severity: deny           # 任意。省略時は count から自動決定
//
//   - event: pre_edit          # PreToolUse(Edit|Write|MultiEdit) で対象と内容を検査
//                              # （Bash で書かれたファイルは実行後に PostToolUse(Bash) で同じ条件を評価し、
//                              #  deny / ask は block にする。feedback_bash_edit.go）
//     path: 'glob'             # 必須。file_path にマッチ
//     exclude_path: 'glob'     # 任意。文字列または配列。path にマッチしても
//                              # これにマッチしたら検査対象外（テスト不要なファイルの除外）
//     when: '正規表現'          # 任意。new_string / content / new_source に対して
//     unless: '正規表現'        # 任意
//     absent_sibling: 'name'   # 任意。同ディレクトリにこの名前のファイルが無ければ違反
//                              # ({stem} はファイル名 (拡張子抜き) に置換される。
//                              # kebab-case/snake_case 両方の候補が展開される)
//                              # 対象ファイル自身がテストファイルの命名規則に一致する
//                              # 場合は自動的に対象外にする（tdd の自己参照を防ぐ）
//     absent_glob: 'glob'      # 任意。文字列または配列。project_dir 起点の glob で、
//                              # どれか1つでも存在すれば違反にしない（spec/ や tests/ など
//                              # 実装と別ツリーに置くテストを拾うため）。{stem} に加えて
//                              # {dir}（project_dir 相対ディレクトリ）も展開される。{stem} は
//                              # kebab-case/snake_case 両方の候補が展開される。
//                              # absent_sibling と併記した場合は OR で判定する
//
//   - event: post_edit         # PostToolUse(Edit|Write|MultiEdit) で、編集後のファイル全体を検査
//                              # （Bash で書き換えられたファイルも PostToolUse(Bash) で同様に。feedback_bash_edit.go）
//     path: 'glob'             # 必須。file_path（プロジェクト相対）にマッチ
//     exclude_path: 'glob'     # 任意。文字列または配列。マッチしたら検査対象外
//     when: '正規表現'          # 任意。編集後のファイル内容（ディスク上の全文）に対して（m フラグ）
//     unless: '正規表現'        # 任意。マッチすれば違反ではない
//     check: 'shell cmd'       # 任意。$FILE に絶対パス、cwd はそのファイルのルート。非0終了で違反
//                              # when と check の少なくとも一方が必要（どちらも無い要素は無視）。
//                              # 両方あれば AND（when がマッチし、かつ check が非0）
//     message: '...'
//     severity: block          # 任意。省略時は count から自動決定
//
//   - event: stop_check        # Stop 時、そのセッションの変更ファイルを検査
//     changed: 'glob'          # 必須。worktree 内のファイルは worktree ルート相対で判定する
//                              # （セッション中に削除され既に存在しないファイルは検査しない）
//     check: 'shell cmd'       # 任意。$FILE に該当ファイルの絶対パスが入る。非0で違反。
//                              # cwd はそのファイルのルート（worktree 内なら worktree、それ以外は project_dir）
//     require_sibling: 'name'  # 任意。同ディレクトリにこのファイルが無ければ違反
//     message: '...'
//
// glob の解釈（* は / を跨がない、** は跨ぐ、{a,b} 展開）は gate と共通（glob.go）。
//
// severity の自動決定（明示があればそれを優先）:
//   count >= 5   -> deny
//   count 3, 4   -> ask（pre_bash / pre_edit） / block（stop_check / post_edit）
//   count 1, 2   -> warn
//
// 有効期限と適用スコープ（frontmatter の任意キー。3つすべてを満たしたときだけルールが有効になる）
//
// expires: 2026-12-31        # 任意。この日付（YYYY-MM-DD ならその日の終わり。UTC）または ISO 8601 日時を
//                            # 過ぎたらルールは無効。パースできない値は無視（無期限扱い）
// projects: ['~/src/myorg/**']  # 任意。文字列または配列。プロジェクトディレクトリの絶対パスにマッチする glob。
//                            # 先頭の ~ は HOME に展開。1つでもマッチすれば適用。未指定・空なら制限なし
// when_exists: ['go.mod', '**/*.go']  # 任意。文字列または配列。プロジェクトルート相対の glob。
//                            # 1つでも存在すれば適用。未指定・空なら制限なし
//
// このフィルタは ListRules を feedbackDirPath 省略で呼んだとき（グローバル＋プロジェクトのマージ後）にだけ
// かかる。ディレクトリを明示したときは無加工で返す。
//
// 壊れたルールの扱い（1つのルールの不備で他のルールまで止めないため）:
//   - frontmatter が YAML として読めないファイルは、そのファイルだけを飛ばす
//   - enforce がリストでない（`- ` の書き忘れなど）ルールは enforce を空として扱う
//   - enforce の要素のうち、辞書でないもの・when / unless が使えない正規表現のものは、その要素だけを捨てる
//   - 評価中に例外になった要素は、その要素だけを飛ばす
// いずれも、ファイルと理由を ~/.claude/feedback/.errors.jsonl に残し（BrokenRule）、UserPromptSubmit の注入と
// /correct で知らせる。
//
// 移植メモ: TS 版の「例外を投げる」関数は error を返す。Violation は値で持ち、DowngradeRepeatedAsks のように
// 書き換える関数にはスライスをそのまま渡す（要素は添字で更新される）。

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dlclark/regexp2"
)

// Rule は 1 つの feedback ルール。
type Rule struct {
	Name        string
	Description string
	Count       int
	// Enforce は検証済みの enforce（辞書で、when / unless が正規表現としてコンパイルできる要素だけ）。
	Enforce []Dict
	Path    string
	// Problems は捨てた enforce の要素の理由（ルール自体は有効）。
	Problems []string
	// Expires は有効期限（ミリ秒）。これより後は無効。nil なら無期限。
	Expires *int64
	// Projects はプロジェクトディレクトリの絶対パスにマッチする glob（~ 展開前）。空なら制限なし。
	Projects []string
	// WhenExists はプロジェクトルート相対の glob。空なら制限なし。
	WhenExists []string
}

// Violation は enforce の違反 1 件。
type Violation struct {
	Rule     string
	Count    int
	Severity string
	Event    string
	Message  string
	Detail   string
}

// FeedbackDir はグローバルの feedback の状態ファイル（.violations.jsonl、.ask_state など）の置き場所:
// ~/<設定ディレクトリ>/feedback。CLAUDE_FEEDBACK_DIR で差し替え可能。
func FeedbackDir(io Io) string {
	if override := io.Env().ClaudeFeedbackDir; override != "" {
		return override
	}
	return Join(io.HomeConfigDir(), "feedback")
}

// FeedbackDirs はグローバルのルールを読むディレクトリ（優先順）。CLAUDE_FEEDBACK_DIR があればそれだけ。
func FeedbackDirs(io Io) []string {
	if override := io.Env().ClaudeFeedbackDir; override != "" {
		return []string{override}
	}
	home := io.Env().Home
	if home == "" {
		home = "~"
	}
	return ConfigPaths(io, home, "feedback")
}

// ProjectFeedbackDir はプロジェクトの feedback の置き場所（<projectDir>/<設定ディレクトリ>/feedback）。
// projectDir を省略すると io.ProjectConfigDir() を使う。
func ProjectFeedbackDir(io Io, projectDir ...string) string {
	if len(projectDir) > 0 && projectDir[0] != "" {
		first := ".claude"
		if names := io.ConfigDirNames(); len(names) > 0 {
			first = names[0]
		}
		return Join(projectDir[0], first, "feedback")
	}
	return Join(io.ProjectConfigDir(), "feedback")
}

func fbFirstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// fbOptDir は省略可能な projectDir 引数を取り出す。
func fbOptDir(projectDir []string) string {
	if len(projectDir) > 0 {
		return projectDir[0]
	}
	return ""
}

// ProjectFeedbackDirs はプロジェクトのルールを読むディレクトリ（優先順）。
func ProjectFeedbackDirs(io Io, projectDir ...string) []string {
	return ConfigPaths(io, fbFirstNonEmpty(fbOptDir(projectDir), io.ProjectDir(), io.Cwd()), "feedback")
}

// ViolationsLogPath は違反ログ。
func ViolationsLogPath(io Io) string { return Join(FeedbackDir(io), ".violations.jsonl") }

// ErrorsLogPath は壊れたルールと、hook が握りつぶした内部エラーを残すログ。
func ErrorsLogPath(io Io) string { return Join(FeedbackDir(io), ".errors.jsonl") }

// BrokenRule は読めなかったルールファイル、または捨てた enforce の要素。
type BrokenRule struct {
	Path   string
	Reason string
}

// ---- frontmatter 読み込み ----

// fbJsSpaceClass は JS の \s に一致する文字（Go の \s は ASCII だけなので広げる）。
const fbJsSpaceClass = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// FrontmatterRe は先頭の frontmatter（JS 版の /^---\s*\n([\s\S]*?\n)---\s*\n?/）。
var FrontmatterRe = regexp.MustCompile(`(?s)^---[` + fbJsSpaceClass + `]*\n(.*?\n)---[` + fbJsSpaceClass + `]*\n?`)

var fbBodyStopRe = regexp.MustCompile(`\*\*(Why|言い訳|Excuse|How to apply)[:：]?\*\*`)

// LoadYamlText は frontmatter のテキスト（YAML のサブセット）を読む。
func LoadYamlText(text string) (any, error) { return ParseYaml(text) }

var (
	fbDateOnlyRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	// fbYamlTimestampRe は YAML 1.1 の timestamp と ISO 8601 の日付・日時（時刻の秒は省略可）。
	fbYamlTimestampRe = regexp.MustCompile(`^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:[Tt]|[ \t]+)(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d*))?)?(?:[ \t]*(Z|z|[-+]\d{1,2}(?::\d{2})?))?)?$`)
	fbYearMonthRe     = regexp.MustCompile(`^(\d{4})(?:-(\d{2}))?$`)
	// fbSlashDateRe は V8 の Date.parse が読む YYYY/MM/DD（と YYYY/MM/DD HH:MM[:SS]）。
	fbSlashDateRe = regexp.MustCompile(`^(\d{4})/(\d{1,2})/(\d{1,2})((?: \d{1,2}:\d{2}(?::\d{2})?)?)$`)
)

const fbDayMs int64 = 86_400_000

// fbNormalizeSlashDate は YYYY/MM/DD（時刻は HH:MM[:SS]）をハイフン区切りの YYYY-MM-DD（HH:MM[:SS]）に直す。
// V8 の Date.parse はこの書き方も読むので、日付だけの指定はハイフン区切りと同じ扱い（その日の終わり）にそろえる。
func fbNormalizeSlashDate(text string) string {
	m := fbSlashDateRe.FindStringSubmatch(text)
	if m == nil {
		return text
	}
	month, _ := strconv.Atoi(m[2])
	day, _ := strconv.Atoi(m[3])
	return fmt.Sprintf("%s-%02d-%02d%s", m[1], month, day, m[4])
}

// fbJsDateParse は Date.parse の代わり。ISO 8601（YYYY / YYYY-MM / YYYY-MM-DD / 日時）と YAML の timestamp、
// V8 が読む YYYY/MM/DD（日時）だけを読む。
// 時差の無い日時は UTC とする（YAML 1.1 の timestamp と同じ。JS の ISO 日時は現地時間）。読めなければ ok=false。
func fbJsDateParse(text string) (int64, bool) {
	text = fbNormalizeSlashDate(text)
	if m := fbYearMonthRe.FindStringSubmatch(text); m != nil {
		year, _ := strconv.Atoi(m[1])
		month := 1
		if m[2] != "" {
			month, _ = strconv.Atoi(m[2])
		}
		if month < 1 || month > 12 {
			return 0, false
		}
		return time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC).UnixMilli(), true
	}
	m := fbYamlTimestampRe.FindStringSubmatch(text)
	if m == nil {
		return 0, false
	}
	atoi := func(s string) int { n, _ := strconv.Atoi(s); return n }
	year, month, day := atoi(m[1]), atoi(m[2]), atoi(m[3])
	hour, minute, second, nanos := 0, 0, 0, 0
	if m[4] != "" {
		hour, minute, second = atoi(m[4]), atoi(m[5]), atoi(m[6])
		if frac := m[7]; frac != "" {
			if len(frac) > 3 {
				frac = frac[:3]
			}
			nanos = atoi(frac+strings.Repeat("0", 3-len(frac))) * 1_000_000
		}
	}
	if month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59 {
		return 0, false
	}
	offset := 0
	if tz := m[8]; tz != "" && tz != "Z" && tz != "z" {
		sign := 1
		if tz[0] == '-' {
			sign = -1
		}
		hh, mm, _ := strings.Cut(tz[1:], ":")
		offset = sign * (atoi(hh)*60 + atoi(mm)) * 60
	}
	t := time.Date(year, time.Month(month), day, hour, minute, second, nanos, time.UTC)
	return t.UnixMilli() - int64(offset)*1000, true
}

// fbParseExpires は expires の値をミリ秒にする。YYYY-MM-DD（UTC 0 時ちょうどの日時も同じ）はその日の 23:59:59.999（UTC）、
// それ以外は fbJsDateParse で解釈する。パースできない値は ok=false（無期限扱い）。
// YAML 1.1 では日付が Date に解決されるので、TS 版は UTC 0 時ちょうどの Date を日付のみの指定とみなしていた。
// Go 版の YAML は日付を文字列のまま返すので、timestamp の書き方に一致する文字列で同じ規則を当てる。
func fbParseExpires(v any) (int64, bool) {
	s, ok := v.(string)
	if !ok {
		return 0, false
	}
	text := fbNormalizeSlashDate(fbJsTrim(s))
	t, ok := fbJsDateParse(text)
	if !ok {
		return 0, false
	}
	if (fbDateOnlyRe.MatchString(text) || fbYamlTimestampRe.MatchString(text)) && t%fbDayMs == 0 {
		return t + fbDayMs - 1, true
	}
	return t, true
}

func fbJsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// fbStringList は文字列または配列を文字列だけのリストにそろえる。
func fbStringList(v any) []string {
	switch x := v.(type) {
	case string:
		return []string{x}
	case []any:
		out := []string{}
		for _, e := range x {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case []string:
		return x
	}
	return []string{}
}

// fbPatternList は asList(v)（文字列または配列。無ければ空）。配列に文字列でない要素があると、TS 版では
// glob の展開が TypeError になるので、ここではエラーにする（呼び出し側がその enforce の要素だけを飛ばす）。
func fbPatternList(v any) ([]string, error) {
	switch x := v.(type) {
	case string:
		return []string{x}, nil
	case []any:
		out := make([]string, len(x))
		for i, e := range x {
			s, ok := e.(string)
			if !ok {
				return nil, fmt.Errorf("TypeError: glob pattern must be a string, got %s", fbTypeName(e))
			}
			out[i] = s
		}
		return out, nil
	case []string:
		return x, nil
	}
	return []string{}, nil
}

func fbTypeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case []any, []string, []Dict:
		return "list"
	case map[string]any:
		return "mapping"
	case bool:
		return "boolean"
	case string:
		return "string"
	case int, int32, int64, uint64, float32, float64:
		return "number"
	}
	return "object"
}

// fbRegexFlags は when / unless を評価するイベントと、そのときのフラグ（EvalPreBash / EvalPreEdit / EvalPostEdit と同じ）。
var fbRegexFlags = map[string]string{"pre_bash": "", "pre_edit": "m", "post_edit": "m"}

var (
	fbLeadingFlagsRe = regexp.MustCompile(`^\(\?[aiLmsux]+\)`)
	fbModifierRe     = regexp.MustCompile(`^[a-zA-Z]*(?:-[a-zA-Z]*)?:`)
	fbGroupNameRe    = regexp.MustCompile(`^<[A-Za-z_$][\w$]*>`)
	fbPyNamedRe      = regexp.MustCompile(`^P(?:<[A-Za-z_]\w*>|=[A-Za-z_]\w*\))`)
)

// fbJsIncompatibleGroup は Python では書けるが JS の正規表現では不正な (?...) の書き方を見つける
// （先頭以外のインラインフラグ (?i)、コメント (?#...)、アトミックグループ (?>...)、条件分岐など）。
// regexp2（.NET 系）はこれらを受け付けてしまうので、TS 版（JS の RegExp）と同じく不正として扱うために別に検査する。
func fbJsIncompatibleGroup(source string) bool {
	src := source
	if m := fbLeadingFlagsRe.FindString(src); m != "" {
		src = src[len(m):]
	}
	inClass := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case c == '\\':
			i++
		case inClass:
			if c == ']' {
				inClass = false
			}
		case c == '[':
			inClass = true
			if i+1 < len(src) && src[i+1] == '^' {
				i++
			}
			if i+1 < len(src) && src[i+1] == ']' {
				i++
			}
		case c == '(' && i+1 < len(src) && src[i+1] == '?':
			if !fbValidJSGroupPrefix(src[i+2:]) {
				return true
			}
		}
	}
	return false
}

// fbValidJSGroupPrefix は "(?" の直後 rest が JS で使えるグループの書き方（Python の (?P<n>...) / (?P=n) を含む）か。
func fbValidJSGroupPrefix(rest string) bool {
	switch {
	case strings.HasPrefix(rest, ":"), strings.HasPrefix(rest, "="), strings.HasPrefix(rest, "!"),
		strings.HasPrefix(rest, "<="), strings.HasPrefix(rest, "<!"):
		return true
	}
	return fbGroupNameRe.MatchString(rest) || fbPyNamedRe.MatchString(rest) || fbModifierRe.MatchString(rest)
}

// fbCompilePyRegExp は PyRegExp に、JS の RegExp では不正になる書き方の検査を足したもの（TS 版の pyRegExp と同じ受け入れ範囲）。
func fbCompilePyRegExp(source, flags string) (*regexp2.Regexp, error) {
	re, err := PyRegExp(source, flags)
	if err != nil {
		return nil, err
	}
	if fbJsIncompatibleGroup(source) {
		return nil, fmt.Errorf("Invalid regular expression: /%s/: Invalid group", source) //nolint:staticcheck // JS のメッセージに合わせる
	}
	return re, nil
}

// NormalizeEnforce は frontmatter の enforce を「辞書のリスト」にそろえる。リストでなければ空、辞書でない要素と
// when / unless が使えない正規表現の要素は捨て、その理由を problems に入れる。
func NormalizeEnforce(io Io, raw any) ([]Dict, []string) {
	t := Tr(io.Lang())
	problems := []string{}
	enforce := []Dict{}
	if !Truthy(raw) {
		return enforce, problems
	}
	var list []any
	switch x := raw.(type) {
	case []any:
		list = x
	case []Dict:
		for _, d := range x {
			list = append(list, d)
		}
	default:
		return enforce, []string{t("rules.enforceNotList", map[string]any{"type": fbTypeName(raw)})}
	}
entries:
	for index, entry := range list {
		d, ok := entry.(map[string]any)
		if !ok {
			problems = append(problems, t("rules.enforceItemNotMapping", map[string]any{"index": index, "type": fbTypeName(entry)}))
			continue
		}
		if event, isStr := d["event"].(string); isStr {
			if flags, known := fbRegexFlags[event]; known {
				for _, key := range []string{"when", "unless"} {
					v := d[key]
					if !Truthy(v) {
						continue
					}
					if _, err := fbCompilePyRegExp(Str(v), flags); err != nil {
						problems = append(problems, t("rules.badRegex", map[string]any{"index": index, "key": key, "error": ErrorText(err)}))
						continue entries
					}
				}
			}
		}
		enforce = append(enforce, d)
	}
	return enforce, problems
}

// ErrorText は例外を 1 行の文字列にする（YAML のエラーは複数行なので先頭行だけ）。
func ErrorText(err error) string {
	if err == nil {
		return ""
	}
	first, _, _ := strings.Cut(err.Error(), "\n")
	return fbJsTrim(first)
}

// fbPanicError は recover した値を error にする。
func fbPanicError(r any) error {
	switch x := r.(type) {
	case error:
		return x
	case string:
		return errors.New(x)
	}
	return fmt.Errorf("%v", r)
}

// fbCatchResult は fn が panic しても error にして返す（TS 版の try/catch に当たる。hook は内部エラーで作業を止めない）。
func fbCatchResult(fn func() (ScriptResult, error)) (ScriptResult, error) {
	var res ScriptResult
	var err error
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = fbPanicError(r)
			}
		}()
		res, err = fn()
	}()
	return res, err
}

// LoadRule は 1 つの feedback ファイルから frontmatter を読む。frontmatter が無ければ ok=false
// （rules.md はこれで黙ってスキップされる）。frontmatter が YAML として読めなければエラーを返す
// （ListRules はそのファイルだけを飛ばす）。
func LoadRule(io Io, path string) (Rule, bool, error) {
	content, ok := io.ReadFile(path)
	if !ok {
		return Rule{}, false, nil
	}
	m := FrontmatterRe.FindStringSubmatch(content)
	if m == nil {
		return Rule{}, false, nil
	}
	parsed, err := LoadYamlText(m[1])
	if err != nil {
		return Rule{}, false, err
	}
	data, isDict := parsed.(map[string]any)
	if !isDict || !Truthy(data["name"]) {
		return Rule{}, false, nil
	}
	enforce, problems := NormalizeEnforce(io, data["enforce"])
	rule := Rule{
		Name:       Str(data["name"]),
		Count:      ToCount(data["count"]),
		Enforce:    enforce,
		Path:       path,
		Projects:   fbStringList(data["projects"]),
		WhenExists: fbStringList(data["when_exists"]),
	}
	if Truthy(data["description"]) {
		rule.Description = Str(data["description"])
	}
	if len(problems) > 0 {
		rule.Problems = problems
	}
	if ms, ok := fbParseExpires(data["expires"]); ok {
		rule.Expires = &ms
	}
	return rule, true, nil
}

// fbExpandTilde は先頭の ~ を HOME に展開する（HOME が無ければそのまま）。
func fbExpandTilde(io Io, pattern string) string {
	home := io.Env().Home
	if home == "" || (pattern != "~" && !strings.HasPrefix(pattern, "~/")) {
		return pattern
	}
	return Join(home, pattern[min(2, len(pattern)):])
}

// IsRuleActive はルールが今のプロジェクトで有効か。expires / projects / when_exists の3つすべてを満たしたときだけ true。
// projectDir 省略時は io.ProjectDir()（無ければ cwd）。glob が不正ならエラー。
func IsRuleActive(io Io, rule Rule, projectDir ...string) (bool, error) {
	if rule.Expires != nil && io.Now() > *rule.Expires {
		return false, nil
	}
	dir := fbFirstNonEmpty(fbOptDir(projectDir), io.ProjectDir(), io.Cwd())
	if len(rule.Projects) > 0 {
		expanded := make([]string, len(rule.Projects))
		for i, p := range rule.Projects {
			expanded[i] = fbExpandTilde(io, p)
		}
		rxs, err := CompileGlobs(expanded)
		if err != nil {
			return false, err
		}
		matched := false
		for _, rx := range rxs {
			if rx.MatchString(dir) {
				matched = true
				break
			}
		}
		if !matched {
			return false, nil
		}
	}
	if len(rule.WhenExists) > 0 {
		found := false
		for _, pattern := range rule.WhenExists {
			for _, expanded := range ExpandBraces(pattern) {
				if GlobExists(io, Join(dir, expanded)) {
					found = true
					break
				}
			}
			if found {
				break
			}
		}
		if !found {
			return false, nil
		}
	}
	return true, nil
}

// LoadBodyIntro はルール本文のうち、**Why:** / **言い訳:** / **How to apply:** より前の第1段落（最初の空行まで）を返す。
func LoadBodyIntro(io Io, path string) string {
	content, ok := io.ReadFile(path)
	if !ok {
		return ""
	}
	body := content
	if loc := FrontmatterRe.FindStringIndex(content); loc != nil {
		body = content[loc[1]:]
	}
	lead := body
	if stop := fbBodyStopRe.FindStringIndex(body); stop != nil {
		lead = body[:stop[0]]
	}
	lead = fbJsTrim(lead)
	if lead == "" {
		return ""
	}
	first, _, _ := strings.Cut(lead, "\n\n")
	return fbJsTrim(first)
}

// fbListRulesInAll は候補ディレクトリを優先順に読み、同名のルールは先の候補を採る
// （.claude と .agents が同じ実体を指すときに二重に読まないため）。
func fbListRulesInAll(io Io, dirs []string, broken *[]BrokenRule) []Rule {
	out := []Rule{}
	seen := map[string]bool{}
	for _, dir := range dirs {
		for _, rule := range fbListRulesIn(io, dir, broken) {
			if seen[rule.Name] {
				continue
			}
			seen[rule.Name] = true
			out = append(out, rule)
		}
	}
	return out
}

// fbListRulesIn は 1つのディレクトリ直下の *.md を名前順に走査し、frontmatter を持つものだけ返す。
// 読めないファイルは broken に入れて飛ばす。
func fbListRulesIn(io Io, d string, broken *[]BrokenRule) []Rule {
	rules := []Rule{}
	entries := io.List(d)
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name
	}
	sort.Strings(names)
	for _, name := range names {
		if !strings.HasSuffix(name, ".md") {
			continue
		}
		path := Join(d, name)
		rule, ok, err := LoadRule(io, path)
		if err != nil {
			*broken = append(*broken, BrokenRule{Path: path, Reason: Tr(io.Lang())("rules.unreadable", map[string]any{"error": ErrorText(err)})})
			continue
		}
		if ok {
			rules = append(rules, rule)
		}
	}
	return rules
}

func fbProblemsOf(rules []Rule) []BrokenRule {
	out := []BrokenRule{}
	for _, r := range rules {
		for _, reason := range r.Problems {
			out = append(out, BrokenRule{Path: r.Path, Reason: reason})
		}
	}
	return out
}

// ListRules は feedback ルールを全件読み、frontmatter を持つものだけ返す。
// feedbackDirPath を明示したときはそのディレクトリだけを読む。省略時はグローバル (FeedbackDir) と
// プロジェクト (ProjectFeedbackDir) の両方を読んでマージし、同名 (name) のルールはプロジェクト側を優先する。
// 返す順序はグローバル（上書きされたものを除く）→プロジェクト。
// マージ後に IsRuleActive で絞る（プロジェクト側の同名ルールが期限切れ・対象外のとき、グローバル側が復活しないように）。
// feedbackDirPath を明示したときはフィルタせず無加工で返す。
func ListRules(io Io, feedbackDirPath ...string) ([]Rule, error) {
	res, err := ScanRules(io, feedbackDirPath...)
	if err != nil {
		return nil, err
	}
	for _, b := range res.Broken {
		LogError(io, "rules", b.Reason, b.Path)
	}
	return res.Rules, nil
}

// ScanResult は ScanRules の結果。
type ScanResult struct {
	Rules  []Rule
	Broken []BrokenRule
}

// ScanRules は ListRules と同じ読み方で、ルールと壊れたルール（読めなかったファイルと、捨てた enforce の要素）を返す。
// ログには書かない。壊れたルールのうち enforce の要素の不備は、返すルール（マージ・フィルタ後）のものだけを含める。
func ScanRules(io Io, feedbackDirPath ...string) (ScanResult, error) {
	broken := []BrokenRule{}
	if len(feedbackDirPath) > 0 && feedbackDirPath[0] != "" {
		rules := fbListRulesIn(io, feedbackDirPath[0], &broken)
		return ScanResult{Rules: rules, Broken: append(broken, fbProblemsOf(rules)...)}, nil
	}
	globalDirs := FeedbackDirs(io)
	// グローバルと同じディレクトリをプロジェクト側でも読まない（CLAUDE_FEEDBACK_DIR をプロジェクトに向けるテスト）。
	projectDirs := []string{}
	for _, d := range ProjectFeedbackDirs(io) {
		if !fbContainsString(globalDirs, d) {
			projectDirs = append(projectDirs, d)
		}
	}
	globalRules := fbListRulesInAll(io, globalDirs, &broken)
	projectRules := fbListRulesInAll(io, projectDirs, &broken)
	overridden := map[string]bool{}
	for _, r := range projectRules {
		overridden[r.Name] = true
	}
	merged := []Rule{}
	for _, r := range globalRules {
		if !overridden[r.Name] {
			merged = append(merged, r)
		}
	}
	merged = append(merged, projectRules...)
	active := []Rule{}
	for _, r := range merged {
		ok, err := IsRuleActive(io, r)
		if err != nil {
			return ScanResult{}, err
		}
		if ok {
			active = append(active, r)
		}
	}
	return ScanResult{Rules: active, Broken: append(broken, fbProblemsOf(active)...)}, nil
}

func fbContainsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// ---- severity 解決 ----

// ResolveSeverity はルールに severity の明示があればそれを使い、無ければ count から決める。
// explicit は nil / "" で省略、event は "" で省略。
func ResolveSeverity(count any, explicit any, event string) string {
	if Truthy(explicit) {
		return Str(explicit)
	}
	n := ToCount(count)
	if n >= 5 {
		return "deny"
	}
	if n >= 3 {
		if event == "stop_check" || event == "post_edit" {
			return "block"
		}
		return "ask"
	}
	return "warn"
}

// ---- 違反ログ ----

// fbIsoTimestamp は new Date(ms).toISOString().replace('Z', '+00:00')。
func fbIsoTimestamp(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000") + "+00:00"
}

// LogViolation は ~/.claude/feedback/.violations.jsonl に1行 JSON を追記する。count は書き換えない
// （count の自動引き上げは AutoBumpCounts が別に行う）。ログ失敗で hook を止めないよう失敗は握りつぶす。
func LogViolation(io Io, rule string, count int, severity, event, detail string) {
	entry := OMap{{"ts", fbIsoTimestamp(io.Now())}, {"rule", rule}, {"count", count}, {"severity", severity}, {"event", event}, {"detail", detail}}
	path := ViolationsLogPath(io)
	existing, _ := io.ReadFile(path)
	_ = io.WriteFile(path, existing+JSONStringify(entry)+"\n")
}

// LogError は ~/.claude/feedback/.errors.jsonl に1行 JSON を追記する（壊れたルールと、hook が握りつぶした内部エラー）。
// hook は呼び出しのたびにルールを読み直すので、同じ (source, file, error) がすでにあれば書かない。
// file は省略可（省略と空文字は区別する）。ログ失敗で hook を止めないよう失敗は握りつぶす。
func LogError(io Io, source, errMsg string, file ...string) {
	path := ErrorsLogPath(io)
	existing, _ := io.ReadFile(path)
	hasFile := len(file) > 0
	same := func(line string) bool {
		var d map[string]any
		if err := json.Unmarshal([]byte(line), &d); err != nil {
			return false
		}
		if d["source"] != source || d["error"] != errMsg {
			return false
		}
		if !hasFile {
			return d["file"] == nil
		}
		return d["file"] == file[0]
	}
	for _, line := range strings.Split(existing, "\n") {
		if same(line) {
			return
		}
	}
	entry := OMap{{"ts", fbIsoTimestamp(io.Now())}, {"source", source}}
	if hasFile {
		entry = append(entry, KV{"file", file[0]})
	}
	entry = append(entry, KV{"error", errMsg})
	_ = io.WriteFile(path, existing+JSONStringify(entry)+"\n")
}

// fbLogEntryError は enforce の1要素の評価で出た例外を記録する（その要素だけを飛ばし、他の要素・ルールの評価は続ける）。
func fbLogEntryError(io Io, rule Rule, index int, err error) {
	LogError(io, "enforce", Tr(io.Lang())("rules.evalError", map[string]any{"index": index, "error": ErrorText(err)}), rule.Path)
}

// ---- count の自動引き上げ ----

// AutoCountMax は自動で上げる count の上限。ResolveSeverity が deny を返す最小の count。
const AutoCountMax = 5

// fbCountLineRe は frontmatter 内の `count: N` 行（数値リテラルのみ）。引用符付きや式は対象外。
// 第 1 グループが置き換える範囲（行末の \r は含めない）。
var fbCountLineRe = regexp.MustCompile(`(?m)^(count:[ \t]*(\d+)[ \t]*)\r?$`)

// ReadCountLine は frontmatter の `count:` 行の値を返す。frontmatter や数値の count 行が無ければ ok=false。
func ReadCountLine(content string) (int, bool) {
	fm := FrontmatterRe.FindString(content)
	if fm == "" {
		return 0, false
	}
	m := fbCountLineRe.FindStringSubmatch(fm)
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[2])
	if err != nil {
		return math.MaxInt, true
	}
	return n, true
}

// ReplaceCountLine は frontmatter の `count:` 行だけを `count: to` に置き換えた全文を返す。置き換えられなければ ok=false。
func ReplaceCountLine(content string, to int) (string, bool) {
	head := FrontmatterRe.FindString(content)
	if head == "" {
		return "", false
	}
	loc := fbCountLineRe.FindStringSubmatchIndex(head)
	if loc == nil {
		return "", false
	}
	return head[:loc[2]] + "count: " + strconv.Itoa(to) + head[loc[3]:] + content[len(head):], true
}

func fbRandomBase36(n int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return strings.Repeat("0", n)
	}
	for i, b := range buf {
		buf[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(buf)
}

// WriteFileAtomic は同じディレクトリの一時ファイルに書いてから mv で置き換える（読み手が書きかけのファイルを見ないように）。
// 一時ファイルは .md で終わらないので ListRules には拾われない。mv が使えなければ直接書く。
func WriteFileAtomic(io Io, path, text string) error {
	tmp := Join(Dirname(path), fmt.Sprintf(".%s.%d-%s.tmp", Basename(path), io.Now(), fbRandomBase36(6)))
	if err := io.WriteFile(tmp, text); err == nil {
		r := io.Run([]string{"mv", "-f", "--", tmp, path}, RunOptions{TimeoutMs: 5_000})
		if r.ExitCode == 0 && !r.TimedOut && r.Error == "" {
			return nil
		}
	}
	io.RemoveFiles([]string{tmp})
	return io.WriteFile(path, text)
}

// CountBump は count を上げたルール 1 件。
type CountBump struct {
	Rule string
	Path string
	From int
	To   int
}

var fbNonSessionCharRe = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// CountStatePath はセッション内で count を自動で上げ済みのルール名を持つ状態ファイル
// （~/.claude/feedback/.count_state/<session>.json）。
func CountStatePath(io Io, sessionID string) string {
	return Join(FeedbackDir(io), ".count_state", fbNonSessionCharRe.ReplaceAllString(sessionID, "")+".json")
}

// fbLoadNameSet は {key: [...]} 形式の状態ファイルから文字列の集合を読む。壊れた状態ファイルは空扱い。
func fbLoadNameSet(io Io, path, key string) map[string]bool {
	set := map[string]bool{}
	text, ok := io.ReadFile(path)
	if !ok {
		return set
	}
	var data any
	if err := json.Unmarshal([]byte(text), &data); err != nil {
		return set
	}
	if d, isDict := data.(map[string]any); isDict {
		if list, isList := d[key].([]any); isList {
			for _, e := range list {
				set[Str(e)] = true
			}
		}
	}
	return set
}

func fbSortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// AutoBumpCounts は違反したルールのファイルの count を 1 つ上げる（frontmatter の `count:` 行だけを書き換える）。
//   - 対象は rules（ListRules のマージ後）で実際に使われたファイル。同名ならプロジェクト側。
//   - 同じセッションでは同じルール名につき 1 回だけ（次のセッションでまた違反すればまた上がる）。
//   - AutoCountMax（deny になる count）以上には上げない。
//   - io.AutoCount() が false（プラグイン設定 autoCount: false）や session_id が無いときは何もしない。
//
// 失敗しても hook を止めないよう失敗は握りつぶし、上げられたものだけを返す。
func AutoBumpCounts(io Io, rules []Rule, violations []Violation, sessionID any) []CountBump {
	bumps := []CountBump{}
	if !io.AutoCount() || !Truthy(sessionID) || len(violations) == 0 {
		return bumps
	}
	sid := Str(sessionID)
	done := fbLoadNameSet(io, CountStatePath(io, sid), "bumped")
	names := []string{}
	seen := map[string]bool{}
	for _, v := range violations {
		if !seen[v.Rule] && !done[v.Rule] {
			names = append(names, v.Rule)
		}
		seen[v.Rule] = true
	}
	if len(names) == 0 {
		return bumps
	}
	for _, name := range names {
		idx := -1
		for i, r := range rules {
			if r.Name == name {
				idx = i
				break
			}
		}
		if idx < 0 {
			continue
		}
		rule := rules[idx]
		content, ok := io.ReadFile(rule.Path)
		if !ok {
			continue
		}
		from, ok := ReadCountLine(content)
		if !ok || from >= AutoCountMax {
			continue
		}
		next, ok := ReplaceCountLine(content, from+1)
		if !ok {
			continue
		}
		if err := WriteFileAtomic(io, rule.Path, next); err != nil {
			continue // このルールは諦めて次へ
		}
		bumps = append(bumps, CountBump{Rule: name, Path: rule.Path, From: from, To: from + 1})
		done[name] = true
	}
	if len(bumps) > 0 {
		_ = io.WriteFile(CountStatePath(io, sid), JSONStringify(OMap{{"bumped", fbSortedKeys(done)}}))
	}
	return bumps
}

// CountBumpNotes は count を上げたことをモデルとユーザーに伝える行。
func CountBumpNotes(lang Lang, bumps []CountBump) []string {
	t := Tr(lang)
	out := make([]string, len(bumps))
	for i, b := range bumps {
		out[i] = t("autoCount.bumped", map[string]any{"rule": b.Rule, "from": b.From, "to": b.To, "path": b.Path})
	}
	return out
}

// ---- pre_edit: テストファイル自身の自己参照を防ぐ ----

var (
	fbTestGoRe     = regexp.MustCompile(`_test\.go$`)
	fbTestTsRe     = regexp.MustCompile(`\.(test|spec)\.tsx?$`)
	fbTestRbRe     = regexp.MustCompile(`_(spec|test)\.rb$`)
	fbTestPyPrefix = regexp.MustCompile(`^test_.*\.py$`)
	fbTestPySuffix = regexp.MustCompile(`_test\.py$`)
)

// LooksLikeTestFile はファイル名がテストファイルの命名規則に一致するか。
func LooksLikeTestFile(name string) bool {
	return fbTestGoRe.MatchString(name) || fbTestTsRe.MatchString(name) || fbTestRbRe.MatchString(name) ||
		fbTestPyPrefix.MatchString(name) || fbTestPySuffix.MatchString(name)
}

// StemVariants は kebab-case / snake_case の表記ゆれを吸収するため、stem 自身に加えて '-' <-> '_' を入れ替えた候補を返す。
func StemVariants(stem string) []string {
	variants := []string{stem}
	if strings.Contains(stem, "-") {
		if alt := strings.ReplaceAll(stem, "-", "_"); !fbContainsString(variants, alt) {
			variants = append(variants, alt)
		}
	}
	if strings.Contains(stem, "_") {
		if alt := strings.ReplaceAll(stem, "_", "-"); !fbContainsString(variants, alt) {
			variants = append(variants, alt)
		}
	}
	return variants
}

func fbStemBrace(stem string) string {
	variants := StemVariants(stem)
	if len(variants) == 1 {
		return variants[0]
	}
	return "{" + strings.Join(variants, ",") + "}"
}

func fbStemOf(path string) string {
	root, _ := Splitext(Basename(path))
	return root
}

// ExpandStem は {stem} を kebab-case/snake_case 双方の候補に展開し、全候補の文字列を返す。
func ExpandStem(pattern, path string) []string {
	return ExpandBraces(strings.ReplaceAll(pattern, "{stem}", fbStemBrace(fbStemOf(path))))
}

// ExpandTestPattern は absent_glob の {stem} と {dir}（プロジェクト相対ディレクトリ）を展開する。
// 呼び出し側で ExpandBraces にかける前提。
func ExpandTestPattern(pattern, relPath string) string {
	dir := Dirname(relPath)
	if dir == "" {
		dir = "."
	}
	return strings.ReplaceAll(strings.ReplaceAll(pattern, "{stem}", fbStemBrace(fbStemOf(relPath))), "{dir}", dir)
}

// ExtractPreEditContent は Edit/Write/MultiEdit の tool_input から検査対象の文字列を取り出す。
func ExtractPreEditContent(toolName string, toolInput Dict) string {
	s := func(v any) string {
		if Truthy(v) {
			return Str(v)
		}
		return ""
	}
	switch toolName {
	case "Write":
		return s(toolInput["content"])
	case "Edit":
		return s(toolInput["new_string"])
	case "MultiEdit":
		edits, _ := toolInput["edits"].([]any)
		parts := []string{}
		for _, e := range edits {
			if d, ok := e.(map[string]any); ok {
				parts = append(parts, s(d["new_string"]))
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

var fbShellArgv = []string{"sh", "-c"}

func fbShellCommand(cmd any) []string { return append(append([]string{}, fbShellArgv...), Str(cmd)) }

// fbRanOk は check コマンドが 0 終了で正常に動いたか。
func fbRanOk(r RunResult) bool { return r.ExitCode == 0 && !r.TimedOut && r.Error == "" }

// fbEvalFn は enforce の 1 要素を評価する。違反なら (違反, true, nil)、違反でなければ (_, false, nil)、評価できなければエラー。
type fbEvalFn func(rule Rule, entry Dict) (Violation, bool, error)

// fbEvalEntries は rules の enforce のうち event の要素を順に fn で評価し、返った違反を集める。fn が失敗した要素
// （不正な正規表現など）はその要素だけを飛ばして .errors.jsonl に残し、他の要素・ルールの評価は続ける。
func fbEvalEntries(io Io, rules []Rule, event string, fn fbEvalFn) []Violation {
	violations := []Violation{}
	for _, rule := range rules {
		for index, entry := range rule.Enforce {
			if entry == nil || entry["event"] != event {
				continue
			}
			v, found, err := fbCallEval(fn, rule, entry)
			if err != nil {
				fbLogEntryError(io, rule, index, err)
				continue
			}
			if found {
				violations = append(violations, v)
			}
		}
	}
	return violations
}

func fbCallEval(fn fbEvalFn, rule Rule, entry Dict) (Violation, bool, error) {
	var v Violation
	var found bool
	var err error
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = fbPanicError(r)
			}
		}()
		v, found, err = fn(rule, entry)
	}()
	return v, found, err
}

func fbMessageOf(entry Dict) string {
	if Truthy(entry["message"]) {
		return Str(entry["message"])
	}
	return ""
}

// fbAnyGlobMatch は patterns のどれかが rel にマッチするか。
func fbAnyGlobMatch(patterns []string, rel string) (bool, error) {
	rxs, err := CompileGlobs(patterns)
	if err != nil {
		return false, err
	}
	for _, rx := range rxs {
		if rx.MatchString(rel) {
			return true, nil
		}
	}
	return false, nil
}

// fbPathFilter は entry の path / exclude_path で rel が検査対象かを決める。
func fbPathFilter(entry Dict, rel string) (bool, error) {
	patterns, err := fbPatternList(entry["path"])
	if err != nil {
		return false, err
	}
	if len(patterns) == 0 {
		return false, nil
	}
	if ok, err := fbAnyGlobMatch(patterns, rel); err != nil || !ok {
		return false, err
	}
	excl, err := fbPatternList(entry["exclude_path"])
	if err != nil {
		return false, err
	}
	if len(excl) > 0 {
		if ok, err := fbAnyGlobMatch(excl, rel); err != nil || ok {
			return false, err
		}
	}
	return true, nil
}

// fbWhenMatches は entry の when が text にマッチし、かつ unless がマッチしないか（flags は pyRegExp のフラグ）。
// when が無ければ false。when → unless の順にコンパイルし、when がマッチしなければ unless は見ない。
func fbWhenMatches(entry Dict, text, flags string) (bool, error) {
	when := entry["when"]
	if !Truthy(when) {
		return false, nil
	}
	re, err := fbCompilePyRegExp(Str(when), flags)
	if err != nil {
		return false, err
	}
	if !PyMatch(re, text) {
		return false, nil
	}
	if unless := entry["unless"]; Truthy(unless) {
		ure, err := fbCompilePyRegExp(Str(unless), flags)
		if err != nil {
			return false, err
		}
		if PyMatch(ure, text) {
			return false, nil
		}
	}
	return true, nil
}

// ---- enforce 評価: pre_bash ----

// EvalPreBash は pre_bash の enforce を command に対して評価する。
func EvalPreBash(io Io, rules []Rule, command string, projectDir ...string) []Violation {
	dir := fbFirstNonEmpty(fbOptDir(projectDir), io.ProjectDir(), io.Cwd())
	if command == "" {
		return []Violation{}
	}
	return fbEvalEntries(io, rules, "pre_bash", func(rule Rule, entry Dict) (Violation, bool, error) {
		if ok, err := fbWhenMatches(entry, command, ""); err != nil || !ok {
			return Violation{}, false, err
		}
		if checkCmd := entry["check"]; Truthy(checkCmd) {
			io.Progress(Tr(io.Lang())("guard.evaluating", map[string]any{"rule": rule.Name}))
			r := io.Run(fbShellCommand(checkCmd), RunOptions{Cwd: dir, Env: map[string]string{"CLAUDE_PROJECT_DIR": dir}, TimeoutMs: 10_000})
			// 非0終了で違反確定。0終了なら違反ではない。check 自体が動かせない場合は when 一致のみで違反扱いにする。
			if fbRanOk(r) {
				return Violation{}, false, nil
			}
		}
		return Violation{
			Rule: rule.Name, Count: rule.Count, Severity: ResolveSeverity(rule.Count, entry["severity"], "pre_bash"),
			Event: "pre_bash", Message: fbMessageOf(entry), Detail: "command matched: " + Str(entry["when"]),
		}, true, nil
	})
}

// ---- enforce 評価: pre_edit ----

// fbAbsentTestMissing は absent_sibling / absent_glob の判定。テストファイルが見つからなければ missing=true と候補の一覧を返す。
func fbAbsentTestMissing(io Io, entry Dict, filePath, root, rel string) (bool, []string, error) {
	absentGlobs, err := fbPatternList(entry["absent_glob"])
	if err != nil {
		return false, nil, err
	}
	absentSibling := entry["absent_sibling"]
	candidates := []string{}
	found := false
	if Truthy(absentSibling) {
		sibNames := ExpandStem(Str(absentSibling), filePath)
		candidates = append(candidates, sibNames...)
		for _, sib := range sibNames {
			if io.Exists(Join(Dirname(filePath), sib)) {
				found = true
				break
			}
		}
	}
	for _, pat := range absentGlobs {
		if found {
			break
		}
		for _, expanded := range ExpandBraces(ExpandTestPattern(pat, rel)) {
			candidates = append(candidates, expanded)
			if GlobExists(io, Join(root, expanded)) {
				found = true
				break
			}
		}
	}
	return !found, candidates, nil
}

// fbPreEditDetail は pre_edit の要素の判定。違反なら detail と found=true を返す。
// absent_sibling / absent_glob があればテストファイルの有無で、無ければ content への when / unless で判定する。
func fbPreEditDetail(io Io, entry Dict, filePath, root, rel, content string) (string, bool, error) {
	absentGlobs, err := fbPatternList(entry["absent_glob"])
	if err != nil {
		return "", false, err
	}
	if Truthy(entry["absent_sibling"]) || len(absentGlobs) > 0 {
		if LooksLikeTestFile(Basename(filePath)) {
			return "", false, nil // テストファイル自身は対象外
		}
		missing, candidates, err := fbAbsentTestMissing(io, entry, filePath, root, rel)
		if err != nil || !missing {
			return "", false, err
		}
		return "missing test file: " + strings.Join(candidates, ", "), true, nil
	}
	ok, err := fbWhenMatches(entry, content, "m")
	if err != nil || !ok {
		return "", false, err
	}
	return "content matched: " + Str(entry["when"]), true, nil
}

// EvalPreEdit は pre_edit の enforce を filePath と変更後の内容 content に対して評価する。
func EvalPreEdit(io Io, rules []Rule, filePath, content string, projectDir ...string) []Violation {
	dir := fbFirstNonEmpty(fbOptDir(projectDir), io.ProjectDir(), io.Cwd())
	root, rel := SplitRoot(dir, filePath)
	return fbEvalEntries(io, rules, "pre_edit", func(rule Rule, entry Dict) (Violation, bool, error) {
		if ok, err := fbPathFilter(entry, rel); err != nil || !ok {
			return Violation{}, false, err
		}
		detail, found, err := fbPreEditDetail(io, entry, filePath, root, rel, content)
		if err != nil || !found {
			return Violation{}, false, err
		}
		return Violation{
			Rule: rule.Name, Count: rule.Count, Severity: ResolveSeverity(rule.Count, entry["severity"], "pre_edit"),
			Event: "pre_edit", Message: fbMessageOf(entry), Detail: detail,
		}, true, nil
	})
}

// ---- enforce 評価: post_edit ----

// EvalPostEdit は編集後のファイル（ディスク上の全文）を検査する。読めないファイルは対象外（違反なし）。
func EvalPostEdit(io Io, rules []Rule, filePath string, projectDir ...string) []Violation {
	dir := fbFirstNonEmpty(fbOptDir(projectDir), io.ProjectDir(), io.Cwd())
	root, rel := SplitRoot(dir, filePath)
	absPath := filePath
	if !IsAbsolute(filePath) {
		absPath = Join(dir, filePath)
	}
	var text string
	loaded, unreadable := false, false
	return fbEvalEntries(io, rules, "post_edit", func(rule Rule, entry Dict) (Violation, bool, error) {
		if unreadable {
			return Violation{}, false, nil
		}
		if ok, err := fbPathFilter(entry, rel); err != nil || !ok {
			return Violation{}, false, err
		}
		// when / check のどちらも無い要素は無視する
		when, checkCmd := entry["when"], entry["check"]
		if !Truthy(when) && !Truthy(checkCmd) {
			return Violation{}, false, nil
		}
		if !loaded {
			t, ok := io.ReadFile(absPath)
			if !ok {
				unreadable = true
				return Violation{}, false, nil
			}
			text, loaded = t, true
		}
		details := []string{}
		if Truthy(when) {
			if ok, err := fbWhenMatches(entry, text, "m"); err != nil || !ok {
				return Violation{}, false, err
			}
			details = append(details, "content matched: "+Str(when))
		}
		if Truthy(checkCmd) {
			io.Progress(Tr(io.Lang())("postEdit.checking", map[string]any{"rule": rule.Name, "file": absPath}))
			r := io.Run(fbShellCommand(checkCmd), RunOptions{Cwd: root, Env: map[string]string{"CLAUDE_PROJECT_DIR": dir, "FILE": absPath}, TimeoutMs: 15_000})
			// 非0終了（タイムアウト・実行不能を含む）で違反確定。0終了なら違反ではない。
			if fbRanOk(r) {
				return Violation{}, false, nil
			}
			details = append(details, "check failed: "+Str(checkCmd))
		}
		return Violation{
			Rule: rule.Name, Count: rule.Count, Severity: ResolveSeverity(rule.Count, entry["severity"], "post_edit"),
			Event: "post_edit", Message: fbMessageOf(entry), Detail: strings.Join(details, ", "),
		}, true, nil
	})
}

// ---- enforce 評価: stop_check ----

// fbSplitLinesCRLF は JS の split(/\r?\n/)。
func fbSplitLinesCRLF(s string) []string {
	return strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
}

func fbReadLines(io Io, path string) ([]string, bool) {
	text, ok := io.ReadFile(path)
	if !ok {
		return nil, false
	}
	out := []string{}
	for _, l := range fbSplitLinesCRLF(text) {
		if t := fbJsTrim(l); t != "" {
			out = append(out, t)
		}
	}
	return out, true
}

func fbGitFallbackFiles(io Io, cwd string) []string {
	files := map[string]bool{}
	for _, args := range [][]string{{"git", "diff", "--name-only", "HEAD"}, {"git", "ls-files", "--others", "--exclude-standard"}} {
		r := io.Run(args, RunOptions{Cwd: cwd, TimeoutMs: 10_000})
		if fbRanOk(r) {
			for _, l := range fbSplitLinesCRLF(r.Stdout) {
				if t := fbJsTrim(l); t != "" {
					files[t] = true
				}
			}
		}
	}
	return fbSortedKeys(files)
}

// GetChangedFiles は record-changes が書く changed_files.<state_id>.txt を優先して読む。このファイルは gate.yaml を持つ
// プロジェクトでしか作られないため、無ければ git でフォールバックする。gate 側が成功時にメモを消費する
// ため、フォールバック経路は必須。
//
// agentID 指定時（サブエージェントの Stop）は changed_files.<session>--<agent>.txt だけを読む。メモが
// 無ければ、そのエージェントの worktree（.claude/worktrees/agent-<agentId>）があればそこを cwd に git
// フォールバックし、worktree ルートを付けた絶対パスで返す。worktree が無ければ projectDir で git
// フォールバックする。
//
// agentID 未指定（メインの Stop）は changed_files.<session>.txt に加え changed_files.<session>--*.txt を
// 全部読んで順序を保ってマージ・重複排除する。メモが1つも無いときだけ projectDir で git フォールバックする。
func GetChangedFiles(io Io, projectDir, sessionID string, agentID ...string) []string {
	stateDir := GateStatusDir(io)
	if len(agentID) > 0 && agentID[0] != "" {
		agent := agentID[0]
		if lines, ok := fbReadLines(io, Join(stateDir, "changed_files."+sessionID+"--"+agent+".txt")); ok {
			return lines
		}
		worktree := Join(projectDir, ".claude", "worktrees", "agent-"+agent)
		if st, ok := io.Stat(worktree); ok && st.Kind == KindDir {
			files := fbGitFallbackFiles(io, worktree)
			out := make([]string, len(files))
			for i, f := range files {
				out[i] = Join(worktree, f)
			}
			return out
		}
		return fbGitFallbackFiles(io, projectDir)
	}

	seen := map[string]bool{}
	merged := []string{}
	foundAny := false
	add := func(lines []string) {
		for _, l := range lines {
			if !seen[l] {
				seen[l] = true
				merged = append(merged, l)
			}
		}
	}
	if plain, ok := fbReadLines(io, Join(stateDir, "changed_files."+sessionID+".txt")); ok {
		foundAny = true
		add(plain)
	}
	prefix := "changed_files." + sessionID + "--"
	agentMemos := []string{}
	for _, e := range io.List(stateDir) {
		n := e.Name
		if strings.HasPrefix(n, prefix) && strings.HasSuffix(n, ".txt") && len(n) >= len(prefix)+4 {
			agentMemos = append(agentMemos, n)
		}
	}
	sort.Strings(agentMemos)
	for _, name := range agentMemos {
		foundAny = true
		lines, _ := fbReadLines(io, Join(stateDir, name))
		add(lines)
	}
	if foundAny {
		return merged
	}
	return fbGitFallbackFiles(io, projectDir)
}

// EvalStopCheck は stop_check の enforce を、セッションの変更ファイルに対して評価する。
func EvalStopCheck(io Io, rules []Rule, projectDir string, changedFiles []string) []Violation {
	type keyed struct{ root, rel string }
	keys := make([]keyed, len(changedFiles))
	for i, f := range changedFiles {
		root, rel := SplitRoot(projectDir, f)
		keys[i] = keyed{root, rel}
	}
	return fbEvalEntries(io, rules, "stop_check", func(rule Rule, entry Dict) (Violation, bool, error) {
		patterns, err := fbPatternList(entry["changed"])
		if err != nil || len(patterns) == 0 {
			return Violation{}, false, err
		}
		rxs, err := CompileGlobs(patterns)
		if err != nil {
			return Violation{}, false, err
		}
		matchedKeys := map[string]bool{}
		for _, k := range keys {
			for _, rx := range rxs {
				if rx.MatchString(k.rel) {
					matchedKeys[k.root+"\x00"+k.rel] = true
					break
				}
			}
		}
		matched := fbSortedKeys(matchedKeys)
		if len(matched) == 0 {
			return Violation{}, false, nil
		}

		checkCmd, requireSibling := entry["check"], entry["require_sibling"]
		badFiles := []string{}
		for _, k := range matched {
			root, rel, _ := strings.Cut(k, "\x00")
			absPath := Join(root, rel)
			// セッション中に削除されたファイル（worktree ごと消えた場合など）は検査対象が無いので飛ばす
			if !io.Exists(absPath) {
				continue
			}
			bad := false
			if Truthy(requireSibling) {
				anySibling := false
				for _, sib := range ExpandStem(Str(requireSibling), absPath) {
					if io.Exists(Join(Dirname(absPath), sib)) {
						anySibling = true
						break
					}
				}
				if !anySibling {
					bad = true
				}
			}
			if Truthy(checkCmd) {
				io.Progress(Tr(io.Lang())("stopCheck.checking", map[string]any{"rule": rule.Name, "file": absPath}))
				r := io.Run(fbShellCommand(checkCmd), RunOptions{Cwd: root, Env: map[string]string{"CLAUDE_PROJECT_DIR": projectDir, "FILE": absPath}, TimeoutMs: 15_000})
				if !fbRanOk(r) {
					bad = true
				}
			}
			if bad {
				if root == projectDir {
					badFiles = append(badFiles, rel)
				} else {
					badFiles = append(badFiles, Basename(root)+"/"+rel)
				}
			}
		}
		if len(badFiles) == 0 {
			return Violation{}, false, nil
		}
		return Violation{
			Rule: rule.Name, Count: rule.Count, Severity: ResolveSeverity(rule.Count, entry["severity"], "stop_check"),
			Event: "stop_check", Message: fbMessageOf(entry), Detail: "changed files violating: " + strings.Join(badFiles, ", "),
		}, true, nil
	})
}
