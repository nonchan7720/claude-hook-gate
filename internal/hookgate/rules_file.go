package hookgate

// UserPromptSubmit で毎回注入するルールファイルの読み込み。

import "strings"

// DefaultRulesFile は rulesFile 未設定のときに探す場所: ~/<設定ディレクトリ>/feedback-gate/feedback_rules.md。
const DefaultRulesFile = "~/{.claude,.agents}/feedback-gate/feedback_rules.md"

// BundledRulesName はプラグイン同梱のルールファイル名。英語のときは feedback_rules.en.md。
func BundledRulesName(lang Lang) string {
	if lang == LangEN {
		return "feedback_rules.en.md"
	}
	return "feedback_rules.md"
}

// LoadRules は rulesFile（先頭の ~ は HOME に展開）があればその内容、無ければプラグイン同梱の rules/feedback_rules.md
// （英語なら rules/feedback_rules.en.md）の内容。どちらも無ければ空文字。rulesFile は文字列以外なら未設定扱い。
func LoadRules(io Io, rulesFile any) string {
	home := io.Env().Home
	expand := func(p string) string {
		if strings.HasPrefix(p, "~") {
			if home == "" {
				return ""
			}
			return home + p[1:]
		}
		return p
	}
	var configured []string
	if s, ok := rulesFile.(string); ok && s != "" {
		configured = []string{expand(s)}
	} else if home != "" {
		configured = ConfigPaths(io, home, "feedback-gate", "feedback_rules.md")
	}
	bundled := Join(io.PluginRoot(), "rules", BundledRulesName(io.Lang()))
	for _, path := range append(configured, bundled) {
		if path != "" && io.Exists(path) {
			text, _ := io.ReadFile(path)
			return strings.TrimSpace(text)
		}
	}
	return ""
}
