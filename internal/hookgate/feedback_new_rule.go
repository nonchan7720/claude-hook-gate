package hookgate

// 新しい feedback ルールファイルを作る前に、既存のルールを確認させる（PreToolUse。feedback_guard.go から呼ぶ）。
// src/feedback-new-rule.ts の移植。
//
// Write（と Bash の heredoc）で feedback のディレクトリ（グローバル ~/.claude/feedback/ とプロジェクトの .claude/feedback/）の
// 直下にまだ無い *.md を書こうとしたとき、既存のルールが 1 つでもあれば、セッション・ファイルごとに最初の 1 回だけ止めて
// 既存ルールの全件の一覧（ディレクトリごと。name / description が似ているものを先に、★ 付きで）を返す。同じ指摘のルールがあれば新しいファイルを作らず、
// そのルールの count を上げて本文を更新させるため（同じ内容のルールが別名で増えるのを防ぐ）。
// 該当するものが無ければ、同じ書き込みをもう一度すれば通す（2 回目は止めない）。
//
// セッション ID が無いとき（2 回目を通す判定ができない）、既存のルールが無いとき、状態ファイル（. 始まり）のときは何もしない。

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// SimilarMinScore はこれ以上の SimilarityScore を「似ている」とする。
const SimilarMinScore = 2

var (
	nrStopwords = map[string]bool{"the": true, "and": true, "for": true, "with": true, "when": true, "not": true, "use": true, "feedback": true, "rule": true, "rules": true}
	nrSplitRe   = regexp.MustCompile(`[^\p{L}\p{N}]+`)
	nrASCIIRe   = regexp.MustCompile(`^[a-z0-9]+$`)
)

// SimilarityTokens は似ているかを測るための語の集合。英数字の語は小文字の先頭 4 文字（tests / testing を test に寄せる簡単な語幹）、
// それ以外の文字（日本語など）を含む語は 2 文字ずつの組（bigram）。3 文字未満の英数字の語とストップワードは捨てる。
func SimilarityTokens(text string) map[string]bool {
	out := map[string]bool{}
	for _, word := range nrSplitRe.Split(strings.ToLower(text), -1) {
		if word == "" {
			continue
		}
		if nrASCIIRe.MatchString(word) {
			if len(word) >= 3 && !nrStopwords[word] {
				out[word[:min(4, len(word))]] = true
			}
			continue
		}
		chars := []rune(word)
		if len(chars) == 1 {
			out[word] = true
		}
		for i := 0; i+1 < len(chars); i++ {
			out[string(chars[i:i+2])] = true
		}
	}
	return out
}

// SimilarityScore は共通の語の数（英数字の語は 2、bigram は 1 として数える）。
func SimilarityScore(a, b map[string]bool) int {
	score := 0
	for t := range a {
		if !b[t] {
			continue
		}
		if nrASCIIRe.MatchString(t) {
			score += 2
		} else {
			score++
		}
	}
	return score
}

// nrDraftText は書こうとしている内容の frontmatter から name / description を取り出す（読めなければ空）。
func nrDraftText(content string) string {
	m := FrontmatterRe.FindStringSubmatch(content)
	if m == nil {
		return ""
	}
	parsed, err := LoadYamlText(m[1])
	if err != nil {
		return ""
	}
	data, ok := parsed.(map[string]any)
	if !ok {
		return ""
	}
	parts := []string{}
	for _, k := range []string{"name", "description"} {
		if Truthy(data[k]) {
			parts = append(parts, Str(data[k]))
		}
	}
	return strings.Join(parts, " ")
}

func nrStemOf(path string) string {
	stem, _ := Splitext(Basename(path))
	return stem
}

// nrRuleDirs はルールのディレクトリ（グローバル・プロジェクト）。重複は除く。
func nrRuleDirs(io Io) []string {
	home := io.Env().Home
	seen := map[string]bool{}
	out := []string{}
	for _, d := range append(FeedbackDirs(io), ProjectFeedbackDirs(io)...) {
		n := Normpath(ExpandUser(d, home))
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}

// nrExistingRules はディレクトリ直下の既存ルール（期限切れ・対象外も含める）。読めないファイルは飛ばす。
func nrExistingRules(io Io, dirs []string) []Rule {
	rules := []Rule{}
	for _, d := range dirs {
		entries := io.List(d)
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name
		}
		sort.Strings(names)
		for _, name := range names {
			if !strings.HasSuffix(name, ".md") || strings.HasPrefix(name, ".") {
				continue
			}
			// 壊れたルールは feedback-inject / /correct が報告する
			if rule, ok, err := LoadRule(io, Join(d, name)); err == nil && ok {
				rules = append(rules, rule)
			}
		}
	}
	return rules
}

