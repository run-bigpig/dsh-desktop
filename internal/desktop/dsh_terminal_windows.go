//go:build windows

package desktop

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

const dshCommandShim = "@echo off\r\n@\"%DSH_DESKTOP_NODE%\" \"%DSH_DESKTOP_CLI%\" %*\r\n"

var openTerminal = windows.ShellExecute

func launchDSHTerminal(config dshTerminalConfig) error {
	binDir := filepath.Join(config.StateDirectory, "terminal-bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		return fmt.Errorf("创建 dsh 命令目录: %w", err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "dsh.cmd"), []byte(dshCommandShim), 0o600); err != nil {
		return fmt.Errorf("创建 dsh 命令入口: %w", err)
	}
	bootstrap := filepath.Join(binDir, "open-dsh.cmd")
	contents, err := terminalBootstrap(config, binDir)
	if err != nil {
		return err
	}
	if err := os.WriteFile(bootstrap, []byte(contents), 0o600); err != nil {
		return fmt.Errorf("创建 dsh 终端启动脚本: %w", err)
	}
	commandPrompt, err := windows.UTF16PtrFromString(resolveCommandPrompt())
	if err != nil {
		return fmt.Errorf("解析 Windows 终端路径: %w", err)
	}
	arguments, err := windows.UTF16PtrFromString(`/d /k call "` + bootstrap + `"`)
	if err != nil {
		return fmt.Errorf("解析 dsh 终端启动参数: %w", err)
	}
	workingDirectory, err := windows.UTF16PtrFromString(config.WorkingDirectory)
	if err != nil {
		return fmt.Errorf("解析 dsh 工作目录: %w", err)
	}
	if err := openTerminal(0, nil, commandPrompt, arguments, workingDirectory, windows.SW_SHOWNORMAL); err != nil {
		return fmt.Errorf("启动 Windows 终端: %w", err)
	}
	return nil
}

func terminalBootstrap(config dshTerminalConfig, binDir string) (string, error) {
	values := []string{config.HarnessHome, config.Node, config.CLI, binDir, filepath.Dir(config.Node), config.WorkingDirectory}
	for _, value := range values {
		if strings.ContainsAny(value, "\r\n") {
			return "", fmt.Errorf("dsh 终端路径包含不支持的换行符")
		}
	}
	escape := func(value string) string { return strings.ReplaceAll(value, "%", "%%") }
	return strings.Join([]string{
		"@echo off",
		`set "DSH_HOME=` + escape(config.HarnessHome) + `"`,
		`set "DSH_DESKTOP_NODE=` + escape(config.Node) + `"`,
		`set "DSH_DESKTOP_CLI=` + escape(config.CLI) + `"`,
		`set "PATH=` + escape(binDir) + `;` + escape(filepath.Dir(config.Node)) + `;%PATH%"`,
		`cd /d "` + escape(config.WorkingDirectory) + `"`,
		"title DeepSeek Harness dsh",
		"",
	}, "\r\n"), nil
}

func resolveCommandPrompt() string {
	if commandPrompt := os.Getenv("ComSpec"); commandPrompt != "" {
		return commandPrompt
	}
	return "cmd.exe"
}
