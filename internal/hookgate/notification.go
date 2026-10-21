package hookgate

// Notification / Stop 時のデスクトップ通知（macOS の terminal-notifier）。
// kind: notify（確認待ち）| stop（完了）。それ以外は何もしない。

import "strings"

// notifyLabel は通知の種類ごとの、見出しと本文の既定（locales/*.yaml のキー）。
type notifyLabel struct{ label, fallback string }

var notifyLabels = map[string]notifyLabel{
	"notify": {label: "notify.waiting", fallback: "notify.waitingFallback"},
	"stop":   {label: "notify.done", fallback: "notify.doneFallback"},
}

const notifyFrontWindowScript = `tell application "System Events" to tell (first process whose frontmost is true) to get name of (first window whose value of attribute "AXMain" is true)`

// notifyTrimNewlines は JS の replace(/\n+$/, ”)。
func notifyTrimNewlines(s string) string { return strings.TrimRight(s, "\n") }

// notifyGroupName はアプリ名を通知グループ名にする（小文字にして、空白の並びを - に。JS の toLowerCase().replace(/\s+/g, '-')）。
func notifyGroupName(appName string) string {
	var b strings.Builder
	inSpace := false
	for _, r := range strings.ToLower(appName) {
		if isJSSpace(r) {
			if !inSpace {
				b.WriteByte('-')
			}
			inSpace = true
			continue
		}
		inSpace = false
		b.WriteRune(r)
	}
	return b.String()
}

// Notification は kind（notify | stop）のデスクトップ通知を出す。常に ok を返す。
func Notification(io Io, kind string, payload Dict) ScriptResult {
	k, found := notifyLabels[kind]
	if !found {
		return Ok("", "")
	}
	t := Tr(io.Lang())

	cwd := JqStr(payload["cwd"])
	if cwd == "" {
		cwd = io.Cwd()
	}
	message := JqStr(payload["message"])
	if message == "" {
		message = t(k.fallback)
	}

	// エディタのウィンドウはリポジトリルートで開かれていることが多く、サブディレクトリを渡すと既存ウィンドウが
	// そのフォルダを開き直してしまう
	top := io.Run([]string{"git", "-C", cwd, "rev-parse", "--show-toplevel"}, RunOptions{})
	gitRoot := ""
	if top.ExitCode == 0 {
		gitRoot = notifyTrimNewlines(top.Stdout)
	}
	target := gitRoot
	if target == "" {
		target = cwd
	}
	project := Basename(target)

	// 対象を今まさに見ているなら通知しない。権限が無く前面ウィンドウ名を取れない場合は通知する
	// front window は名前の無い隠しウィンドウを拾うことがあるため AXMain で実ウィンドウを選ぶ
	front := io.Run([]string{"osascript", "-e", notifyFrontWindowScript}, RunOptions{})
	frontName := ""
	if front.ExitCode == 0 {
		frontName = notifyTrimNewlines(front.Stdout)
	}
	if strings.Contains(frontName, project) {
		return Ok("", "")
	}

	// TERM_PROGRAM は hook まで引き継がれないことがあるので、判別できたターミナル以外は VSCode 扱いにする。
	// Cursor / Windsurf も vscode を名乗るため実際の bundle id を優先する
	isVscode := true
	appBundle := "com.microsoft.VSCode"
	switch io.Env().TermProgram {
	case "vscode":
		appBundle = io.Env().CFBundleID
		if appBundle == "" {
			appBundle = "com.microsoft.VSCode"
		}
	case "iTerm.app":
		appBundle = "com.googlecode.iterm2"
		isVscode = false
	case "WarpTerminal":
		appBundle = "dev.warp.Warp-Terminal"
		isVscode = false
	case "Ghostty":
		appBundle = "com.mitchellh.ghostty"
		isVscode = false
	case "Apple_Terminal":
		appBundle = "com.apple.Terminal"
		isVscode = false
	}

	// -activate はアプリを前面に出すだけで、複数ウィンドウのうちどれかを選べない。
	// VSCode 系は code -r で対象を開いているウィンドウ自体にフォーカスさせる
	click := "open -b " + ShellQuote(appBundle)
	if isVscode {
		codeBin, _ := Which(io, "code")
		if codeBin == "" || !io.IsExecutable(codeBin) {
			codeBin = "/usr/local/bin/code"
		}
		if io.IsExecutable(codeBin) {
			click = ShellQuote(codeBin) + " -r " + ShellQuote(target)
		}
	}

	if _, ok := Which(io, "terminal-notifier"); !ok {
		return Ok("", "")
	}

	appName := io.AppName()
	if appName == "" {
		appName = "Claude Code"
	}
	group := notifyGroupName(appName)

	io.Run([]string{
		"terminal-notifier",
		"-title",
		appName,
		"-subtitle",
		"📁 " + project + " · " + t(k.label),
		"-message",
		message,
		"-group",
		group + "-" + target,
		"-execute",
		click,
	}, RunOptions{})
	return Ok("", "")
}
