package hookgate

// イベントごとの処理（中核）。mod（src/register.ts、classic.* から）と command hook の CLI（cmd/feedback-gate、
// ホストごとの変換は host*.go）の両方がここを呼び、ここが各イベントの実装（feedback_guard.go、stop_test_gate.go など）を呼ぶ。
// 引数の payload は classic コマンド hook が stdin で受け取る JSON の形。各段は classic のスクリプトと同じ
// { ExitCode, Stdout, Stderr } を返し、それを classic の規約どおり Outcome にまとめて返す。

import (
	"regexp"
	"strings"
	"sync"
)

// PluginOptions はプラグイン設定（TS の claude-code の PluginOptions）。文字列の "" は未設定と同じ。
type PluginOptions struct {
	Language         string
	AgentLaunchGuard bool
	// AutoCount が nil なら既定（true。TS の undefined）。
	AutoCount *bool
	RulesFile string
}

// AutoCountEnabled は autoCount が有効か（未指定は true）。
func (o PluginOptions) AutoCountEnabled() bool { return o.AutoCount == nil || *o.AutoCount }

// HookRun は 1 イベント分の結果。Stderr は正常終了（exit 0）した段が出したもの（warn など）。block の理由（exit 2）は Outcome に入る。
type HookRun struct {
	Outcome Outcome
	Stderr  string
}

func strOf(v any) string {
	s, _ := v.(string)
	return s
}

var (
	reAgentTools = regexp.MustCompile(`^(Agent|SendMessage)$`)
	reGuardTools = regexp.MustCompile(`^(Bash|Edit|Write|MultiEdit)$`)
	reTaskTools  = regexp.MustCompile(`^(Agent|Task)$`)
	reWriteTools = regexp.MustCompile(`^(Write|Edit|MultiEdit)$`)
)

// ProgressDelayMs は評価中表示（progress）を出し始めるまでの待ち時間。これより早く終わる評価では何も出さない。
const ProgressDelayMs = 3000

// progressIo は Progress だけを遅らせる Io の包み。最初の Progress から ProgressDelayMs 経っても終わっていないときだけ base に渡す。
type progressIo struct {
	Io
	base Io

	mu          sync.Mutex
	shown       bool
	pending     string
	cancelDelay func()
}

func (p *progressIo) show() {
	p.mu.Lock()
	if p.shown || p.pending == "" {
		p.mu.Unlock()
		return
	}
	p.shown = true
	cancel := p.cancelDelay
	text := p.pending
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	p.base.Progress(text)
}