// NewRuleStatePath はセッション内で既存ルールを確認させた新しいルールファイルを持つ状態ファイル。
func NewRuleStatePath(io Io, sessionID string) string {
	return Join(FeedbackDir(io), ".new_rule_state", fbNonSessionCharRe.ReplaceAllString(sessionID, "")+".json")
}

func nrSaveConfirmed(io Io, sessionID string, confirmed map[string]bool) {
	// 状態の保存失敗で hook を止めない
	_ = io.WriteFile(NewRuleStatePath(io, sessionID), JSONStringify(OMap{{"confirmed", fbSortedKeys(confirmed)}}))
}

// nrListLine は一覧の 1 行（ディレクトリの見出しの下）。name がファイル名と違うときだけ name も出す。
func nrListLine(rule Rule, similar bool) string {
	mark := "-"
	if similar {
		mark = "★"
	}
	nameNote := ""
	if rule.Name != nrStemOf(rule.Path) {
		nameNote = "name: " + rule.Name + ", "
	}
	line := "  " + mark + " " + Basename(rule.Path) + " (" + nameNote + "count: " + strconv.Itoa(rule.Count) + ")"
	if rule.Description != "" {
		line += ": " + rule.Description
	}
	return line
}

// NewRuleNotice は filePath が feedback のディレクトリ直下の新しいルールファイルで、このセッションでまだ確認させていなければ、
// 既存ルールの一覧と「既存ルールの更新を優先する」指示を返す（呼び出し側が deny する）。それ以外は ok=false。
func NewRuleNotice(io Io, filePath, content string, sessionID any) (string, bool) {
	if !Truthy(sessionID) || filePath == "" {
		return "", false
	}
	file := Normpath(ExpandUser(filePath, io.Env().Home))
	name := Basename(file)
	if !strings.HasSuffix(name, ".md") || strings.HasPrefix(name, ".") {
		return "", false
	}
	dirs := nrRuleDirs(io)
	if !fbContainsString(dirs, Dirname(file)) || io.Exists(file) {
		return "", false
	}
	rules := nrExistingRules(io, dirs)
	if len(rules) == 0 {
		return "", false
	}

	sid := Str(sessionID)
	confirmed := fbLoadNameSet(io, NewRuleStatePath(io, sid), "confirmed")
	if confirmed[file] {
		return "", false
	}
	confirmed[file] = true
	nrSaveConfirmed(io, sid, confirmed)

	draft := SimilarityTokens(nrStemOf(file) + " " + nrDraftText(content))
	type scoredRule struct {
		rule  Rule
		score int
	}
	scored := make([]scoredRule, len(rules))
	for i, r := range rules {
		scored[i] = scoredRule{r, SimilarityScore(draft, SimilarityTokens(nrStemOf(r.Path)+" "+r.Name+" "+r.Description))}
	}
	t := Tr(io.Lang())
	similar := 0
	for _, s := range scored {
		if s.score >= SimilarMinScore {
			similar++
		}
	}
	lines := []string{t("newRule.header", map[string]any{"file": file, "n": similar})}
	// 全件をディレクトリごとにまとめて出す（パスは見出しにして 1 行を短くする）。各ディレクトリの中は似ているものが先。
	for _, d := range dirs {
		inDir := []scoredRule{}
		for _, s := range scored {
			if Dirname(s.rule.Path) == d {
				inDir = append(inDir, s)
			}
		}
		if len(inDir) == 0 {
			continue
		}
		sort.SliceStable(inDir, func(i, j int) bool { return inDir[i].score > inDir[j].score })
		lines = append(lines, d+"/")
		// 語が 1 つも重ならない（明らかに似ていない）ものはファイル名だけを 1 行にまとめる（context を食わないように）。
		unrelated := []string{}
		for _, s := range inDir {
			if s.score > 0 {
				lines = append(lines, nrListLine(s.rule, s.score >= SimilarMinScore))
			} else {
				unrelated = append(unrelated, nrStemOf(s.rule.Path))
			}
		}
		if len(unrelated) > 0 {
			lines = append(lines, "  "+t("newRule.unrelated", map[string]any{"n": len(unrelated)})+strings.Join(unrelated, ", "))
		}
	}
	lines = append(lines, t("newRule.instruction"))
	return strings.Join(lines, "\n"), true
}
