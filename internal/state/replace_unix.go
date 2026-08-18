//go:build !windows

package state

import "os"

func atomicReplace(source, target string) error { return os.Rename(source, target) }
