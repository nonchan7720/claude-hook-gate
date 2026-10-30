package hookgate

// gate のコマンド実行（src/gate.ts の runCmd / runCmdShared / showRunning / execOne / runParallel / runCmds / runDeferred）。

import (
	"fmt"
	"math"
	"strings"
)

// gateTimeoutMs は timeout 秒を Io.Run に渡すミリ秒にする: Math.min(Math.round(timeout * 1000), MAX_TIMEOUT_MS)。
func gateTimeoutMs(timeout float64) int64 {
	if math.IsNaN(timeout) {
		return gateMaxTimeoutMs
	}
	return int64(math.Min(math.Floor(timeout*1000+0.5), gateMaxTimeoutMs))
}

func (g *Gate) newLogPath(name, cmd string) string {
	n := name
	if n == "" {
		n = cmd
	}
	uid := fmt.Sprintf("%d-%d", int64(math.Floor(float64(g.Io.Now())/1000)), gateNextLogSeq())
	return Join(g.LogDir, Slug(n)+"."+uid+".log")
}

// RunCmd はコマンドを実行し { out, ok, timedOut, logpath } を返す。出力（stdout と stderr を混ぜたもの）は
// logDir/{name もしくは cmd}.{uid}.log に書き出す。タイムアウト時は強制終了して失敗扱い。
// pidFiles には、コマンドを走らせるシェルの PID を書く（コマンドはこのシェルの中で走るので、PID はコマンドの終了まで
// 変わらない）。共有・直列化のロックの生死を、hook ではなくコマンドの生死で判定するため（shared_run.go）。
// 書けなくても（ロックが消えた後など）コマンドの出力は汚さない。コマンドの位置引数（$@）は変えない。
func (g *Gate) RunCmd(cmd, cwd string, timeout float64, name string, extraEnv GateEnv, pidFiles []string) SharedOutcome {
	logpath := g.newLogPath(name, cmd)
	header := fmt.Sprintf("$ %s  (cwd: %s)\n", cmd, cwd)
	_ = g.Io.WriteFile(logpath, header)
	started := g.Io.Now()
	var writePid strings.Builder
	for _, f := range pidFiles {
		writePid.WriteString("{ echo $$ > " + ShellQuote(f) + "; } 2>/dev/null; ")
	}
	env := GateEnv{}
	for k, v := range g.BaseEnv {
		env[k] = v
	}
	for k, v := range extraEnv {
		env[k] = v
	}
	timeoutMs := max(gateTimeoutMs(timeout), 1)
	r := g.Io.Run([]string{"sh", "-c", deathWatch() + writePid.String() + "exec 2>&1; " + cmd}, RunOptions{Cwd: cwd, Env: env, TimeoutMs: timeoutMs, DieWithParent: true})
	// エンジンの process.run はタイムアウトを「起動できなかった」と同じ拒否で返すので、経過時間で見分ける。
	elapsed := g.Io.Now() - started
	timedOut := r.TimedOut || (r.Error != "" && float64(elapsed) >= math.Min(timeout*1000, gateMaxTimeoutMs)-1000)
	out := r.Stdout + r.Stderr
	if r.Error != "" && !timedOut {
		if out != "" && !strings.HasSuffix(out, "\n") {
			out += "\n"
		}
		out += r.Error + "\n"
	}
	_ = g.Io.WriteFile(logpath, header+out)
	return SharedOutcome{Out: out, Ok: r.ExitCode == 0 && !timedOut && r.Error == "", TimedOut: timedOut, Logpath: logpath}
}

// runCmdShared は RunCmd を、同じキーの実行が他のエージェントで進行中ならその完了を待って結果を受け取る形で呼ぶ。受け取った
// 側も自分の logDir にログを書く（出力を複製し、実行側のログのパスを添える）。scope.Share が false なら
// 共有せず従来どおり自分で実行する。onWait は待機側になったときに呼ばれる。
func (g *Gate) runCmdShared(cmd, cwd string, timeout float64, name string, extraEnv GateEnv, scope ExecScope, onWait func()) SharedOutcome {
	if !scope.shareOn() {
		return RunWithSlot(g.Io, g.maxParallel, gateTimeoutMs(timeout), func(pidFiles []string) SharedOutcome {
			return g.RunCmd(cmd, cwd, timeout, name, extraEnv, pidFiles)
		})
	}
	env := GateEnv{}
	for k, v := range g.BaseEnv {
		env[k] = v
	}
	for k, v := range extraEnv {
		env[k] = v
	}
	key := ShareKey(scope.Root, cwd, cmd, env)
	r := RunShared(
		g.Io,
		key,
		ShareFiles(env, scope.filesOn()),
		gateTimeoutMs(timeout),
		func(pidFiles []string, files []string) SharedOutcome {
			// 実行側になったときの対象ファイルは、待っている側の分をまとめた和集合（自分の分だけなら元のまま）。
			runEnv := extraEnv
			if scope.filesOn() && len(files) > 0 {
				runEnv = MergeFilesEnv(extraEnv, FilesEnv(files))
			}
			return g.RunCmd(cmd, cwd, timeout, name, runEnv, pidFiles)
		},
		SharedHooks{OnWait: onWait, Serial: SerialKey(name, cmd), MaxParallel: g.maxParallel},
	)
	if !r.Shared {
		return r.Outcome
	}
	logpath := g.newLogPath(name, cmd)
	header := fmt.Sprintf("$ %s  (cwd: %s)\n%s\n", cmd, cwd, g.T("gate.sharedResult", map[string]any{"logpath": r.Outcome.Logpath}))
	_ = g.Io.WriteFile(logpath, header+r.Outcome.Out)
	out := r.Outcome
	out.Logpath = logpath
	return out
}

