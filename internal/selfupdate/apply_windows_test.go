//go:build windows

package selfupdate

import "testing"

func TestHelperModeRejectsIncompleteArguments(t *testing.T) {
	handled, err := HandleHelperMode([]string{helperMode})
	if !handled {
		t.Fatal("helper mode was not detected")
	}
	if err == nil {
		t.Fatal("incomplete helper arguments were accepted")
	}
}
