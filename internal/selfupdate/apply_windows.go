//go:build windows

package selfupdate

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"golang.org/x/sys/windows"
)

const helperMode = "--apply-desktop-update"

const parentExitTimeout = 60 * time.Second

func StartApplyHelper(installer, logsDir string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	helper := filepath.Join(filepath.Dir(installer), "desktop-update-helper.exe")
	if err := copyFile(executable, helper); err != nil {
		return err
	}
	command := exec.Command(helper, helperMode,
		"--parent-pid", strconv.Itoa(os.Getpid()),
		"--installer", installer,
		"--target", executable,
		"--log", filepath.Join(logsDir, "update-helper.log"),
	)
	command.SysProcAttr = &windows.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

func HandleHelperMode(args []string) (bool, error) {
	if len(args) == 0 || args[0] != helperMode {
		return false, nil
	}
	flags := flag.NewFlagSet("desktop-update-helper", flag.ContinueOnError)
	parentPID := flags.Uint("parent-pid", 0, "parent process ID")
	installer := flags.String("installer", "", "installer path")
	target := flags.String("target", "", "installed executable path")
	logPath := flags.String("log", "", "helper log path")
	if err := flags.Parse(args[1:]); err != nil {
		return true, err
	}
	if *parentPID == 0 || *installer == "" || *target == "" {
		return true, fmt.Errorf("desktop update helper arguments are incomplete")
	}
	var output io.Writer = io.Discard
	if *logPath != "" {
		if err := os.MkdirAll(filepath.Dir(*logPath), 0o700); err == nil {
			if file, err := os.OpenFile(*logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
				defer file.Close()
				output = file
			}
		}
	}
	fmt.Fprintf(output, "waiting for desktop process %d to exit\n", *parentPID)
	if err := waitForProcess(uint32(*parentPID)); err != nil {
		fmt.Fprintf(output, "desktop process wait failed: %v\n", err)
		return true, err
	}
	command := exec.Command(*installer, "/S", "/UPDATE")
	command.Stdout, command.Stderr = output, output
	command.SysProcAttr = &windows.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	if err := command.Run(); err != nil {
		fmt.Fprintf(output, "installer failed: %v; restarting the existing desktop\n", err)
		if restartErr := startDesktop(*target); restartErr != nil {
			return true, fmt.Errorf("installer failed: %v; restart existing desktop: %w", err, restartErr)
		}
		return true, fmt.Errorf("installer failed: %w", err)
	}
	if err := startDesktop(*target); err != nil {
		return true, fmt.Errorf("restart updated desktop: %w", err)
	}
	return true, nil
}

func waitForProcess(pid uint32) error {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		if err == windows.ERROR_INVALID_PARAMETER {
			return nil
		}
		return err
	}
	defer windows.CloseHandle(handle)
	result, err := windows.WaitForSingleObject(handle, uint32(parentExitTimeout/time.Millisecond))
	if err != nil {
		return err
	}
	if result != windows.WAIT_OBJECT_0 {
		if result == uint32(windows.WAIT_TIMEOUT) {
			return fmt.Errorf("desktop process %d did not exit within %s", pid, parentExitTimeout)
		}
		return fmt.Errorf("unexpected wait result %d", result)
	}
	return nil
}

func startDesktop(target string) error {
	restart := exec.Command(target)
	restart.SysProcAttr = &windows.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	if err := restart.Start(); err != nil {
		return err
	}
	return restart.Process.Release()
}

func copyFile(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	_ = os.Remove(target)
	output, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}
