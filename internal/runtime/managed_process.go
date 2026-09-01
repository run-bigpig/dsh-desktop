package runtime

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
)

// ManagedProcess owns exactly one process tree started by the desktop.
type ManagedProcess struct {
	mu   sync.Mutex
	cmd  *exec.Cmd
	tree processTree
	done chan struct{}
}

func (p *ManagedProcess) Start(executable string, args []string, dir string, log io.Writer) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd != nil {
		return 0, fmt.Errorf("managed process is already running")
	}
	cmd := exec.Command(executable, args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	if log != nil {
		cmd.Stdout = log
		cmd.Stderr = log
	}
	tree := newProcessTree()
	tree.configure(cmd)
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	if err := tree.afterStart(cmd); err != nil {
		_ = cmd.Process.Kill()
		return 0, fmt.Errorf("attach managed process tree: %w", err)
	}
	done := make(chan struct{})
	p.cmd, p.tree, p.done = cmd, tree, done
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	return cmd.Process.Pid, nil
}

func (p *ManagedProcess) Done() <-chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.done
}

func (p *ManagedProcess) Kill() error {
	p.mu.Lock()
	tree := p.tree
	p.mu.Unlock()
	if tree == nil {
		return nil
	}
	return tree.kill()
}

func (p *ManagedProcess) Close() error {
	p.mu.Lock()
	tree := p.tree
	p.cmd, p.tree, p.done = nil, nil, nil
	p.mu.Unlock()
	if tree == nil {
		return nil
	}
	return tree.close()
}
