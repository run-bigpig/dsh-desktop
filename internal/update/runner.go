package update

import (
	"context"
	"fmt"
	"io"
	"os/exec"
)

type Command struct {
	Name   string
	Args   []string
	Dir    string
	Env    []string
	Output io.Writer
}
type Runner interface {
	Run(context.Context, Command) error
	Output(context.Context, Command) ([]byte, error)
}
type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, c Command) error {
	cmd := exec.CommandContext(ctx, c.Name, c.Args...)
	cmd.Dir, cmd.Env, cmd.Stdout, cmd.Stderr = c.Dir, c.Env, c.Output, c.Output
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w", c.Name, err)
	}
	return nil
}
func (ExecRunner) Output(ctx context.Context, c Command) ([]byte, error) {
	cmd := exec.CommandContext(ctx, c.Name, c.Args...)
	cmd.Dir, cmd.Env = c.Dir, c.Env
	b, err := cmd.CombinedOutput()
	if err != nil {
		return b, fmt.Errorf("%s: %w: %s", c.Name, err, b)
	}
	return b, nil
}