// runningHandle は showRunning の戻り値。Waiting は他のエージェントの実行の完了待ちになったとき、Done は完了時に呼ぶ。
type runningHandle struct {
	waiting func()
	done    func(ok bool)
}

// showRunning は実行中のコマンドを、プロンプトの上の帯に出す（描画は register.ts の ui.render。ここでは全エージェントの実行中
// 一覧に自分の分を公開して、帯を描き直させる）。waiting は他のエージェントの実行の完了待ちになったとき、
// done は完了時に呼ぶ（成否を渡すと ✓/✗ 付きで残る）。経過秒を更新するため、実行中は 1 秒ごとに描き直す。
// 全エージェントの実行が終わったら帯は消え、その回の結果を 1 行にまとめてステータス行に残す。次のコマンドが
// 走り始めたらそのステータス行を消す。
func (g *Gate) showRunning(name, cmd string, started int64) runningHandle {
	entry := &RunningEntry{Name: name, Cmd: cmd, Started: started}
	g.uiMu.Lock()
	defer g.uiMu.Unlock()
	g.running = append(g.running, entry)
	if g.stopTicking == nil {
		g.stopTicking = g.Io.Every(1000, g.redrawLocked)
	}
	g.Io.Result("")
	ClearSummary(g.Io, g.SessionID)
	g.publishAndRedraw()
	return runningHandle{
		waiting: func() {
			g.uiMu.Lock()
			defer g.uiMu.Unlock()
			entry.Waiting = true
			g.publishAndRedraw()
		},
		done: func(ok bool) {
			g.uiMu.Lock()
			defer g.uiMu.Unlock()
			entry.Result = "fail"
			if ok {
				entry.Result = "ok"
			}
			entry.Ended = Int64Ptr(g.Io.Now())
			entry.Waiting = false
			allDone := true
			for _, r := range g.running {
				if r.Result == "" {
					allDone = false
				}
			}
			if allDone {
				g.stopTickerLocked()
			}
			g.publishAndRedraw()
			if summary, found := FinishedSummary(ListRunning(g.Io, g.SessionID), g.Io.Lang()); found {
				g.Io.Result(summary)
				gateCheck(SaveSummary(g.Io, g.SessionID, summary))
			}
		},
	}
}

// redrawLocked は ticker から呼ばれる再描画（uiMu を取る）。
func (g *Gate) redrawLocked() {
	g.uiMu.Lock()
	defer g.uiMu.Unlock()
	g.Io.Redraw()
}

// stopTickerLocked は uiMu を持った状態で ticker を止める。
func (g *Gate) stopTickerLocked() {
	if g.stopTicking != nil {
		g.stopTicking()
		g.stopTicking = nil
	}
}

// FinishProgress は RunGate の終わりに呼ぶ。自分の分を一覧から外して再描画を止め、帯を描き直させる（他のエージェントが実行中ならその一覧が残る）。
func (g *Gate) FinishProgress() {
	g.uiMu.Lock()
	defer g.uiMu.Unlock()
	g.stopTickerLocked()
	g.running = nil
	WithdrawRunning(g.Io, g.runningOwner)
	g.Io.Redraw()
}

// publishAndRedraw は自分の一覧を公開して帯を描き直させる（uiMu を持った状態で呼ぶ）。
func (g *Gate) publishAndRedraw() {
	entries := make([]RunningEntry, len(g.running))
	for i, e := range g.running {
		entries[i] = *e
	}
	gateCheck(PublishRunning(g.Io, g.runningOwner, entries))
	g.Io.Redraw()
}

