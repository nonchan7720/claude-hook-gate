//go:build windows

package hookgate

import (
	"io/fs"
	"os/exec"
	"syscall"
)

// Windows にはプロセスグループの SIGKILL が無いので、そのプロセスだけを止める。
func setProcessGroup(*exec.Cmd) {}

func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func canExecute(_ string, fi fs.FileInfo) bool { return fi.Mode().IsRegular() }

func removeEmptyDir(path string) {
	_ = syscall.Rmdir(path)
}

// Windows にはプロセスグループもシグナルの転送も無いので、何もしない。
func trackGroup(int) {}

func untrackGroup(int) {}

// Windows には ExtraFiles もプロセスグループの SIGKILL も無いので、親の死を子へ伝える仕組みは何もしない。
type deathPipe struct{}

func attachDeathPipe(*exec.Cmd) *deathPipe { return nil }

func (*deathPipe) started() {}

func (*deathPipe) finish() {}

func (*deathPipe) abort() {}

func deathWatch() string { return "" }
