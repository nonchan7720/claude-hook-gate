package hookgate

// hook が出すメッセージ（feedback の指示文・gate の結果・通知・/correct の報告）の言語と翻訳。
//
// 言語の決め方は、プラグイン設定（userConfig の `language`）が `ja` / `en` ならそれ。`auto`（既定）か未設定なら
// OS の言語設定を環境変数から読む: FEEDBACK_GATE_LANG（このプラグイン専用の上書き）→ LC_ALL → LC_MESSAGES → LANG の
// 順に、最初に値のあるものを使い、`ja` で始まれば日本語、それ以外（`C` / `POSIX` / 未設定を含む）は英語。
//
// 文面は locales/<lang>.yaml にあり（go:embed で取り込む）、各モジュールは `Tr(io.Lang())` で得た翻訳関数に
// キー（例: 'gate.timeout'）と補間値（{{seconds}}）を渡す。無いキーは en、それも無ければキーそのものを返す。

import (
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/nonchan7720/claude-hook-gate/locales"
)

// Lang はメッセージの言語。
type Lang string

// 対応する言語。
const (
	LangJA Lang = "ja"
	LangEN Lang = "en"
)

// LANGS は対応する言語（ja が先）。
var LANGS = []Lang{LangJA, LangEN}

// Translate はキー（ネストは `.` 区切り）と補間値から文面を返す。補間値は複数渡すと後勝ちでまとめる。
type Translate func(key string, args ...map[string]any) string

// Resources は言語ごとの文面（locales/*.yaml を読んだもの）。キーの一致はテストで検査する。
var Resources = map[Lang]map[string]any{
	LangJA: mustParseCatalog(locales.JA),
	LangEN: mustParseCatalog(locales.EN),
}

func mustParseCatalog(b []byte) map[string]any {
	var m map[string]any
	if err := yaml.Unmarshal(b, &m); err != nil {
		panic("locales: " + err.Error())
	}
	return m
}

var interpolationRe = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)

func lookupCatalog(lang Lang, key string) (string, bool) {
	var cur any = Resources[lang]
	for _, part := range strings.Split(key, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return "", false
		}
		cur, ok = m[part]
		if !ok {
			return "", false
		}
	}
	s, ok := cur.(string)
	return s, ok
}

// Tr は lang で引く翻訳関数を返す。補間は HTML エスケープせず、値の中の {{ }} も展開しない。
func Tr(lang Lang) Translate {
	return func(key string, args ...map[string]any) string {
		text, ok := lookupCatalog(lang, key)
		if !ok {
			text, ok = lookupCatalog(LangEN, key)
		}
		if !ok {
			return key
		}
		vars := map[string]any{}
		for _, a := range args {
			for k, v := range a {
				vars[k] = v
			}
		}
		return interpolationRe.ReplaceAllStringFunc(text, func(m string) string {
			name := interpolationRe.FindStringSubmatch(m)[1]
			v, ok := vars[name]
			if !ok || v == nil {
				return ""
			}
			return Str(v)
		})
	}
}

func isLang(v string) bool { return v == "ja" || v == "en" }

// LangOfLocale はロケール文字列（`ja_JP.UTF-8` / `ja` / `en_US` / `C`）から言語を決める。空なら ("", false)。
func LangOfLocale(locale string) (Lang, bool) {
	v := strings.TrimSpace(locale)
	if v == "" {
		return "", false
	}
	if len(v) >= 2 && strings.EqualFold(v[:2], "ja") {
		if len(v) == 2 || !isASCIILetter(v[2]) {
			return LangJA, true
		}
	}
	return LangEN, true
}

func isASCIILetter(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

// ResolveLang は言語を決める。configured（プラグイン設定の `language`）が ja / en ならそれ、それ以外（auto / 空 / 不正値）なら
// 環境変数から。どれにも値が無ければ英語。
func ResolveLang(env EnvVars, configured string) Lang {
	if isLang(configured) {
		return Lang(configured)
	}
	if isLang(env.FeedbackGateLang) {
		return Lang(env.FeedbackGateLang)
	}
	for _, v := range []string{env.FeedbackGateLang, env.LCAll, env.LCMessages, env.LangEnv} {
		if lang, ok := LangOfLocale(v); ok {
			return lang
		}
	}
	return LangEN
}
