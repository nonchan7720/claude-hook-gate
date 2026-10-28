package hookgate

// PostToolUse hook: files を持つ feedback ルール（ファイル種別にスコープされたルール）を、対象のファイルに触れた直後に注入する
// （src/feedback-file-inject.ts の移植）。
//
// files 付きのルールは毎プロンプトには注入されない（feedback_inject.go）。代わりに、
//   - Read: 読んだファイル（ほぼ必ず編集の前にある。ここで届けば、編集内容を考える前にルールが手元にある）
//   - Edit / Write / MultiEdit: 編集したファイル（Read を挟まずに書いたときの保険。次の編集から効く）
//   - Bash: コマンドの文面から書き先が分かる heredoc の書き込み先（bash_heredoc.go。Write と同じ扱い）
//
// のパスに files がマッチする count >= 3 のルールを、additionalContext として返す。
//
// 同じターンに同じルールを何度も出さないよう、注入済みのルール名を ~/.claude/feedback/.inject_state/<session>[--<agent>].json に
// 控える。UserPromptSubmit（feedback_inject.go）と SessionStart の startup / clear / compact（reset_gate.go）で消える。
//
// hook 自身のバグで作業を止めないよう、例外は握りつぶして exit 0 にする（.errors.jsonl に残す）。

import "strings"

// TargetFiles はツールの入力から、注入の対象にするファイルのパスを取り出す。対象外のツールは空。
func TargetFiles(payload Dict, io Io) []string {
	tool := JqStr(payload["tool_name"])
	toolInput, _ := AsDict(payload["tool_input"])
	switch tool {
	case "Read", "Edit", "Write", "MultiEdit":
		if Truthy(toolInput["file_path"]) {
			return []string{Str(toolInput["file_path"])}
		}
		return nil
	case "Bash":
		command := ""
		if Truthy(toolInput["command"]) {
			command = Str(toolInput["command"])
		}
		if command == "" {
			return nil
		}
		writes := HeredocWrites(command, fbFirstNonEmpty(JqStr(payload["cwd"]), io.Cwd()), io.Env().Home)
		files := make([]string, len(writes))
		for i, w := range writes {
			files[i] = w.File
		}
		return files
	}
	return nil
}

// BuildFileOutput はファイル群に対する注入テキスト（ヘッダ + ルール）。mode は "read" か "edit"。
func BuildFileOutput(io Io, rules []Rule, files []string, mode, projectDir string) string {
	labels := make([]string, len(files))
	for i, f := range files {
		labels[i] = fbFileLabel(projectDir, f)
	}
	key := "inject.fileHeaderEdit"
	if mode == "read" {
		key = "inject.fileHeaderRead"
	}
	return Tr(io.Lang())(key, map[string]any{"files": strings.Join(labels, ", ")}) + FormatRules(io, rules)
}

func feedbackFileInjectMain(io Io, payload Dict) (ScriptResult, error) {
	files := TargetFiles(payload, io)
	if len(files) == 0 {
		return Ok("", ""), nil
	}
	all, err := ListRules(io)
	if err != nil {
		return ScriptResult{}, err
	}
	rules := []Rule{}
	for _, r := range all {
		if r.Count >= 3 && IsFileScoped(r) {
			rules = append(rules, r)
		}
	}
	if len(rules) == 0 {
		return Ok("", ""), nil
	}
	projectDir := fbFirstNonEmpty(io.ProjectDir(), io.Cwd())

	// 対象ファイルごとのマッチの和集合（ルールの順序は保つ）。
	matched := []Rule{}
	seen := map[string]bool{}
	for _, file := range files {
		for _, r := range RulesForFile(io, rules, file, projectDir) {
			if !seen[r.Name] {
				seen[r.Name] = true
				matched = append(matched, r)
			}
		}
	}
	if len(matched) == 0 {
		return Ok("", ""), nil
	}

	stateID := InjectStateID(payload["session_id"], payload["agent_id"])
	injected := map[string]bool{}
	if stateID != "" {
		injected = LoadInjected(io, stateID)
	}
	fresh := []Rule{}
	for _, r := range matched {
		if !injected[r.Name] {
			fresh = append(fresh, r)
		}
	}
	if len(fresh) == 0 {
		return Ok("", ""), nil
	}
	if stateID != "" {
		for _, r := range fresh {
			injected[r.Name] = true
		}
		SaveInjected(io, stateID, injected)
	}

	mode := "edit"
	if JqStr(payload["tool_name"]) == "Read" {
		mode = "read"
	}
	text := BuildFileOutput(io, fresh, files, mode, projectDir)
	out := OMap{{"hookSpecificOutput", OMap{{"hookEventName", "PostToolUse"}, {"additionalContext", text}}}}
	return Ok(JSONStringify(out)+"\n", ""), nil
}

// FeedbackFileInject は PostToolUse hook の本体。
func FeedbackFileInject(io Io, payload Dict) ScriptResult {
	res, err := fbCatchResult(func() (ScriptResult, error) { return feedbackFileInjectMain(io, payload) })
	if err != nil {
		// hook のバグで作業を止めない
		LogError(io, "feedback-file-inject", ErrorText(err))
		return Ok("", "[feedback-file-inject] internal error (ignored): "+ErrorText(err)+"\n")
	}
	return res
}
