//go:build windows

package runtime

import (
	"os/exec"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsProcessTreeConfigureHidesChildConsole(t *testing.T) {
	cmd := exec.Command("node.exe")
	tree := &windowsProcessTree{}

	tree.configure(cmd)

	if cmd.SysProcAttr == nil {
		t.Fatal("configure did not set SysProcAttr")
	}
	for name, flag := range map[string]uint32{
		"CREATE_NEW_PROCESS_GROUP": windows.CREATE_NEW_PROCESS_GROUP,
		"CREATE_NO_WINDOW":         windows.CREATE_NO_WINDOW,
	} {
		if cmd.SysProcAttr.CreationFlags&flag == 0 {
			t.Errorf("CreationFlags does not include %s", name)
		}
	}
}
