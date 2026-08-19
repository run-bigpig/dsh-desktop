//go:build !windows

package plugin

import "os/exec"

func configureCLICommand(*exec.Cmd) {}
