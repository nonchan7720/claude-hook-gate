package hookgate

// SessionStart hook: 自分のセッション分の状態だけを消す。加えて、クラッシュ等で残った古いセッションの
// ゴミ（24h超）も掃除する。
// 注意: stdout に出力しないこと（UserPromptSubmit では context に注入されるため）。
//
// SessionStart は起動時だけでなく resume / `/clear` / compact でも発火する。resume / compact は同一
// セッションの継続なので、無条件に消すと中断前に変更したファイルがゲートの検証対象から丸ごと落ちて
// しまう。source が startup / clear のときだけ削除し、resume / compact や未知の source
// （取得できない場合を含む）では安全側に倒して削除しない。

import "strings"

// fbStateFile は [ファイル名の先頭, 拡張子]。<base>.<session>.<ext> と <base>.<session>--<agent>.<ext> が対象。
type fbStateFile struct{ base, ext string }

var fbStateFiles = []fbStateFile{
	{"changed_files", ".txt"},
	{"gate_attempts", ".txt"},
	{"gate_passed", ".txt"},
	{"gate_push_verified", ".txt"},
	{"gate_reported", ".txt"},
	{"gate_pending_checks", ".json"},
	{"gate_trace", ".jsonl"},
	{"gate_deferred", ".json"},
	{"gate_failed", ".txt"},
	{"bash_started", ".json"},
	{"feedback_gate_attempts", ".txt"},
	{"subagent_report", ".json"},
	{"summary", ".txt"},
}

const fbResetDayMs int64 = 1440 * 60 * 1000

func fbGlobMatch(name, prefix, suffix string) bool {
	return len(name) >= len(prefix)+len(suffix) && strings.HasPrefix(name, prefix) && strings.HasSuffix(name, suffix)
}

// ResetGate は SessionStart で自分のセッション分の状態を消し、古い状態を掃除する。
func ResetGate(io Io, payload Dict) ScriptResult {
	claudeDir := io.ProjectConfigDir()
	stateDir := GateStatusDir(io)
	sessionID := JqStr(payload["session_id"])
	if sessionID == "" {
		sessionID = "unknown"
	}
	source := JqStr(payload["source"])
	now := io.Now()

	if source == "startup" || source == "clear" {
		// SubagentStop 経由の状態ファイル（changed_files.<session>--<agent>.txt 等）も対象。置き場所は
		// .claude/.gate-status/。移行前の旧パス（.claude/ 直下と .claude/hooks/logs/）の残骸も同じ条件で消す。
		for _, dir := range []string{stateDir, claudeDir} {
			entries := io.List(dir)
			doomed := []string{}
			for _, sf := range fbStateFiles {
				exact := sf.base + "." + sessionID + sf.ext
				for _, e := range entries {
					if e.Name == exact || fbGlobMatch(e.Name, sf.base+"."+sessionID+"--", sf.ext) {
						doomed = append(doomed, Join(dir, e.Name))
					}
				}
			}
			io.RemoveFiles(doomed)
		}
		for _, logRoot := range []string{Join(stateDir, "logs"), Join(claudeDir, "hooks", "logs")} {
			for _, e := range io.List(logRoot) {
				if e.Name == sessionID || strings.HasPrefix(e.Name, sessionID+"--") {
					io.RemoveTree(Join(logRoot, e.Name))
				}
			}
		}
	}

	for _, dir := range []string{stateDir, claudeDir} {
		old := []string{}
		for _, e := range io.List(dir) {
			if e.Kind != KindFile || e.MtimeMs >= now-fbResetDayMs {
				continue
			}
			for _, sf := range fbStateFiles {
				if fbGlobMatch(e.Name, sf.base+".", sf.ext) {
					old = append(old, Join(dir, e.Name))
					break
				}
			}
		}
		io.RemoveFiles(old)
	}

	// ログ（新: .gate-status/logs/<state_id>/、旧: hooks/logs/<state_id>/）も 24h 超は掃除する。
	for _, logRoot := range []string{Join(stateDir, "logs"), Join(claudeDir, "hooks", "logs")} {
		for _, e := range io.List(logRoot) {
			if e.Kind != KindDir {
				continue
			}
			if st, ok := io.Stat(Join(logRoot, e.Name)); ok && st.MtimeMs < now-fbResetDayMs {
				io.RemoveTree(Join(logRoot, e.Name))
			}
		}
	}
	// classic.* が走った印のマーカー（<feedbackDir>/.classic_seen/<session>。register.ts が書き、scripts/hook.sh が見る）も、
	// 24h 超は掃除する。classic.Notification のたびに書き直されるので、動いているセッションのものは消えない。
	// Codex のプラグイン層の hook が走った印（<feedbackDir>/.codex_plugin_seen/<session>。host_codex.go が書き、
	// ~/.codex/hooks.json などへの写しが見る）も同じ。
	stale := []string{}
	for _, name := range []string{".classic_seen", CodexPluginSeenDir} {
		seenDir := Join(FeedbackDir(io), name)
		for _, e := range io.List(seenDir) {
			if e.Kind == KindFile && e.MtimeMs < now-fbResetDayMs {
				stale = append(stale, Join(seenDir, e.Name))
			}
		}
	}
	io.RemoveFiles(stale)

	// 旧パスのログ置き場が空になったら片付ける。
	io.RemoveDir(Join(claudeDir, "hooks", "logs"))
	io.RemoveDir(Join(claudeDir, "hooks"))

	return Ok("", "")
}
