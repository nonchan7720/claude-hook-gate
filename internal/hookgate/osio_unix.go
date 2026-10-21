//go:build !windows

package hookgate

import (
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
)

// setProcessGroup は子を独立したプロセスグループにする（タイムアウトで子孫ごと止めるため）。
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup はグループ全体を SIGKILL する。
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		_ = cmd.Process.Kill()
	}
}

// canExecute は access(path, X_OK) 相当。
func canExecute(path string, _ fs.FileInfo) bool {
	return syscall.Access(path, 1) == nil
}

// removeEmptyDir は空のディレクトリだけ消す（rmdir）。消せなければ黙って何もしない。
func removeEmptyDir(path string) {
	_ = syscall.Rmdir(path)
}

// forwardedSignals は、hook のプロセスが受けたら走っている子のグループを道連れにするシグナル
// （Claude Code 側の timeout や中断）。
var forwardedSignals = []os.Signal{syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP}

// 子はそれぞれ独立したプロセスグループで走る（タイムアウトで子孫ごと止めるため）ので、hook のプロセス自体が
// SIGTERM などで止められると、そのままでは子孫が残る。実行中のグループ（リーダーの PID）を控え、最初の子が
// 始まるときに signal.Notify し、最後の子が終わったら止める。
var (
	groupsMu     sync.Mutex
	activeGroups = map[int]struct{}{}
	notifier     *signalForwarder
)

type signalForwarder struct {
	ch   chan os.Signal
	done chan struct{}
}

func trackGroup(pid int) {
	groupsMu.Lock()
	defer groupsMu.Unlock()
	if len(activeGroups) == 0 && notifier == nil {
		f := &signalForwarder{ch: make(chan os.Signal, 1), done: make(chan struct{})}
		signal.Notify(f.ch, forwardedSignals...)
		notifier = f
		go f.watch()
	}
	activeGroups[pid] = struct{}{}
}

func untrackGroup(pid int) {
	groupsMu.Lock()
	defer groupsMu.Unlock()
	delete(activeGroups, pid)
	if len(activeGroups) == 0 {
		stopNotifier()
	}
}

// stopNotifier は groupsMu を持った状態で呼ぶ。
func stopNotifier() {
	if notifier == nil {
		return
	}
	signal.Stop(notifier.ch)
	close(notifier.done)
	notifier = nil
}

func (f *signalForwarder) watch() {
	select {
	case sig := <-f.ch:
		forwardSignal(f, sig)
	case <-f.done:
	}
}

// forwardSignal は走っているグループをすべて SIGKILL し、同じシグナルで自分も終わる
// （Node 版の process.kill(process.pid, signal) と同じ）。
func forwardSignal(f *signalForwarder, sig os.Signal) {
	groupsMu.Lock()
	for pid := range activeGroups {
		_ = syscall.Kill(-pid, syscall.SIGKILL) // すでに終わっていればエラーだが構わない
	}
	clear(activeGroups)
	if notifier == f {
		stopNotifier()
	}
	groupsMu.Unlock()
	signal.Reset(forwardedSignals...)
	if s, ok := sig.(syscall.Signal); ok {
		_ = syscall.Kill(os.Getpid(), s)
	}
}
