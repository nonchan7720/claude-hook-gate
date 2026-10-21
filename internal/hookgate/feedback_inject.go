package hookgate

// UserPromptSubmit hook: count >= 3 の確定 feedback ルールをコンテキストに注入する。
// rules.md 自体は別に出力しているので（register.ts の loadRules）、ここでは出力しない。
//
// count 降順・同数なら name 昇順で並べ、各ルールは「■ <name> (これまで N 回指摘されています)」
// + description + 本文の第1段落を出力する。
//
// 読めないルールファイル・捨てた enforce の要素があれば、その一覧（ファイルと理由）を先頭に出す（壊れたルールは
// 黙って無効になるので、LLM とユーザーが気づけるように）。
//
// hook 自身のバグで作業を止めないよう、例外は握りつぶして exit 0 にする（.errors.jsonl に残す）。

import (
	"sort"
	"strings"
)

func fbFormatFull(io Io, rule Rule) string {
	lines := []string{Tr(io.Lang())("inject.ruleTitle", map[string]any{"name": rule.Name, "count": rule.Count}), rule.Description}
	if intro := LoadBodyIntro(io, rule.Path); intro != "" {
		lines = append(lines, intro)
	}
	return strings.Join(lines, "\n")
}

// BuildOutput は count 降順・同数なら name 昇順で並べたルールの注入テキスト。
func BuildOutput(io Io, rules []Rule) string {
	sorted := append([]Rule{}, rules...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		return a.Name < b.Name
	})
	blocks := make([]string, len(sorted))
	for i, r := range sorted {
		blocks[i] = fbFormatFull(io, r)
	}
	return Tr(io.Lang())("inject.header") + strings.Join(blocks, "\n\n")
}

// BrokenRulesText は読めないルールの一覧（無ければ空文字）。
func BrokenRulesText(io Io, broken []BrokenRule) string {
	if len(broken) == 0 {
		return ""
	}
	lines := []string{Tr(io.Lang())("inject.brokenRules")}
	for _, b := range broken {
		lines = append(lines, "- "+b.Path+": "+b.Reason)
	}
	return strings.Join(lines, "\n")
}

func feedbackInjectMain(io Io) (ScriptResult, error) {
	res, err := ScanRules(io)
	if err != nil {
		return ScriptResult{}, err
	}
	for _, b := range res.Broken {
		LogError(io, "rules", b.Reason, b.Path)
	}
	confirmed := []Rule{}
	for _, r := range res.Rules {
		if r.Count >= 3 {
			confirmed = append(confirmed, r)
		}
	}
	parts := []string{BrokenRulesText(io, res.Broken)}
	if len(confirmed) > 0 {
		parts = append(parts, BuildOutput(io, confirmed))
	}
	nonEmpty := []string{}
	for _, p := range parts {
		if p != "" {
			nonEmpty = append(nonEmpty, p)
		}
	}
	text := strings.Join(nonEmpty, "\n\n")
	if text == "" {
		return Ok("", ""), nil
	}
	return Ok(text, ""), nil
}

// FeedbackInject は UserPromptSubmit hook の本体。
func FeedbackInject(io Io) ScriptResult {
	res, err := fbCatchResult(func() (ScriptResult, error) { return feedbackInjectMain(io) })
	if err != nil {
		// hook のバグで作業を止めない
		LogError(io, "feedback-inject", ErrorText(err))
		return Ok("", "[feedback-inject] internal error (ignored): "+ErrorText(err)+"\n")
	}
	return res
}
