//go:build windows

package runtime

import (
	"os/exec"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsProcessTree struct{ job windows.Handle }
type processTree interface {
	configure(*exec.Cmd)
	afterStart(*exec.Cmd) error
	kill() error
	close() error
}

func newProcessTree() processTree { return &windowsProcessTree{} }
func (t *windowsProcessTree) configure(cmd *exec.Cmd) {
	cmd.SysProcAttr = &windows.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW,
	}
}
func (t *windowsProcessTree) afterStart(cmd *exec.Cmd) error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return err
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		windows.CloseHandle(job)
		return err
	}
	defer windows.CloseHandle(process)
	if err = windows.AssignProcessToJobObject(job, process); err != nil {
		windows.CloseHandle(job)
		return err
	}
	t.job = job
	return nil
}
func (t *windowsProcessTree) kill() error {
	if t.job == 0 {
		return nil
	}
	return windows.TerminateJobObject(t.job, 1)
}
func (t *windowsProcessTree) close() error {
	if t.job == 0 {
		return nil
	}
	err := windows.CloseHandle(t.job)
	t.job = 0
	return err
}
