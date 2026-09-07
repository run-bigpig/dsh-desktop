//go:build !windows

package browser

import (
	"context"
	"errors"
	"unsafe"
)

type Manager struct{}

func New(_ string, _ string, _ func() unsafe.Pointer) *Manager { return &Manager{} }
func (*Manager) Execute(context.Context, Command) (any, error) {
	return nil, errors.New("native browser currently requires Windows")
}
func (*Manager) Reset() {}
