//go:build !windows

package marketplace

import "os/exec"

func configureCLICommand(*exec.Cmd) {}
