//go:build !windows

package hookgate

import (
	"io/fs"
	"os/exec"
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
