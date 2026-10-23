package hookgate

// PostToolUse(Bash) hook: Bash が書き換えたファイル（bash_changes.go が拾ったもの）を、Edit / Write と同じ
// feedback ルールの enforce で検査する。heredoc・python・sed -i などで書くと Edit / Write の hook が起動せず、
// post_edit / pre_edit の検査が抜けるのを塞ぐ。
//
//   - post_edit: Edit / Write の PostToolUse（feedback_post_edit.go）と同じく、書き換え後のファイル全体を評価する。
//   - pre_edit: Bash では（heredoc を除き）実行前に書かれる内容が分からないので PreToolUse では評価できない。代わりに実行後、
//     ファイルパスの条件（path / exclude_path / absent_sibling / absent_glob）と、このコマンドで書かれた内容
//     （when / unless）を同じ条件で評価する。書かれた内容は、git が追跡しているファイルなら HEAD との差分の追加行
//     （同じコマンドでコミット済みなら、開始以降のコミットの追加行）、追跡外のファイル（新規作成など）なら全文
//     （Write の content と同じ扱い）。既に書かれた後なので止められない: deny / ask は block（書いた内容を直させる）
//     にし、メッセージに「実行後に検知した」旨を添える。同じセッション・同じファイルで既に ask した（承認済みの）
//     ルールは、Edit と同じく warn に落とす。文面から書き先と本文が分かる heredoc の書き込み（bash_heredoc.go）は
//     PreToolUse で feedback_guard.go が Write と同じく判定済みなので、ここでは pre_edit を掛けない（post_edit は掛ける）。
//
// 複数ファイルの結果は 1 つにまとめる（block があれば全件を 1 つの reason に、warn は stderr に）。
// 違反したルールの count は Edit / Write と同じく AutoBumpCounts で上げ、その旨をメッセージに添える。
// hook 自身のバグで作業を止めないよう、例外は必ず握りつぶして exit 0 にする（stderr に1行だけ出し、~/.claude/feedback/.errors.jsonl に残す）。
// 壊れたルール（読めないファイル・不正な enforce の要素）は ListRules / EvalPostEdit / EvalPreEdit が飛ばして記録するので、
// 他のルールの検査は続く。

import (
	"sort"
	"strconv"
	"strings"
)

var fbBashEditEvents = map[string]bool{"post_edit": true, "pre_edit": true}

// WantsBashEdits は Bash の書き換えを追跡する価値のある（post_edit / pre_edit の enforce を持つ）ルールがあるか。
func WantsBashEdits(rules []Rule) bool {
	for _, r := range rules {
		for _, e := range r.Enforce {
			if e != nil && fbBashEditEvents[Str(e["event"])] {
				return true
			}
		}
	}
	return false
}

func fbHasPreEditContent(rules []Rule) bool {
	for _, r := range rules {
		for _, e := range r.Enforce {
			if e != nil && e["event"] == "pre_edit" && Truthy(e["when"]) {
				return true
			}
		}
	}
	return false
}

// AddedLines は unified diff（-U0）から、hunk 内の追加行（先頭の + を除いたもの）だけを取り出す。
func AddedLines(diff string) []string {
	out := []string{}
	inHunk := false
	for _, line := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			inHunk = false
		case strings.HasPrefix(line, "@@"):
			inHunk = true
		case inHunk && strings.HasPrefix(line, "+"):
			out = append(out, line[1:])
		}
	}
	return out
}

// WrittenContent はこのコマンドが file に書いた内容（pre_edit の when / unless の対象）。git が追跡していないファイル
// （新規作成、git の外）は全文。追跡しているファイルは HEAD との差分の追加行、差分が無ければ threshold（ミリ秒）以降の
// コミットの追加行。
func WrittenContent(io Io, file string, threshold int64) string {
	dir := Dirname(file)
	name := Basename(file)
	opts := RunOptions{TimeoutMs: 10_000}
	whole := func() string {
		text, _ := io.ReadFile(file)
		return text
	}
	tracked := io.Run([]string{"git", "-C", dir, "ls-files", "--error-unmatch", "--", name}, opts)
	if tracked.ExitCode != 0 {
		return whole()
	}
	diff := io.Run([]string{"git", "-C", dir, "diff", "--no-color", "--no-ext-diff", "-U0", "HEAD", "--", name}, opts)
	if diff.ExitCode != 0 {
		return whole()
	}
	added := AddedLines(diff.Stdout)
	if len(added) == 0 {
		since := "--since=@" + strconv.FormatInt(threshold/1000, 10)
		log := io.Run([]string{"git", "-C", dir, "log", since, "--no-merges", "-p", "--no-color", "--no-ext-diff", "-U0", "--format=", "--", name}, opts)
		if log.ExitCode == 0 {
			added = AddedLines(log.Stdout)
		}
	}
	return strings.Join(added, "\n")
}

