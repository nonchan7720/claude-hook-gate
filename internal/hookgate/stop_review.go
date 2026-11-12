package hookgate

// Stop / SubagentStop hook: gate.yaml の stop_review（src/stop-review.ts）。止まる前に、今回変更したファイルを同じモデル自身に見直させる。
//
// gate の checks フェーズと feedback の stop_check が通ったあとに呼ばれる（all_stop.go、hooks.go の SubagentStop）。
// 前回の見直し以降に変更されたファイル（review_pending.<state_id>.txt。RecordChanges / RecordBashChanges が NotePendingReview で
// 足す）があれば、停止を 1 回ブロックして見直しの手順を reason として返す。hook の出力ではセッションの effort を変えられない
// ので、reason の先頭で同梱スキル feedback-gate:effort-<level>（frontmatter の effort がそのターンの残りに効く）を
// 呼ばせて effort を切り替える。
//
// 見直しの途中の修正も review_pending に足されるので、次の Stop でまた見直しになる。それを max_rounds（既定 1）回で
// 打ち切る: 回数は review_rounds.<state_id>.txt に持ち、見直すものが無い Stop と、打ち切った Stop で消す。
// 回数を数えるのは hook のブロックで続いている間（stop_hook_active）だけで、新しいターンの Stop は 0 から数える。

import (
	"math"
	"slices"
	"strconv"
	"strings"
)

// StopReviewEffortLevels は effort に書ける値。
var StopReviewEffortLevels = []string{"low", "medium", "high", "xhigh", "max"}

const (
	// StopReviewDefaultEffort は effort の既定値。
	StopReviewDefaultEffort = "xhigh"
	// StopReviewDefaultMaxRounds は max_rounds の既定値。
	StopReviewDefaultMaxRounds = 1
	// StopReviewMaxListedFiles は reason に並べる変更ファイルの上限。超えた分は件数だけ出す。
	StopReviewMaxListedFiles = 30
)

// StopReviewConfig は正規化した stop_review。Effort が空なら effort を切り替えない（見直しだけ行う）。
type StopReviewConfig struct {
	Effort    string
	Match     []string
	MaxRounds int
	Prompt    string
	Subagents bool
}

func stopReviewRounds(v any) int {
	n := 0
	switch x := v.(type) {
	case int:
		n = x
	case int64:
		n = int(x)
	case float64:
		if x != math.Trunc(x) {
			return StopReviewDefaultMaxRounds
		}
		n = int(x)
	}
	if n < 1 {
		return StopReviewDefaultMaxRounds
	}
	return n
}

// ParseStopReview は gate.yaml の stop_review（true またはマッピング）を正規化する。それ以外（未指定・false など）は ok=false（無効）。
func ParseStopReview(raw any) (StopReviewConfig, bool) {
	d, isDict := AsDict(raw)
	if raw != true && !isDict {
		return StopReviewConfig{}, false
	}
	if d["enabled"] == false {
		return StopReviewConfig{}, false
	}
	effort := StopReviewDefaultEffort
	if d["effort"] == false {
		effort = ""
	} else if s, ok := d["effort"].(string); ok && slices.Contains(StopReviewEffortLevels, s) {
		effort = s
	}
	prompt := ""
	if s, ok := d["prompt"].(string); ok {
		prompt = strings.TrimSpace(s)
	}
	return StopReviewConfig{
		Effort:    effort,
		Match:     AsList(d["match"]),
		MaxRounds: stopReviewRounds(d["max_rounds"]),
		Prompt:    prompt,
		Subagents: d["subagents"] != false,
	}, true
}

// ReviewPendingPath は「まだ見直していない」変更ファイルの一覧。
func ReviewPendingPath(io Io, stateID string) string {
	return Join(GateStatusDir(io), "review_pending."+stateID+".txt")
}

// ReviewRoundsPath は連続で見直しをさせた回数。
func ReviewRoundsPath(io Io, stateID string) string {
	return Join(GateStatusDir(io), "review_rounds."+stateID+".txt")
}