// Progress は表示済みならそのまま渡し、そうでなければ文字列を控えて遅延表示を仕掛ける。
func (p *progressIo) Progress(text string) {
	p.mu.Lock()
	if p.shown {
		p.mu.Unlock()
		p.base.Progress(text)
		return
	}
	p.pending = text
	if text == "" || p.cancelDelay != nil {
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()
	stop := p.base.Every(ProgressDelayMs, p.show)
	p.mu.Lock()
	p.cancelDelay = stop
	shown := p.shown
	p.mu.Unlock()
	// Every が登録中に fn を呼ぶ実装でも、cancelDelay の代入後に止める。
	if shown {
		stop()
	}
}

// finish は遅延表示を止め、progress を出していたかを返す。
func (p *progressIo) finish() bool {
	p.mu.Lock()
	cancel := p.cancelDelay
	shown := p.shown
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return shown
}

// runStep は 1 段を走らせる。スクリプトの内部エラー（panic）で作業を止めず、その段は無かったことにする（TS の `.catch(() => undefined)`）。
func runStep(step Step, io Io) (ScriptResult, bool) {
	var ran ScriptResult
	ok := false
	func() {
		defer func() { _ = recover() }()
		ran = step(io)
		ok = true
	}()
	return ran, ok
}

// RunSteps は各段を順に走らせ、classic の規約で Outcome にまとめる。first は最初から持っている Outcome。
func RunSteps(base Io, sessionID, event string, steps []Step, first Outcome) HookRun {
	acc := first
	stderr := ""
	// 処理中の 1 行（progress）を出した hook だけ、終わりに片付ける（毎回のちらつきを避ける）。gate の結果（result）は
	// 次のコマンドが走り始めるまで残すので、消さずに完了サマリへ戻す。
	// ただし最初の progress から ProgressDelayMs 経っても終わっていないときだけ出す（すぐ終わる評価でステータス行を触らない）。
	io := &progressIo{Io: base, base: base}
	defer func() {
		// 出していたなら、残っている gate の完了サマリがあればそれに戻し、無ければ消す。
		if io.finish() {
			summary, _ := LoadSummary(base, sessionID)
			base.Progress(summary)
		}
	}()
	for _, step := range steps {
		ran, ok := runStep(step, io)
		if !ok {
			continue
		}
		acc = Merge(acc, ToOutcome(event, ran))
		if ran.ExitCode == 0 {
			stderr += ran.Stderr
		}
	}
	return HookRun{Outcome: acc, Stderr: stderr}
}

// SessionStart: 自セッションの gate 状態を消す（startup / clear）。
func SessionStart(io Io, sessionID string, payload Dict) HookRun {
	return RunSteps(io, sessionID, "SessionStart", []Step{func(i Io) ScriptResult { return ResetGate(i, payload) }}, Outcome{})
}

// UserPromptSubmit: rules ファイル（rulesFile か同梱のもの）と、確定した feedback ルールを context に足す。
func UserPromptSubmit(io Io, sessionID string, options PluginOptions) HookRun {
	text := LoadRules(io, options.RulesFile)
	first := Outcome{}
	if text != "" {
		first.AdditionalContext = []string{text}
	}
	return RunSteps(io, sessionID, "UserPromptSubmit", []Step{FeedbackInject}, first)
}

// GuardsTool は PreToolUse の判定の対象か: Bash / Edit / Write / MultiEdit と、agentLaunchGuard が有効なら Agent / SendMessage。
func GuardsTool(options PluginOptions, tool string) bool {
	return (options.AgentLaunchGuard && reAgentTools.MatchString(tool)) || reGuardTools.MatchString(tool)
}

// PreToolUse: pre_bash / pre_edit の enforce（または agentLaunchGuard）を評価し、deny / ask を返す。対象外のツールは何もしない。
// settings では `|| true` 付きなので、deny 以外（exit 2 以外）は無視していた。
// Bash は、開始時刻を控えてから guard を評価する（終了後の変更ファイル追跡用）。
func PreToolUse(io Io, sessionID string, options PluginOptions, payload Dict) HookRun {
	tool := strOf(payload["tool_name"])
	if !GuardsTool(options, tool) {
		return HookRun{}
	}
	guardsAgents := options.AgentLaunchGuard && reAgentTools.MatchString(tool)
	var step Step
	if guardsAgents {
		step = func(i Io) ScriptResult {
			askAgentTypes, allowRecipients := AgentLaunchLists(i.Env())
			return AgentLaunchGuardWith(payload, i.Lang(), askAgentTypes, allowRecipients)
		}
	} else {
		step = func(i Io) ScriptResult { return FeedbackGuard(i, payload) }
	}
	steps := []Step{step}
	if tool == "Bash" {
		steps = []Step{func(i Io) ScriptResult { return BashStarted(i, payload) }, step}
	}
	return RunSteps(io, sessionID, "PreToolUse", steps, Outcome{})
}

// PostToolUse: 変更ファイルの記録、post_edit の検査、gate の rules フェーズ。Agent / Task はサブエージェントの結果の受け渡し。対象外は何もしない。
func PostToolUse(io Io, sessionID string, payload Dict) HookRun {
	tool := strOf(payload["tool_name"])
	run := func(steps []Step) HookRun { return RunSteps(io, sessionID, "PostToolUse", steps, Outcome{}) }
	// 終わったサブエージェントの SubagentStop で走った hook の結果を、呼び出し元の context へ渡す（gate のログを読ませない）。
	if reTaskTools.MatchString(tool) {
		return run([]Step{func(i Io) ScriptResult { return SubagentReport(i, payload) }})
	}
	// Bash が実際に書き換えたファイルを拾い、Edit / Write と同じく feedback の post_edit（と、実行後に判定できる
	// pre_edit）で検査してから、メモに記録できたときだけ rules フェーズを走らせる。gate.yaml が無くても feedback の検査は動く。
	if tool == "Bash" {
		return run(BashChangeSteps(payload))
	}
	if !reWriteTools.MatchString(tool) {
		return HookRun{}
	}
	// gate の実行より先に、軽い feedback の post_edit 検査を済ませる。
	return run([]Step{
		func(i Io) ScriptResult { return RecordChanges(i, payload) },
		func(i Io) ScriptResult { return FeedbackPostEdit(i, payload) },
		func(i Io) ScriptResult { return StopTestGate(i, "rules", payload) },
	})
}

// PreToolUseEdits は複数ファイルを 1 回で編集するツール向け: ファイルごとに PreToolUse を走らせ、deny > ask で 1 つの判定にする。
func PreToolUseEdits(io Io, sessionID string, options PluginOptions, payloads []Dict) HookRun {
	var denies, asks []string
	var stderr strings.Builder
	for _, p := range payloads {
		r := PreToolUse(io, sessionID, options, p)
		if r.Outcome.Deny != nil {
			denies = append(denies, *r.Outcome.Deny)
		}
		if r.Outcome.Ask != nil {
			asks = append(asks, *r.Outcome.Ask)
		}
		stderr.WriteString(r.Stderr)
	}
	outcome := Outcome{}
	if len(denies) > 0 {
		outcome.Deny = StrPtr(strings.Join(append(denies, asks...), "\n"))
	} else if len(asks) > 0 {
		outcome.Ask = StrPtr(strings.Join(asks, "\n"))
	}
	return HookRun{Outcome: outcome, Stderr: stderr.String()}
}

// PostToolUseEdits は複数ファイルを 1 回で編集するツール向け: ファイルごとの記録と post_edit の後、gate の rules フェーズは 1 回だけ走らせる。
func PostToolUseEdits(io Io, sessionID string, payloads []Dict) HookRun {
	if len(payloads) == 0 {
		return HookRun{}
	}
	var steps []Step
	for _, p := range payloads {
		steps = append(steps,
			func(i Io) ScriptResult { return RecordChanges(i, p) },
			func(i Io) ScriptResult { return FeedbackPostEdit(i, p) },
		)
	}
	first := payloads[0]
	steps = append(steps, func(i Io) ScriptResult { return StopTestGate(i, "rules", first) })
	return RunSteps(io, sessionID, "PostToolUse", steps, Outcome{})
}

// NotificationHook は Notification: 確認待ちのデスクトップ通知。何も返さない（TS の hooks.notification）。
func NotificationHook(io Io, sessionID string, payload Dict) HookRun {
	return RunSteps(io, sessionID, "Notification", []Step{func(i Io) ScriptResult { return Notification(i, "notify", payload) }}, Outcome{})
}

// Stop: gate の checks フェーズ、feedback の stop_check、完了通知（all_stop.go）。
func Stop(io Io, sessionID string, payload Dict) HookRun {
	return RunSteps(io, sessionID, "Stop", []Step{func(i Io) ScriptResult { return AllStop(i, payload) }}, Outcome{})
}

// SubagentStop: gate の checks フェーズと stop_check。結果は呼び出し元の PostToolUse(Agent) へ渡すために控える（subagent_report.go）。
func SubagentStop(io Io, sessionID string, payload Dict) HookRun {
	var gate, feedback *ScriptResult
	return RunSteps(io, sessionID, "SubagentStop", []Step{
		func(i Io) ScriptResult {
			r := StopTestGate(i, "checks", payload)
			gate = &r
			return r
		},
		func(i Io) ScriptResult {
			r := FeedbackStopCheck(i, payload)
			feedback = &r
			return r
		},
		func(i Io) ScriptResult { return SaveSubagentReport(i, payload, gate, feedback) },
	}, Outcome{})
}
