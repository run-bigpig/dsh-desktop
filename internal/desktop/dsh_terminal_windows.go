//go:build windows

package desktop

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

const dshCommandShim = "@echo off\r\n@\"%DSH_DESKTOP_NODE%\" \"%DSH_DESKTOP_CLI%\" %*\r\n"

func launchDSHTerminal(config dshTerminalConfig) error {
	binDir := filepath.Join(config.StateDirectory, "terminal-bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		return fmt.Errorf("创建 dsh 命令目录: %w", err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "dsh.cmd"), []byte(dshCommandShim), 0o600); err != nil {
		return fmt.Errorf("创建 dsh 命令入口: %w", err)
	}
	command := exec.Command(resolveCommandPrompt(), "/d", "/k", "title DeepSeek Harness dsh")
	command.Dir = config.WorkingDirectory
	command.Env = append(os.Environ(),
		"DSH_HOME="+config.HarnessHome,
		"DSH_DESKTOP_NODE="+config.Node,
		"DSH_DESKTOP_CLI="+config.CLI,
		"PATH="+strings.Join([]string{binDir, filepath.Dir(config.Node), os.Getenv("PATH")}, string(os.PathListSeparator)),
	)
	command.SysProcAttr = &windows.SysProcAttr{CreationFlags: windows.CREATE_NEW_CONSOLE}
	if err := command.Start(); err != nil {
		return fmt.Errorf("启动 Windows 终端: %w", err)
	}
	_ = command.Process.Release()
	return nil
}

func resolveCommandPrompt() string {
	if commandPrompt := os.Getenv("ComSpec"); commandPrompt != "" {
		return commandPrompt
	}
	return "cmd.exe"
}
