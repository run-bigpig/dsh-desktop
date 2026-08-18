//go:build !windows

package selfupdate

import "fmt"

func StartApplyHelper(string, string) error {
	return fmt.Errorf("desktop self-update is not yet supported on this platform")
}

func HandleHelperMode([]string) (bool, error) { return false, nil }
