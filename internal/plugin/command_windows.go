//go:build windows

package plugin

import (
	"os/exec"

	"golang.org/x/sys/windows"
)

func configureCLICommand(command *exec.Cmd) {
	command.SysProcAttr = &windows.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
}
