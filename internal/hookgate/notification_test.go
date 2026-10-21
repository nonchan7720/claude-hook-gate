package hookgate

// src/notification.ts のテスト。TS 版には専用の spec が無い（register.spec.ts が mod 越しに触れるだけ）ので、
// terminal-notifier / osascript / code の偽スクリプトを一時 PATH に置いて argv を記録し、引数を直接検証する。

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// notificationFakePath は偽コマンド用の bin ディレクトリを PATH の先頭に置く。Run は子プロセスの PATH をプロセス環境から
// 引くので、Setenv で差し替える（MakeIo は Setenv の後に呼ぶこと）。
func notificationFakePath(t *testing.T) string {
	t.Helper()
	bin := t.TempDir()
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return bin
}

// notificationFakeCommand は引数を 1 行ずつ log に書き出し、stdout に out を出す偽コマンドを bin に置く。
func notificationFakeCommand(t *testing.T, bin, name, log, out string) {
	t.Helper()
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > '" + log + "'\n"
	if out != "" {
		script += "printf '%s\\n' '" + out + "'\n"
	}
	if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func notificationReadArgv(t *testing.T, log string) []string {
	t.Helper()
	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatalf("terminal-notifier was not run: %v", err)
	}
	return strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
}

func notificationIo(proj string, term string, opts ...func(*IoOpts)) Io {
	o := IoOpts{ProjectDir: proj, Cwd: proj, Env: EnvVars{TermProgram: term}}
	for _, f := range opts {
		f(&o)
	}
	return MakeIo(o)
}

