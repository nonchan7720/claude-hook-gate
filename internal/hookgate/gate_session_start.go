package hookgate

// gate.yaml の session_start フェーズ。SessionStart で走らせるコマンドの stdout を additionalContext として返す。
// ポリシー（dogwood）・後回し・実行共有は使わない: セッションごとの出力をその場で context に入れるのが目的なので、
// 「あとで走らせる」「他のエージェントと共有する」の意味がない。同時実行枠（max_parallel）だけは守る。
// 失敗してもセッションは止めない（stderr に 1 回だけ知らせ、exit は 0）。メインのセッションだけが対象（agent_id があれば何もしない）。

import (
	"fmt"
	"math"
	"strings"
	"sync"
)

const (
	// SessionStartTimeout は session_start の既定のタイムアウト（秒）。起動を遅らせないため短い。
	SessionStartTimeout = 10
	// SessionStartMaxChars は additionalContext に入れる出力の合計の上限（文字）。
	SessionStartMaxChars = 8192
	// SessionStartMaxTimeout は timeout: の上限（秒。hooks.json の SessionStart の timeout と同じ）。
	SessionStartMaxTimeout = 600
)

type sessionStartItem struct {
	cmd        string
	name       string
	timeout    float64
	on         []string
	hasOn      bool
	background bool
}

// parseSessionStartItem は session_start の 1 要素（文字列 or マッピング）を正規化する。cmd が無いものは ok=false。
func parseSessionStartItem(raw any) (sessionStartItem, bool) {
	d, isDict := AsDict(raw)
	if !isDict {
		d = Dict{"cmd": raw}
	}
	cmd, _ := d["cmd"].(string)
	if strings.TrimSpace(cmd) == "" {
		return sessionStartItem{}, false
	}
	item := sessionStartItem{cmd: cmd, name: Slug(cmd), timeout: SessionStartTimeout, background: d["background"] == true}
	if Truthy(d["name"]) {
		item.name = gateTruthyStr(d["name"])
	}
	if t, ok := numberOf(d["timeout"]); ok && t > 0 && !math.IsInf(t, 0) {
		item.timeout = math.Min(t, SessionStartMaxTimeout)
	}
	switch on := d["on"].(type) {
	case string:
		item.on, item.hasOn = []string{on}, true
	case []any:
		item.hasOn = true
		for _, v := range on {
			item.on = append(item.on, fmt.Sprint(v))
		}
	}
	return item, true
}

func (it sessionStartItem) matches(source string) bool {
	if !it.hasOn {
		return true
	}
	for _, s := range it.on {
		if s == source {
			return true
		}
	}
	return false
}

type sessionStartDone struct {
	block string
	note  string
	// sys は stdout の hook JSON にあった最上位の systemMessage。
	sys string
}

// sessionStartReadOutput はコマンドの stdout を context 用の文章にする。SessionStart の hook JSON（オブジェクト）なら
// hookSpecificOutput.additionalContext（空でない文字列）だけを取り、最上位の systemMessage（文字列）は sys として返す。
// JSON でなければ trim した平文。
func sessionStartReadOutput(stdout string) (string, string) {
	t := gateTrim(stdout)
	j, ok := parseJSONDict(t)
	if !ok {
		return t, ""
	}
	var text, sys string
	if spec, ok := AsDict(j["hookSpecificOutput"]); ok {
		if s, ok := spec["additionalContext"].(string); ok {
			text = gateTrim(s)
		}
	}
	if s, ok := j["systemMessage"].(string); ok {
		sys = gateTrim(s)
	}
	return text, sys
}

func (g *Gate) sessionStartFailed(item sessionStartItem, reason, logpath string) string {
	return g.T("gate.sessionStartFailed", map[string]any{"name": item.name, "reason": reason, "logpath": logpath}) + "\n"
}

func (g *Gate) sessionStartForeground(item sessionStartItem, env GateEnv) sessionStartDone {
	logpath := g.newLogPath(item.name, item.cmd)
	header := fmt.Sprintf("$ %s  (cwd: %s)\n", item.cmd, g.ProjectDir)
	_ = g.Io.WriteFile(logpath, header)
	timeoutMs := max(gateTimeoutMs(item.timeout), 1)
	started := g.Io.Now()
	code := 1
	r := RunWithSlot(g.Io, g.maxParallel, timeoutMs, func(pidFiles []string) SharedOutcome {
		var writePid strings.Builder
		for _, f := range pidFiles {
			writePid.WriteString("{ echo $$ > " + ShellQuote(f) + "; } 2>/dev/null; ")
		}
		run := g.Io.Run([]string{"sh", "-c", deathWatch() + writePid.String() + item.cmd}, RunOptions{Cwd: g.ProjectDir, Env: env, TimeoutMs: timeoutMs, DieWithParent: true})
		elapsed := g.Io.Now() - started
		timedOut := run.TimedOut || (run.Error != "" && float64(elapsed) >= float64(timeoutMs)-1000)
		out := run.Stdout
		if run.Error != "" && !timedOut {
			out += run.Error + "\n"
		}
		code = run.ExitCode
		_ = g.Io.WriteFile(logpath, header+out+run.Stderr)
		return SharedOutcome{Out: out, Ok: run.ExitCode == 0 && !timedOut && run.Error == "", TimedOut: timedOut, Logpath: logpath}
	})
	if !r.Ok {
		reason := g.T("gate.sessionStartExit", map[string]any{"code": code})
		if r.TimedOut {
			reason = g.T("gate.sessionStartTimeout", map[string]any{"seconds": item.timeout})
		}
		return sessionStartDone{note: g.sessionStartFailed(item, reason, logpath)}
	}
	text, sys := sessionStartReadOutput(r.Out)
	if text == "" {
		return sessionStartDone{sys: sys}
	}
	return sessionStartDone{block: g.T("gate.sessionStartHeader", map[string]any{"name": item.name}) + "\n" + text, sys: sys}
}

