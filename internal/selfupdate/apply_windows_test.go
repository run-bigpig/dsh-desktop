//go:build windows

package selfupdate

import (
	"io"
	"strings"
	"testing"
)

func TestHelperModeRejectsIncompleteArguments(t *testing.T) {
	handled, err := HandleHelperMode([]string{helperMode})
	if !handled {
		t.Fatal("helper mode was not detected")
	}
	if err == nil {
		t.Fatal("incomplete helper arguments were accepted")
	}
}

func TestInstallerCommandShowsUpdateProgress(t *testing.T) {
	command := newInstallerCommand(`C:\updates\StarWeaveInstaller.exe`, io.Discard)
	if len(command.Args) != 2 || command.Args[1] != "/UPDATE" {
		t.Fatalf("installer arguments = %#v", command.Args)
	}
	for _, argument := range command.Args[1:] {
		if strings.EqualFold(argument, "/S") {
			t.Fatal("desktop update installer must not run silently")
		}
	}
	if command.SysProcAttr != nil {
		t.Fatal("desktop update installer must be allowed to show its progress window")
	}
}
