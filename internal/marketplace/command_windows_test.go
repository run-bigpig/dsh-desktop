//go:build windows

package marketplace

import (
	"os/exec"
	"testing"

	"golang.org/x/sys/windows"
)

func TestConfigureCLICommandHidesWindowsConsole(t *testing.T) {
	command := exec.Command("node.exe")
	configureCLICommand(command)
	if command.SysProcAttr == nil || command.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatal("Marketplace CLI command does not hide its Windows console")
	}
}
