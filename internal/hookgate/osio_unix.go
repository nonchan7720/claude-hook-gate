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

// deathPipe は「親（hook のプロセス）の死」を子へ伝えるパイプ（canary pipe）。Codex は Esc や timeout で hook を
// SIGKILL する（プロセスグループごと）が、gate のコマンドは独立したプロセスグループなので生き残って孤児になる。
// SIGKILL は捕まえられず、Pdeathsig は macOS に無いので、パイプで検知する: 読み口を子の fd 3 に渡し、書き口は親だけが
// 持つ。親が死ぬとカーネルが書き口を閉じ、子の見張り（deathWatchSnippet）が EOF を読んでグループを殺す。
// 正常終了のときは finish が "x\n" を書いてから閉じるので、見張りは何も殺さずに終わる。
// os.Pipe は O_CLOEXEC なので、ExtraFiles に渡した子以外には継がれない（ExtraFiles は子の側でだけ CLOEXEC が外れる）。
type deathPipe struct {
	r, w *os.File
}

// attachDeathPipe は cmd の fd 3 に読み口を渡す。パイプを作れなければ nil（見張りは fd 3 を読めず、何も殺さない）。
func attachDeathPipe(cmd *exec.Cmd) *deathPipe {
	r, w, err := os.Pipe()
	if err != nil {
		return nil
	}
	cmd.ExtraFiles = []*os.File{r}
	return &deathPipe{r: r, w: w}
}

// started は子の起動後に、親が持つ読み口を閉じる。
func (d *deathPipe) started() {
	if d != nil {
		_ = d.r.Close()
	}
}

// finish は正常終了の合図（"x\n"）を書いて書き口を閉じる。
func (d *deathPipe) finish() {
	if d != nil {
		_, _ = d.w.WriteString("x\n")
		_ = d.w.Close()
	}
}

// abort は起動に失敗したときに両端を閉じる。
func (d *deathPipe) abort() {
	if d != nil {
		_ = d.r.Close()
		_ = d.w.Close()
	}
}

// deathWatchSnippet は RunCmd のシェルスクリプトの先頭に置く見張り。バックグラウンドのサブシェルが fd 3（deathPipe の読み口）を
// 読み、EOF（"x\n" が来ないまま親が死んだ）ならプロセスグループ全体を SIGKILL する。
//   - サブシェル内の $$ は親の sh の PID（POSIX）。親の sh は Setpgid でグループリーダーなので -$$ がグループ全体を指す。
//   - `kill -s KILL -- -$$` は dash でも macOS の sh（bash 3.2 の sh モード）でも動く。`kill -9 -$$` は dash では動くが、
//     bash の組み込みの kill は `-9 -PID` の解釈が実装ごとに違うため、シグナル名と `--` で曖昧さを無くした。
//   - サブシェルの stdout / stderr は /dev/null: パイプを握ると cmd.WaitDelay の判定が毎回 exitGrace だけ遅くなる。
//   - 親の sh は `exec 3<&-` で fd 3 を閉じる。コマンドとその孫に canary を継がせない（継ぐと親が死んでも EOF にならない）。
const deathWatchSnippet = "( exec 0<&3 3<&- >/dev/null 2>&1; read -r _ && exit 0; kill -s KILL -- -$$ ) & exec 3<&-; "

// deathWatch は見張りのスニペット（unix）。
func deathWatch() string { return deathWatchSnippet }
