package hookgate

// ホスト（Claude Code / Codex）と中核（hooks.go）の境界。
// 中核は classic コマンド hook の JSON を受けて Outcome を返す。ホストごとの違いは Host の実装が吸収し、中核には手を入れない。

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// CoreEvents は中核が受けるイベント名（Claude Code の command hook のイベントと同じ）。
var CoreEvents = []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop"}

// CoreCall は中核への 1 回の呼び出し。Payloads が複数なのは 1 回で複数ファイルを編集するツールをファイルごとに分けたとき。
// ゼロ値（Event が空）は TS の undefined（何もしない）。
type CoreCall struct {
	Event    string
	Payloads []Dict
}

// Host はホストごとの違い。
type Host interface {
	// AppName は通知の見出しに使うアプリ名。
	AppName() string
	// Events は command hook が受けるイベント名。
	Events() []string
	// ConfigDirNames は設定ディレクトリ名の候補（優先順）。
	ConfigDirNames() []string
	// Options は環境変数からのプラグイン設定。
	Options(env map[string]string) PluginOptions
	// Normalize はホストのイベントと stdin の JSON を中核の呼び出しに直す。扱えないイベントは ok=false（TS の undefined）。
	Normalize(event string, payload Dict, io Io) (call CoreCall, ok bool)
	// Render は中核の結果（Outcome と warn の stderr）をホストの出力にする。
	Render(event string, outcome Outcome, stderr string, io Io) ScriptResult
}

// RunCore は中核を 1 回呼ぶ。call がゼロ値（Normalize が ok=false を返した）や Payloads が空なら何もしない。
func RunCore(io Io, call CoreCall, sessionID string, options PluginOptions) HookRun {
	if len(call.Payloads) == 0 {
		return HookRun{}
	}
	first := call.Payloads[0]
	many := len(call.Payloads) > 1
	switch call.Event {
	case "SessionStart":
		return SessionStart(io, sessionID, first)
	case "UserPromptSubmit":
		return UserPromptSubmit(io, sessionID, options)
	case "PreToolUse":
		if many {
			return PreToolUseEdits(io, sessionID, options, call.Payloads)
		}
		return PreToolUse(io, sessionID, options, first)
	case "PostToolUse":
		if many {
			return PostToolUseEdits(io, sessionID, call.Payloads)
		}
		return PostToolUse(io, sessionID, first)
	case "Notification":
		return NotificationHook(io, sessionID, first)
	case "Stop":
		return Stop(io, sessionID, first)
	case "SubagentStop":
		return SubagentStop(io, sessionID, first)
	}
	return HookRun{}
}

// RunHostHook は 1 イベントを処理して stdout / stderr / 終了コードにする（環境変数は env から読む）。
func RunHostHook(host Host, event string, payload Dict, env map[string]string) ScriptResult {
	options := host.Options(env)
	osIo := MakeOsIo(OsIoInit{
		Environ:        env,
		PayloadCwd:     strOf(payload["cwd"]),
		Language:       options.Language,
		AutoCount:      BoolPtr(options.AutoCountEnabled()),
		AppName:        host.AppName(),
		ConfigDirNames: host.ConfigDirNames(),
	})
	sessionID := strOf(payload["session_id"])
	if sessionID == "" {
		sessionID = "unknown"
	}
	call, _ := host.Normalize(event, payload, osIo)
	run := RunCore(osIo, call, sessionID, options)
	return host.Render(event, run.Outcome, run.Stderr, osIo)
}

// runHostHookSafe は RunHostHook の内部エラー（panic）を呼び出し側に出さない。
func runHostHookSafe(host Host, event string, payload Dict, env map[string]string) (ScriptResult, bool) {
	var out ScriptResult
	ok := false
	func() {
		defer func() { _ = recover() }()
		out = RunHostHook(host, event, payload, env)
		ok = true
	}()
	return out, ok
}

// CliMain は command hook の入口: `feedback-gate <host> <Event>` の <Event> 以降の args、stdin の JSON → stdout / stderr / 終了コード。
// 終了コードを返す（0: 正常・壊れた JSON・内部エラー、1: 知らないイベント）。
func CliMain(host Host, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	event := ""
	if len(args) > 0 {
		for _, e := range host.Events() {
			if e == args[0] {
				event = e
				break
			}
		}
	}
	if event == "" {
		_, _ = fmt.Fprintf(stderr, "usage: feedback-gate <claude|codex> <%s>\n", strings.Join(host.Events(), "|"))
		return 1
	}
	payload := Dict{}
	if data, err := io.ReadAll(stdin); err == nil {
		var v any
		if json.Unmarshal(data, &v) == nil {
			if d, ok := AsDict(v); ok {
				payload = d
			}
		}
		// 壊れた JSON で作業を止めない。
	}
	out, ok := runHostHookSafe(host, event, payload, EnvironMap())
	if !ok {
		// hook の内部エラーで作業を止めない。
		return 0
	}
	_, _ = io.WriteString(stdout, out.Stdout)
	_, _ = io.WriteString(stderr, out.Stderr)
	return out.ExitCode
}