// sessionStartBackground は background: true のコマンドを起動して待たない。出力は注入せず、ログにだけ残す。
func (g *Gate) sessionStartBackground(item sessionStartItem, env GateEnv) sessionStartDone {
	logpath := g.newLogPath(item.name, item.cmd)
	_ = g.Io.WriteFile(logpath, fmt.Sprintf("$ %s  (cwd: %s) [background]\n", item.cmd, g.ProjectDir))
	// 標準入出力をログと /dev/null に付け替えて、hook のパイプを閉じる（hook が子の終了を待たない）。setsid があれば別セッションにする。
	script := `if command -v setsid >/dev/null 2>&1; then ` +
		`setsid nohup sh -c "$CLAUDE_GATE_BG_CMD" >>"$CLAUDE_GATE_BG_LOG" 2>&1 </dev/null & ` +
		`else nohup sh -c "$CLAUDE_GATE_BG_CMD" >>"$CLAUDE_GATE_BG_LOG" 2>&1 </dev/null & fi`
	bgEnv := GateEnv{"CLAUDE_GATE_BG_CMD": item.cmd, "CLAUDE_GATE_BG_LOG": logpath}
	for k, v := range env {
		bgEnv[k] = v
	}
	r := g.Io.Run([]string{"sh", "-c", script}, RunOptions{Cwd: g.ProjectDir, Env: bgEnv, TimeoutMs: 5000})
	if r.ExitCode != 0 || r.Error != "" {
		return sessionStartDone{note: g.sessionStartFailed(item, g.T("gate.sessionStartExit", map[string]any{"code": r.ExitCode}), logpath)}
	}
	return sessionStartDone{}
}

// SessionStartGate は gate.yaml の session_start のコマンドを並列に走らせ、成功したものの stdout を名前付きでまとめて返す。
func SessionStartGate(io Io, payload Dict) ScriptResult {
	if JqStr(payload["agent_id"]) != "" {
		return Ok("", "")
	}
	path, found := FindGateYaml(io)
	if !found {
		return Ok("", "")
	}
	sessionID := JqStr(payload["session_id"])
	g := NewGate(io, GateOptions{SessionID: sessionID, Phase: "session_start"})
	cfg, err := sessionStartLoad(g, path)
	if err != nil {
		return Ok("", "")
	}
	raw, _ := cfg["session_start"].([]any)
	source := JqStr(payload["source"])
	var items []sessionStartItem
	for _, r := range raw {
		if it, ok := parseSessionStartItem(r); ok && it.matches(source) {
			items = append(items, it)
		}
	}
	if len(items) == 0 {
		return Ok("", "")
	}
	env := GateEnv{}
	for k, v := range g.BaseEnv {
		env[k] = v
	}
	env[FILES_ENV_KEY] = ""
	env["CLAUDE_SESSION_SOURCE"] = source
	done := make([]sessionStartDone, len(items))
	var wg sync.WaitGroup
	for i, item := range items {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					done[i] = sessionStartDone{note: fmt.Sprintf("[gate] session_start: %s: %v\n", item.name, r)}
				}
			}()
			if item.background {
				done[i] = g.sessionStartBackground(item, env)
			} else {
				done[i] = g.sessionStartForeground(item, env)
			}
		}()
	}
	wg.Wait()
	var blocks []string
	var notes strings.Builder
	var sysParts []string
	for _, d := range done {
		if n := gateTrimEnd(d.note); n != "" {
			sysParts = append(sysParts, n)
		}
		if d.sys != "" {
			sysParts = append(sysParts, d.sys)
		}
		if d.block != "" {
			blocks = append(blocks, d.block)
		}
		notes.WriteString(d.note)
	}
	text := strings.Join(blocks, "\n\n")
	if gateJSLen(text) > SessionStartMaxChars {
		text = gateTrimEnd(sessionStartCut(text, SessionStartMaxChars)) + "\n" + g.T("gate.sessionStartTruncated", map[string]any{"limit": SessionStartMaxChars})
	}
	if text != "" {
		text += "\n"
	}
	res := Ok(text, notes.String())
	// stderr は exit 0 だと表示されないので、失敗の通知と JSON の systemMessage をユーザーに見せる systemMessage にも載せる。
	res.SystemMessage = strings.Join(sysParts, "\n")
	return res
}

// sessionStartCut は text を UTF-16 の n 単位以内で切る。rune を単位に数え、n を超える rune の手前で止める（サロゲートペアを割らない）。
func sessionStartCut(text string, n int) string {
	units := 0
	for i, r := range text {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			return text[:i]
		}
		units += w
	}
	return text
}

// sessionStartLoad は LoadAction の panic（読めない・壊れた YAML）を error にする。
func sessionStartLoad(g *Gate, path string) (Dict, error) {
	var (
		cfg Dict
		err error
	)
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("%v", r)
			}
		}()
		cfg = g.LoadAction(path)
	}()
	return cfg, err
}