// NotePendingReview は変更ファイル（絶対パス）を「まだ見直していない」一覧へ足す。changed_files と違い、gate が通っても消えない。
func NotePendingReview(io Io, stateID string, paths []string) {
	memo := ReviewPendingPath(io, stateID)
	existing, _ := io.ReadFile(memo)
	have := map[string]bool{}
	for _, line := range strings.Split(existing, "\n") {
		have[line] = true
	}
	var b strings.Builder
	b.WriteString(existing)
	added := false
	for _, p := range paths {
		if p == "" || have[p] {
			continue
		}
		have[p] = true
		added = true
		b.WriteString(p + "\n")
	}
	if added {
		_ = io.WriteFile(memo, b.String())
	}
}

func loadStopReview(io Io, path string) (StopReviewConfig, bool) {
	text, ok := io.ReadFile(path)
	if !ok {
		return StopReviewConfig{}, false
	}
	// 壊れた gate.yaml は gate 本体が知らせる
	cfg, err := ParseYaml(text)
	if err != nil {
		return StopReviewConfig{}, false
	}
	d, isDict := AsDict(cfg)
	if !isDict {
		return StopReviewConfig{}, false
	}
	return ParseStopReview(d["stop_review"])
}

// StopReview は Stop / SubagentStop で、見直していない変更があれば停止をブロックして自己確認の手順を返す。
func StopReview(io Io, payload Dict) ScriptResult {
	yaml, found := FindGateYaml(io)
	if !found {
		return Ok("", "")
	}
	stateID := bashStateIDOf(payload)
	pending := ReviewPendingPath(io, stateID)
	roundsFile := ReviewRoundsPath(io, stateID)
	clearState := func() { io.RemoveFiles([]string{pending, roundsFile}) }

	cfg, enabled := loadStopReview(io, yaml)
	if !enabled || (JqStr(payload["agent_id"]) != "" && !cfg.Subagents) {
		clearState()
		return Ok("", "")
	}

	projectDir := fbFirstNonEmpty(io.ProjectDir(), io.Cwd())
	globs, err := CompileGlobs(cfg.Match)
	if err != nil {
		// 不正な glob は「すべて対象」として扱う（見直しを黙って無効にしない）
		globs = nil
	}
	labels := []string{}
	text, _ := io.ReadFile(pending)
	for _, line := range strings.Split(text, "\n") {
		if line == "" {
			continue
		}
		root, rel := SplitRoot(projectDir, line)
		if len(globs) > 0 {
			matched := false
			for _, rx := range globs {
				if rx.MatchString(rel) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		if label := RootLabel(root, projectDir, rel); !slices.Contains(labels, label) {
			labels = append(labels, label)
		}
	}

	// 回数を引き継ぐのは、hook のブロックで続いている Stop（stop_hook_active）だけ。新しいターンの Stop では、中断などで
	// 残った回数を使わない（残っていると、そのターンの見直しが 1 回飛ぶ）。
	done := 0
	if payload["stop_hook_active"] == true {
		if s, ok := io.ReadFile(roundsFile); ok {
			if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && n > 0 {
				done = n
			}
		}
	}
	if len(labels) == 0 || done >= cfg.MaxRounds {
		clearState()
		// 見直しでブロックした後の Stop は stop_hook_active なので、完了通知を出させるために印を返す（all_stop.go）。
		return ScriptResult{ReportConsumed: done > 0}
	}

	_ = io.WriteFile(roundsFile, strconv.Itoa(done+1))
	io.RemoveFiles([]string{pending})

	t := Tr(io.Lang())
	lines := []string{t("stopReview.header", map[string]any{"round": done + 1, "max": cfg.MaxRounds})}
	if cfg.Effort != "" {
		lines = append(lines, t("stopReview.effort", map[string]any{"effort": cfg.Effort}))
	}
	lines = append(lines, t("stopReview.steps"), t("stopReview.files"))
	for i, label := range labels {
		if i >= StopReviewMaxListedFiles {
			break
		}
		lines = append(lines, "- "+label)
	}
	if len(labels) > StopReviewMaxListedFiles {
		lines = append(lines, t("stopReview.more", map[string]any{"count": len(labels) - StopReviewMaxListedFiles}))
	}
	if cfg.Prompt != "" {
		lines = append(lines, cfg.Prompt)
	}
	reason := strings.Join(lines, "\n")
	return ScriptResult{ExitCode: 2, Stdout: JSONStringify(OMap{{"decision", "block"}, {"reason", reason}}) + "\n", Stderr: reason + "\n"}
}
