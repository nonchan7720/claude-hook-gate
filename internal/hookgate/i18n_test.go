package hookgate

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"gopkg.in/yaml.v3"

	"github.com/nonchan7720/claude-hook-gate/locales"
)

func TestLangOfLocale(t *testing.T) {
	t.Run("ja で始まるロケールは ja、それ以外は en、空は undefined", func(t *testing.T) {
		for locale, want := range map[string]Lang{
			"ja_JP.UTF-8": LangJA, "ja": LangJA, "JA_JP": LangJA,
			"en_US.UTF-8": LangEN, "C": LangEN, "POSIX": LangEN, "de_DE": LangEN,
			// ja の後に英字が続くものは別の言語（jav = Javanese）
			"jav_ID": LangEN,
		} {
			got, ok := LangOfLocale(locale)
			assert.True(t, ok, locale)
			assert.Equal(t, want, got, locale)
		}
		for _, empty := range []string{"", "  "} {
			_, ok := LangOfLocale(empty)
			assert.False(t, ok, empty)
		}
	})
}

func TestResolveLang(t *testing.T) {
	t.Run("プラグイン設定の ja / en が最優先", func(t *testing.T) {
		assert.Equal(t, LangJA, ResolveLang(EnvVars{LangEnv: "en_US.UTF-8"}, "ja"))
		assert.Equal(t, LangEN, ResolveLang(EnvVars{LangEnv: "ja_JP.UTF-8", FeedbackGateLang: "ja"}, "en"))
	})

	t.Run("auto / 未設定 / 不正値は環境変数から決める", func(t *testing.T) {
		ja := EnvVars{LangEnv: "ja_JP.UTF-8"}
		assert.Equal(t, LangJA, ResolveLang(ja, "auto"))
		assert.Equal(t, LangJA, ResolveLang(ja, ""))
		assert.Equal(t, LangJA, ResolveLang(ja, "fr"))
		assert.Equal(t, LangEN, ResolveLang(EnvVars{LangEnv: "en_US.UTF-8"}, "auto"))
	})

	t.Run("環境変数は FEEDBACK_GATE_LANG → LC_ALL → LC_MESSAGES → LANG の順に最初の値を使う", func(t *testing.T) {
		assert.Equal(t, LangEN, ResolveLang(EnvVars{FeedbackGateLang: "en", LCAll: "ja_JP.UTF-8", LangEnv: "ja_JP.UTF-8"}, ""))
		assert.Equal(t, LangJA, ResolveLang(EnvVars{FeedbackGateLang: "ja", LCAll: "C", LangEnv: "C"}, ""))
		assert.Equal(t, LangEN, ResolveLang(EnvVars{LCAll: "C", LCMessages: "ja_JP.UTF-8", LangEnv: "ja_JP.UTF-8"}, ""))
		assert.Equal(t, LangJA, ResolveLang(EnvVars{LCMessages: "ja_JP.UTF-8", LangEnv: "C"}, ""))
		assert.Equal(t, LangJA, ResolveLang(EnvVars{LCAll: "", LCMessages: "", LangEnv: "ja_JP.UTF-8"}, ""))
	})

	t.Run("どれにも値が無ければ en", func(t *testing.T) {
		assert.Equal(t, LangEN, ResolveLang(EnvVars{}, ""))
		assert.Equal(t, LangEN, ResolveLang(EnvVars{Home: "/h", LangEnv: ""}, ""))
	})
}

// flatKeys はネストしたカタログを 'a.b.c' 形式のキーの一覧にする。
func flatKeys(obj map[string]any, prefix string) []string {
	var out []string
	for k, v := range obj {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		if m, ok := v.(map[string]any); ok {
			out = append(out, flatKeys(m, key)...)
		} else {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

var placeholderRe = regexp.MustCompile(`\{\{(\w+)\}\}`)

// placeholders は文面に含まれる補間変数（{{name}}）の集合。
func placeholders(text any) []string {
	out := []string{}
	for _, m := range placeholderRe.FindAllStringSubmatch(fmt.Sprint(text), -1) {
		out = append(out, m[1])
	}
	sort.Strings(out)
	return out
}

func lookup(obj map[string]any, key string) any {
	var cur any = obj
	for _, k := range strings.Split(key, ".") {
		cur = cur.(map[string]any)[k]
	}
	return cur
}

func TestLocales(t *testing.T) {
	t.Run("embed has both languages and they parse", func(t *testing.T) {
		assert.NotEmpty(t, locales.EN)
		assert.NotEmpty(t, locales.JA)
		var en, ja map[string]any
		assert.NoError(t, yaml.Unmarshal(locales.EN, &en))
		assert.NoError(t, yaml.Unmarshal(locales.JA, &ja))
		assert.Equal(t, flatKeys(en, ""), flatKeys(ja, ""))
	})

	t.Run("ja と en は同じキーを持つ", func(t *testing.T) {
		assert.Equal(t, []Lang{"ja", "en"}, LANGS)
		assert.Equal(t, flatKeys(Resources[LangJA], ""), flatKeys(Resources[LangEN], ""))
		assert.Greater(t, len(flatKeys(Resources[LangJA], "")), 50)
	})

	t.Run("同じキーの文面は同じ補間変数を使う", func(t *testing.T) {
		for _, key := range flatKeys(Resources[LangJA], "") {
			assert.Equal(t, placeholders(lookup(Resources[LangJA], key)), placeholders(lookup(Resources[LangEN], key)), key)
		}
	})

	t.Run("すべての値は文字列", func(t *testing.T) {
		for _, lang := range LANGS {
			for _, key := range flatKeys(Resources[lang], "") {
				_, ok := lookup(Resources[lang], key).(string)
				assert.True(t, ok, "%s %s", lang, key)
			}
		}
	})
}

func TestTr(t *testing.T) {
	t.Run("lang に応じた文面を補間付きで引く", func(t *testing.T) {
		assert.Equal(t, "[gate] タイムアウト（30秒）で強制終了しました。無限ループやハングの可能性があります。", Tr(LangJA)("gate.timeout", map[string]any{"seconds": 30}))
		assert.Equal(t, "[gate] Killed after the timeout (30s). The command may be in an infinite loop or hung.", Tr(LangEN)("gate.timeout", map[string]any{"seconds": 30}))
		assert.Equal(t, "[gate] running:", Tr(LangEN)("band.running"))
	})

	t.Run("補間値は HTML エスケープされず、値の中の {{ }} も展開されない", func(t *testing.T) {
		assert.Equal(t, `cannot read gate.yaml: /a/b "c" <d> & {{x}}`, Tr(LangEN)("gate.cannotReadYaml", map[string]any{"path": `/a/b "c" <d> & {{x}}`}))
	})

	t.Run("無いキーはキーそのものを返す（文面が消えないように）", func(t *testing.T) {
		assert.Equal(t, "no.such.key", Tr(LangJA)("no.such.key"))
	})
}
