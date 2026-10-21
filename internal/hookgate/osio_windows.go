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