// ExecOne は1コマンド実行して (ログ行リスト, ok) を返す。並行実行時もログを混ぜないため一旦まとめる。
func (g *Gate) ExecOne(label, cmd, cwd string, timeout float64, mark, name string, extraEnv GateEnv, scope ExecScope) (GateChunk, bool) {
	return g.execOne(label, cmd, cwd, timeout, mark, name, extraEnv, scope, nil)
}

// execOne は ExecOne の本体。registered は帯の一覧に自分の分を登録し終えたとき（実行を始める直前）に呼ばれる。parallel ブロックで
// 帯の並びを定義順にするため（TS では各 execOne が最初の await まで順に進むので、登録は定義順になる）。
func (g *Gate) execOne(label, cmd, cwd string, timeout float64, mark, name string, extraEnv GateEnv, scope ExecScope, registered func()) (GateChunk, bool) {
	if scope.Root == "" {
		scope.Root = g.ProjectDir
	}
	title := cmd
	if name != "" {
		title = name + ": " + cmd
	}
	chunk := GateChunk{Lines: []string{fmt.Sprintf("=== [gate] (%s)%s $ %s ===", label, mark, title)}}
	started := g.Io.Now()
	progress := func() runningHandle {
		if registered != nil {
			defer registered()
		}
		return g.showRunning(name, cmd, started)
	}()
	var ran SharedOutcome
	passed := false
	func() {
		defer func() { progress.done(passed) }()
		ran = g.runCmdShared(cmd, cwd, timeout, name, extraEnv, scope, progress.waiting)
		passed = ran.Ok
	}()
	// 実行した（または共有で受け取った）コマンドは、控えに同じものが残っていれば消化済みとして外す。
	g.mu.Lock()
	g.ranThisRun[gateDeferKeyOf(scope.Root, cwd, cmd)] = true
	g.mu.Unlock()
	g.UndeferCmd(scope.Root, cwd, cmd)
	label2 := name
	if label2 == "" {
		label2 = OneLine(cmd)
	}
	g.mu.Lock()
	g.executedLabels = append(g.executedLabels, label2)
	g.mu.Unlock()
	kind := "fail"
	if ran.Ok {
		kind = "ok"
	}
	g.Note(kind, label, cmd, fmt.Sprintf("(%ss)", ToFixed(float64(g.Io.Now()-started)/1000, 1)))
	detail := []string{chunk.Lines[0]}
	if ran.Out != "" {
		chunk.Lines = append(chunk.Lines, gateTrimEnd(ran.Out))
		detail = append(detail, TailOutput(g.Io.Lang(), ran.Out, gateFailTailLines))
	}
	if ran.TimedOut {
		msg := g.T("gate.timeout", map[string]any{"seconds": timeout})
		chunk.Lines = append(chunk.Lines, msg)
		detail = append(detail, msg)
	}
	if !ran.Ok {
		chunk.Lines = append(chunk.Lines, "[gate] log: "+ran.Logpath)
		detail = append(detail, "[gate] log: "+ran.Logpath)
		chunk.Detail = strings.Join(detail, "\n")
	}
	return chunk, ran.Ok
}

func (g *Gate) collectFailure(chunk GateChunk) {
	if chunk.Detail != "" {
		g.mu.Lock()
		g.Failures = append(g.Failures, chunk.Detail)
		g.mu.Unlock()
	}
}

// WithDetails は prefix に失敗の詳細を足す。
func (g *Gate) WithDetails(prefix string) string {
	details := FailureDetails(g.Io.Lang(), g.Failures)
	if details == "" {
		return prefix
	}
	return prefix + "\n\n" + g.T("gate.failedOutputHeader") + "\n" + details
}

type parallelTask struct {
	cmd     string
	timeout float64
	name    string
	scope   ExecScope
}

// RunParallel は parallel ブロック内のコマンドを並行実行。ログは定義順で出力。失敗があれば true。
func (g *Gate) RunParallel(label string, items []RunItem, cwd string, defaultTimeout float64, logs *[]string, policy *PolicyContext, extraEnv GateEnv, root string) bool {
	failed := false
	var tasks []parallelTask
	for _, item := range items {
		if gateIsParallel(item) {
			*logs = append(*logs, g.T("gate.nestedParallel", map[string]any{"label": label}))
			failed = true
			continue
		}
		cmd, timeout, name := ParseCmd(item, defaultTimeout)
		if cmd == "" {
			continue
		}
		if policy != nil && !policy.Allows(label, cwd, cmd, timeout, name, logs, extraEnv) {
			continue
		}
		share, files := ParseShare(item), ParseFiles(item)
		tasks = append(tasks, parallelTask{cmd, timeout, name, ExecScope{Root: root, Share: &share, Files: &files}})
	}
	if len(tasks) == 0 {
		return failed
	}
	chunks := make([]GateChunk, len(tasks))
	oks := make([]bool, len(tasks))
	gateParallelDo(len(tasks), func(i int, registered func()) {
		t := tasks[i]
		chunks[i], oks[i] = g.execOne(label, t.cmd, cwd, t.timeout, " [parallel]", t.name, extraEnv, t.scope, registered)
	})
	for i, t := range tasks {
		*logs = append(*logs, chunks[i].Lines...)
		g.collectFailure(chunks[i])
		if policy != nil {
			policy.Record(cwd, t.cmd, t.name, oks[i])
		}
		if !oks[i] {
			failed = true
		}
	}
	return failed
}

