//go:build !windows

package desktop

import "fmt"

func launchDSHTerminal(dshTerminalConfig) error {
	return fmt.Errorf("当前版本仅支持在 Windows 上打开 dsh 终端")
}