func TestNotification(t *testing.T) {
	t.Run("no terminal-notifier on PATH: nothing runs and exit 0", func(t *testing.T) {
		empty := t.TempDir()
		t.Setenv("PATH", empty)
		proj := TmpDir()
		defer RmTree(proj)
		for _, kind := range []string{"notify", "stop"} {
			r := Notification(notificationIo(proj, "iTerm.app"), kind, Dict{"message": "hi"})
			if r != Ok("", "") {
				t.Fatalf("%s: got %+v", kind, r)
			}
		}
	})

	t.Run("unknown kind does nothing", func(t *testing.T) {
		bin := notificationFakePath(t)
		log := filepath.Join(t.TempDir(), "argv")
		notificationFakeCommand(t, bin, "terminal-notifier", log, "")
		proj := TmpDir()
		defer RmTree(proj)
		r := Notification(notificationIo(proj, "iTerm.app"), "other", Dict{})
		if r != Ok("", "") || Exists(log) {
			t.Fatalf("got %+v, ran=%v", r, Exists(log))
		}
	})

	t.Run("notify (ja): title, subtitle, default message, group, click for iTerm", func(t *testing.T) {
		bin := notificationFakePath(t)
		log := filepath.Join(t.TempDir(), "argv")
		notificationFakeCommand(t, bin, "terminal-notifier", log, "")
		proj := TmpDir()
		defer RmTree(proj)
		r := Notification(notificationIo(proj, "iTerm.app"), "notify", Dict{})
		if r != Ok("", "") {
			t.Fatalf("got %+v", r)
		}
		want := []string{
			"-title", "Claude Code",
			"-subtitle", "📁 " + Basename(proj) + " · 確認待ち",
			"-message", "確認を待っています",
			"-group", "claude-code-" + proj,
			"-execute", "open -b com.googlecode.iterm2",
		}
		notificationAssertArgv(t, notificationReadArgv(t, log), want)
	})

	t.Run("stop (ja): done label and fallback message", func(t *testing.T) {
		bin := notificationFakePath(t)
		log := filepath.Join(t.TempDir(), "argv")
		notificationFakeCommand(t, bin, "terminal-notifier", log, "")
		proj := TmpDir()
		defer RmTree(proj)
		Notification(notificationIo(proj, "Ghostty"), "stop", Dict{})
		argv := notificationReadArgv(t, log)
		notificationAssertArgv(t, argv[2:6], []string{"-subtitle", "📁 " + Basename(proj) + " · 完了", "-message", "応答が完了しました"})
		if argv[9] != "open -b com.mitchellh.ghostty" {
			t.Fatalf("click: %q", argv[9])
		}
	})

	t.Run("notify (en): labels and payload message", func(t *testing.T) {
		bin := notificationFakePath(t)
		log := filepath.Join(t.TempDir(), "argv")
		notificationFakeCommand(t, bin, "terminal-notifier", log, "")
		proj := TmpDir()
		defer RmTree(proj)
		en := func(o *IoOpts) { o.Lang = LangEN }
		Notification(notificationIo(proj, "WarpTerminal", en), "notify", Dict{"message": "Allow rm?"})
		argv := notificationReadArgv(t, log)
		notificationAssertArgv(t, argv[2:6], []string{"-subtitle", "📁 " + Basename(proj) + " · Waiting for you", "-message", "Allow rm?"})
		if argv[9] != "open -b dev.warp.Warp-Terminal" {
			t.Fatalf("click: %q", argv[9])
		}
	})

	t.Run("stop (en): done label and fallback message", func(t *testing.T) {
		bin := notificationFakePath(t)
		log := filepath.Join(t.TempDir(), "argv")
		notificationFakeCommand(t, bin, "terminal-notifier", log, "")
		proj := TmpDir()
		defer RmTree(proj)
		en := func(o *IoOpts) { o.Lang = LangEN }
		Notification(notificationIo(proj, "Apple_Terminal", en), "stop", Dict{})
		argv := notificationReadArgv(t, log)
		notificationAssertArgv(t, argv[2:6], []string{"-subtitle", "📁 " + Basename(proj) + " · Done", "-message", "The response has finished"})
		if argv[9] != "open -b com.apple.Terminal" {
			t.Fatalf("click: %q", argv[9])
		}
	})

	t.Run("app name comes from io.AppName and builds the group", func(t *testing.T) {
		bin := notificationFakePath(t)
		log := filepath.Join(t.TempDir(), "argv")
		notificationFakeCommand(t, bin, "terminal-notifier", log, "")
		proj := TmpDir()
		defer RmTree(proj)
		app := func(o *IoOpts) { o.AppName = "My  Codex App" }
		Notification(notificationIo(proj, "iTerm.app", app), "notify", Dict{})
		argv := notificationReadArgv(t, log)
		if argv[1] != "My  Codex App" || argv[7] != "my-codex-app-"+proj {
			t.Fatalf("title/group: %q %q", argv[1], argv[7])
		}
	})

	t.Run("payload cwd is used and the git root wins over a subdirectory", func(t *testing.T) {
		if _, err := exec.LookPath("git"); err != nil {
			t.Skip("git is not installed")
		}
		bin := notificationFakePath(t)
		log := filepath.Join(t.TempDir(), "argv")
		notificationFakeCommand(t, bin, "terminal-notifier", log, "")
		root := TmpDir()
		defer RmTree(root)
		if out, err := exec.CommandContext(t.Context(), "git", "-C", root, "init", "-q").CombinedOutput(); err != nil {
			t.Skipf("git init failed: %v %s", err, out)
		}
		sub := filepath.Join(root, "pkg", "deep")
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatal(err)
		}
		Notification(notificationIo(t.TempDir(), "iTerm.app"), "notify", Dict{"cwd": sub})
		argv := notificationReadArgv(t, log)
		if !strings.Contains(argv[3], "📁 "+Basename(root)+" · ") || argv[7] != "claude-code-"+root {
			t.Fatalf("subtitle/group: %q %q", argv[3], argv[7])
		}
	})

	t.Run("does not notify when the front window already shows the project", func(t *testing.T) {
		bin := notificationFakePath(t)
		log := filepath.Join(t.TempDir(), "argv")
		notificationFakeCommand(t, bin, "terminal-notifier", log, "")
		proj := TmpDir()
		defer RmTree(proj)
		osaLog := filepath.Join(t.TempDir(), "osa")
		notificationFakeCommand(t, bin, "osascript", osaLog, "main.go - "+Basename(proj)+" - Visual Studio Code")
		r := Notification(notificationIo(proj, "iTerm.app"), "notify", Dict{})
		if r != Ok("", "") || Exists(log) {
			t.Fatalf("got %+v, notified=%v", r, Exists(log))
		}
		got := notificationReadArgv(t, osaLog)
		if len(got) != 2 || got[0] != "-e" || got[1] != notifyFrontWindowScript {
			t.Fatalf("osascript argv: %q", got)
		}
	})

	t.Run("notifies when the front window is another project", func(t *testing.T) {
		bin := notificationFakePath(t)
		log := filepath.Join(t.TempDir(), "argv")
		notificationFakeCommand(t, bin, "terminal-notifier", log, "")
		proj := TmpDir()
		defer RmTree(proj)
		notificationFakeCommand(t, bin, "osascript", filepath.Join(t.TempDir(), "osa"), "elsewhere-window")
		Notification(notificationIo(proj, "iTerm.app"), "notify", Dict{})
		if !Exists(log) {
			t.Fatal("not notified")
		}
	})

	t.Run("vscode with a code binary on PATH focuses the window with code -r", func(t *testing.T) {
		bin := notificationFakePath(t)
		log := filepath.Join(t.TempDir(), "argv")
		notificationFakeCommand(t, bin, "terminal-notifier", log, "")
		notificationFakeCommand(t, bin, "code", filepath.Join(t.TempDir(), "code"), "")
		proj := TmpDir()
		defer RmTree(proj)
		Notification(notificationIo(proj, "vscode"), "notify", Dict{})
		argv := notificationReadArgv(t, log)
		want := ShellQuote(filepath.Join(bin, "code")) + " -r " + ShellQuote(proj)
		if argv[9] != want {
			t.Fatalf("click: %q want %q", argv[9], want)
		}
	})

	t.Run("vscode without code falls back to open -b with the real bundle id", func(t *testing.T) {
		if _, err := os.Stat("/usr/local/bin/code"); err == nil {
			t.Skip("/usr/local/bin/code exists on this machine")
		}
		bin := notificationFakePath(t)
		log := filepath.Join(t.TempDir(), "argv")
		notificationFakeCommand(t, bin, "terminal-notifier", log, "")
		proj := TmpDir()
		defer RmTree(proj)
		cursor := func(o *IoOpts) { o.Env.CFBundleID = "com.todesktop.cursor" }
		Notification(notificationIo(proj, "vscode", cursor), "notify", Dict{})
		if got := notificationReadArgv(t, log)[9]; got != "open -b com.todesktop.cursor" {
			t.Fatalf("click: %q", got)
		}
		_ = os.Remove(log)
		Notification(notificationIo(proj, "vscode"), "notify", Dict{})
		if got := notificationReadArgv(t, log)[9]; got != "open -b com.microsoft.VSCode" {
			t.Fatalf("click: %q", got)
		}
		_ = os.Remove(log)
		Notification(notificationIo(proj, ""), "notify", Dict{})
		if got := notificationReadArgv(t, log)[9]; got != "open -b com.microsoft.VSCode" {
			t.Fatalf("unknown terminal click: %q", got)
		}
	})
}

func TestNotificationGroupName(t *testing.T) {
	for in, want := range map[string]string{
		"Claude Code": "claude-code",
		"Codex":       "codex",
		"A \t B\n\nC": "a-b-c",
		"":            "",
	} {
		if got := notifyGroupName(in); got != want {
			t.Errorf("notifyGroupName(%q) = %q, want %q", in, got, want)
		}
	}
}

func notificationAssertArgv(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv:\n got %q\nwant %q", got, want)
	}
}