// RunCmds はコマンド列を順に実行してログを蓄積。1つでも失敗/タイムアウトなら true を返す。
func (g *Gate) RunCmds(label string, cmds []RunItem, cwd string, defaultTimeout float64, logs *[]string, policy *PolicyContext, extraEnv GateEnv, root string) bool {
	failed := false
	for _, item := range cmds {
		if gateIsParallel(item) {
			d, _ := AsDict(item)
			items, _ := d["parallel"].([]any)
			if g.RunParallel(label, items, cwd, defaultTimeout, logs, policy, extraEnv, root) {
				failed = true
			}
			continue
		}
		cmd, timeout, name := ParseCmd(item, defaultTimeout)
		if cmd == "" {
			continue
		}
		if policy != nil && !policy.Allows(label, cwd, cmd, timeout, name, logs, extraEnv) {
			continue
		}
		share, files := ParseShare(item), ParseFiles(item)
		chunk, ok := g.ExecOne(label, cmd, cwd, timeout, "", name, extraEnv, ExecScope{Root: root, Share: &share, Files: &files})
		*logs = append(*logs, chunk.Lines...)
		g.collectFailure(chunk)
		if policy != nil {
			policy.Record(cwd, cmd, name, ok)
		}
		if !ok {
			failed = true
		}
	}
	return failed
}

// RunDeferred は控えに溜まったコマンドを実行する。ここではポリシー判定をバイパスする。判定していないので request は
// 残さず、結果だけを実行履歴に残す。cwd が消えているエントリは実行せずに捨てる。
// 戻り値: (summary, 失敗したエントリのリスト)。
func (g *Gate) RunDeferred(entries []Dict, logs *[]string) ([]string, []Dict) {
	summary := []string{}
	failed := []Dict{}
	for _, entry := range entries {
		cmd := gateTruthyStr(entry["cmd"])
		cwd := gateTruthyStr(entry["cwd"])
		if cmd == "" {
			continue
		}
		label := "deferred:"
		if l := gateTruthyStr(entry["label"]); l != "" {
			label += l
		} else {
			label += "."
		}
		if !gateIsDir(g.Io, cwd) {
			*logs = append(*logs, g.T("gate.deferredNoCwd", map[string]any{"label": label, "cwd": cwd}))
			continue
		}
		name := gateTruthyStr(entry["name"])
		if name == "" {
			name = Slug(cmd)
		}
		summary = append(summary, "("+label+") "+cmd)
		timeout := float64(DEFAULT_TIMEOUT)
		if Truthy(entry["timeout"]) {
			if f := jsNumber(entry["timeout"]); !math.IsNaN(f) {
				timeout = f
			}
		}
		root := gateTruthyStr(entry["root"])
		if root == "" {
			root = g.ProjectDir
		}
		chunk, ok := g.ExecOne(label, cmd, cwd, timeout, "", name, gateEntryEnv(entry), ExecScope{Root: root})
		*logs = append(*logs, chunk.Lines...)
		g.collectFailure(chunk)
		kind := "error"
		if ok {
			kind = "response"
		}
		g.AppendTrace(root, cwd, name, cmd, kind)
		if !ok {
			failed = append(failed, entry)
		}
	}
	return summary, failed
}

// RequeueDeferred は失敗した控えを積み直す（次の checks フェーズ・commit / push でも消化を求めるため）。
func (g *Gate) RequeueDeferred(entries []Dict) {
	for _, e := range entries {
		timeout := 0.0
		if f := jsNumber(e["timeout"]); !math.IsNaN(f) {
			timeout = f
		}
		g.DeferCmd(gateTruthyStr(e["root"]), gateTruthyStr(e["cwd"]), gateTruthyStr(e["name"]), gateTruthyStr(e["cmd"]), timeout, gateTruthyStr(e["label"]), gateEntryEnv(e))
	}
}
