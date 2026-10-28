package hookgate

// UserPromptSubmit hook: count >= 3 の確定 feedback ルールをコンテキストに注入する。
// rules.md 自体は別に出力しているので（register.ts の loadRules）、ここでは出力しない。
//
// count 降順・同数なら name 昇順で並べ、各ルールは「■ <name> (これまで N 回指摘されています)」
// + description + 本文の第1段落を出力する。
//
// files を持つルール（ファイル種別にスコープされたルール）はここでは出さない。毎プロンプトに載せる代わりに、
// マッチするファイルを Read / Edit / Write した直後（PostToolUse）に feedback_file_inject.go が注入する。
// その「このターンに注入済み」の状態はプロンプトごとに消す（長いターンや compaction の後でも次のプロンプトで
// 必ず届くように。1 ターンに同じルールは 1 回しか出ない）。
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

// FormatRules は count 降順・同数なら name 昇順で並べたルールのブロック（ヘッダ無し）。
func FormatRules(io Io, rules []Rule) string {
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
	return strings.Join(blocks, "\n\n")
}

// BuildOutput は count 降順・同数なら name 昇順で並べたルールの注入テキスト（ヘッダ付き）。
func BuildOutput(io Io, rules []Rule) string {
	return Tr(io.Lang())("inject.header") + FormatRules(io, rules)
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

func feedbackInjectMain(io Io, sessionID string) (ScriptResult, error) {
	// 新しいプロンプト: files 付きルールの「このターンに注入済み」を忘れる（次に触れたときにまた出す）。
	if sessionID != "" {
		ClearInjected(io, sessionID)
	}
	res, err := ScanRules(io)
	if err != nil {
		return ScriptResult{}, err
	}
	for _, b := range res.Broken {
		LogError(io, "rules", b.Reason, b.Path)
	}
	confirmed := []Rule{}
	for _, r := range res.Rules {
		if r.Count >= 3 && !IsFileScoped(r) {
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

// FeedbackInject は UserPromptSubmit hook の本体（セッション ID 無し: 注入状態は消さない）。
func FeedbackInject(io Io) ScriptResult { return FeedbackInjectFor(io, "") }

// FeedbackInjectFor は UserPromptSubmit hook の本体。sessionID のこのターンの注入状態を消してから注入する。
func FeedbackInjectFor(io Io, sessionID string) ScriptResult {
	res, err := fbCatchResult(func() (ScriptResult, error) { return feedbackInjectMain(io, sessionID) })
	if err != nil {
		// hook のバグで作業を止めない
		LogError(io, "feedback-inject", ErrorText(err))
		return Ok("", "[feedback-inject] internal error (ignored): "+ErrorText(err)+"\n")
	}
	return res
}
