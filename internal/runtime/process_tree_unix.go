//go:build !windows

package runtime

import (
	"os/exec"
	"syscall"
)

type unixProcessTree struct{ pid int }
type processTree interface {
	configure(*exec.Cmd)
	afterStart(*exec.Cmd) error
	kill() error
	close() error
}

func newProcessTree() processTree { return &unixProcessTree{} }
func (t *unixProcessTree) configure(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}
func (t *unixProcessTree) afterStart(cmd *exec.Cmd) error { t.pid = cmd.Process.Pid; return nil }
func (t *unixProcessTree) kill() error {
	if t.pid == 0 {
		return nil
	}
	return syscall.Kill(-t.pid, syscall.SIGKILL)
}
func (t *unixProcessTree) close() error { return nil }