// fbBashLabel は表示用のパス: projectDir 配下ならその相対パス。
func fbBashLabel(projectDir, file string) string {
	if !IsAbsolute(file) {
		return file
	}
	rel := Relpath(file, projectDir)
	if strings.HasPrefix(rel, "../") || rel == ".." {
		return file
	}
	return rel
}

type fbFound struct {
	file string
	v    Violation
}

func feedbackBashEditsMain(io Io, payload Dict, files []string, threshold int64) (ScriptResult, error) {
	rules, err := ListRules(io)
	if err != nil {
		return ScriptResult{}, err
	}
	if !WantsBashEdits(rules) {
		return Ok("", ""), nil
	}
	projectDir := fbFirstNonEmpty(io.ProjectDir(), io.Cwd())
	needContent := fbHasPreEditContent(rules)
	command := ""
	if ti, ok := payload["tool_input"].(map[string]any); ok {
		command = JqStr(ti["command"])
	}
	judged := map[string]bool{}
	for _, w := range HeredocWrites(command, fbFirstNonEmpty(JqStr(payload["cwd"]), io.Cwd()), io.Env().Home) {
		judged[w.File] = true
	}

	found := []fbFound{}
	sortedFiles := append([]string{}, files...)
	sort.Strings(sortedFiles)
	for _, file := range sortedFiles {
		abs := file
		if !IsAbsolute(file) {
			abs = Join(projectDir, file)
		}
		for _, v := range EvalPostEdit(io, rules, abs) {
			found = append(found, fbFound{abs, v})
		}
		if judged[abs] {
			continue // heredoc の書き込みは PreToolUse で pre_edit 判定済み
		}
		content := ""
		if needContent {
			content = WrittenContent(io, abs, threshold)
		}
		pre := EvalPreEdit(io, rules, abs, content)
		if len(pre) == 0 {
			continue
		}
		DowngradeRepeatedAsks(io, pre, payload["session_id"], Dict{"file_path": abs})
		for _, v := range pre {
			found = append(found, fbFound{abs, v})
		}
	}
	if len(found) == 0 {
		return Ok("", ""), nil
	}

	for _, f := range found {
		LogViolation(io, f.v.Rule, f.v.Count, f.v.Severity, f.v.Event, f.v.Detail)
	}
	// Edit / Write（feedback_post_edit / feedback_guard）と同じく、違反したルールの count を上げる（同じセッション・同じルールは 1 回）。
	violations := make([]Violation, len(found))
	for i, f := range found {
		violations[i] = f.v
	}
	notes := CountBumpNotes(io.Lang(), AutoBumpCounts(io, rules, violations, payload["session_id"]))

	t := Tr(io.Lang())
	tag := func(v Violation) string {
		if v.Event == "pre_edit" {
			return "[feedback-guard]"
		}
		return "[feedback-post-edit]"
	}
	after := func(v Violation) string {
		if v.Event == "pre_edit" {
			return " " + t("bashEdit.preEditAfter")
		}
		return ""
	}
	warnings, blocking := []fbFound{}, []fbFound{}
	for _, f := range found {
		if f.v.Severity == "warn" {
			warnings = append(warnings, f)
		} else {
			blocking = append(blocking, f)
		}
	}

	var stderr strings.Builder
	for _, f := range warnings {
		v := f.v
		stderr.WriteString(tag(v) + " warn: " + v.Rule + " (count: " + strconv.Itoa(v.Count) + "): " + v.Message + " (" + fbBashLabel(projectDir, f.file) + ")" + after(v) + "\n")
	}
	if len(blocking) == 0 {
		return Ok("", stderr.String()+fbJoinLines(notes)), nil
	}

	lines := []string{t("bashEdit.header")}
	for _, f := range blocking {
		v := f.v
		lines = append(lines, tag(v)+" "+v.Rule+" (count: "+strconv.Itoa(v.Count)+"): "+v.Message+" ("+fbBashLabel(projectDir, f.file)+": "+v.Detail+")"+after(v))
	}
	lines = append(lines, notes...)
	stderr.WriteString(fbJoinLines(lines))
	return Ok(JSONStringify(OMap{{"decision", "block"}, {"reason", strings.Join(lines, "\n")}})+"\n", stderr.String()), nil
}

// FeedbackBashEdits は Bash が書き換えた files を post_edit / pre_edit の enforce で検査する。
// threshold は書き換えを判定した mtime の下限（ミリ秒）。
func FeedbackBashEdits(io Io, payload Dict, files []string, threshold int64) ScriptResult {
	res, err := fbCatchResult(func() (ScriptResult, error) { return feedbackBashEditsMain(io, payload, files, threshold) })
	if err != nil {
		// hook のバグで作業を止めない（黙って全ルールが無効にならないよう .errors.jsonl に残す）
		LogError(io, "feedback-bash-edit", ErrorText(err))
		return Ok("", "[feedback-bash-edit] internal error (ignored): "+ErrorText(err)+"\n")
	}
	return res
}
