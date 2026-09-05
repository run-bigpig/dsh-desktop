//go:build windows

package desktop

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestLaunchDSHTerminalUsesShellExecute(t *testing.T) {
	root := t.TempDir()
	config := dshTerminalConfig{
		Node:             filepath.Join(root, "toolchain", "node.exe"),
		PNPM:             filepath.Join(root, "toolchain", "pnpm", "pnpm.exe"),
		PNPMStore:        filepath.Join(root, "pnpm-store"),
		CLI:              filepath.Join(root, "runtime", "bin.js"),
		HarnessHome:      filepath.Join(root, "harness-home"),
		WorkingDirectory: filepath.Join(root, "workspaces"),
		StateDirectory:   filepath.Join(root, "state"),
	}
	if err := os.MkdirAll(config.WorkingDirectory, 0o700); err != nil {
		t.Fatal(err)
	}

	original := openTerminal
	defer func() { openTerminal = original }()
	var file, arguments, cwd string
	var showCommand int32
	openTerminal = func(_ windows.Handle, _ *uint16, filePtr, argumentsPtr, cwdPtr *uint16, show int32) error {
		file = windows.UTF16PtrToString(filePtr)
		arguments = windows.UTF16PtrToString(argumentsPtr)
		cwd = windows.UTF16PtrToString(cwdPtr)
		showCommand = show
		return nil
	}

	if err := launchDSHTerminal(config); err != nil {
		t.Fatal(err)
	}
	if file != resolveCommandPrompt() || cwd != config.WorkingDirectory || showCommand != windows.SW_SHOWNORMAL {
		t.Fatalf("unexpected ShellExecute call: file=%q arguments=%q cwd=%q show=%d", file, arguments, cwd, showCommand)
	}
	bootstrap := filepath.Join(config.StateDirectory, "terminal-bin", "open-dsh.cmd")
	if arguments != `/d /k call "`+bootstrap+`"` {
		t.Fatalf("unexpected terminal arguments: %q", arguments)
	}
	contents, err := os.ReadFile(bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		`set "DSH_HOME=` + config.HarnessHome + `"`,
		`set "STARWEAVE_DESIGN_STATE_DIR=` + config.StateDirectory + `"`,
		`set "DSH_DESKTOP_NODE=` + config.Node + `"`,
		`set "DSH_DESKTOP_CLI=` + config.CLI + `"`,
		`set "PNPM_HOME=` + filepath.Dir(config.PNPM) + `"`,
		`set "PNPM_CONFIG_STORE_DIR=` + config.PNPMStore + `"`,
		`set "PATH=` + filepath.Join(config.StateDirectory, "terminal-bin") + `;` + filepath.Dir(config.Node) + `;` + filepath.Dir(config.PNPM) + `;%PATH%"`,
		`cd /d "` + config.WorkingDirectory + `"`,
		"title DeepSeek Harness dsh",
	} {
		if !strings.Contains(string(contents), expected) {
			t.Errorf("bootstrap missing %q:\n%s", expected, contents)
		}
	}
}

func TestTerminalBootstrapEscapesPercent(t *testing.T) {
	config := dshTerminalConfig{
		Node:             `C:\tool%set%\node.exe`,
		PNPM:             `C:\tool%set%\pnpm\pnpm.exe`,
		PNPMStore:        `C:\home%set%\pnpm-store`,
		CLI:              `C:\runtime\bin.js`,
		HarnessHome:      `C:\home`,
		WorkingDirectory: `C:\workspace`,
	}
	contents, err := terminalBootstrap(config, `C:\state\terminal-bin`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(contents, `C:\tool%%set%%\node.exe`) {
		t.Fatalf("percent signs were not escaped:\n%s", contents)
	}
	if !strings.Contains(contents, `C:\home%%set%%\pnpm-store`) {
		t.Fatalf("store percent signs were not escaped:\n%s", contents)
	}
}
