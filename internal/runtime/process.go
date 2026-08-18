package runtime

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/deepseek-ai/deepseek-harness-desktop/internal/state"
)

type LaunchConfig struct {
	Node, ChildControl, RuntimeDir, HarnessHome, WorkingDir string
	StartupTimeout, ShutdownTimeout                         time.Duration
	Environment                                             []string
	CleanEnvironment                                        bool
	OnUnexpectedExit                                        func(error)
}

type Process struct {
	mu       sync.Mutex
	cfg      LaunchConfig
	store    *state.Store
	log      io.Writer
	client   *http.Client
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	tree     processTree
	done     chan struct{}
	waitErr  error
	url      string
	stopping bool
}

func NewProcess(cfg LaunchConfig, store *state.Store, logWriter io.Writer) *Process {
	return &Process{cfg: cfg, store: store, log: logWriter, client: &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (p *Process) URL() string { p.mu.Lock(); defer p.mu.Unlock(); return p.url }

func (p *Process) Start(ctx context.Context) (string, error) {
	p.mu.Lock()
	if p.cmd != nil {
		p.mu.Unlock()
		return "", fmt.Errorf("Harness is already running")
	}
	p.store.SetRuntimeInfo(state.Starting, "正在启动隔离的 Harness 运行时", "")
	cli := filepath.Join(p.cfg.RuntimeDir, "apps", "cli", "lib", "bin.js")
	if _, err := os.Stat(cli); err != nil {
		p.mu.Unlock()
		return "", fmt.Errorf("Harness CLI not found at %s: %w", cli, err)
	}
	controlImport, err := nodeImportSpecifier(p.cfg.ChildControl)
	if err != nil {
		p.mu.Unlock()
		return "", fmt.Errorf("resolve child-control module: %w", err)
	}
	cmd := exec.Command(p.cfg.Node, "--import", controlImport, cli, "--profile", "web", "--host", "127.0.0.1", "--port", "0")
	cmd.Dir = p.cfg.WorkingDir
	if p.cfg.CleanEnvironment {
		cmd.Env = append([]string(nil), p.cfg.Environment...)
	} else {
		cmd.Env = append(os.Environ(), p.cfg.Environment...)
	}
	cmd.Env = append(cmd.Env, "DSH_HOME="+p.cfg.HarnessHome)
	tree := newProcessTree()
	tree.configure(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		p.mu.Unlock()
		return "", err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		p.mu.Unlock()
		return "", err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		p.mu.Unlock()
		return "", err
	}
	if err := cmd.Start(); err != nil {
		p.mu.Unlock()
		return "", fmt.Errorf("start Harness: %w", err)
	}
	if err := tree.afterStart(cmd); err != nil {
		_ = cmd.Process.Kill()
		p.mu.Unlock()
		return "", fmt.Errorf("attach process tree: %w", err)
	}
	done := make(chan struct{})
	p.cmd, p.stdin, p.tree, p.done = cmd, stdin, tree, done
	p.mu.Unlock()
	go func() {
		err := cmd.Wait()
		p.mu.Lock()
		p.waitErr = err
		p.mu.Unlock()
		close(done)
	}()
	ready := make(chan string, 1)
	var scans sync.WaitGroup
	scans.Add(2)
	go p.scan(stdout, ready, &scans)
	go p.scan(stderr, ready, &scans)
	go func() { scans.Wait() }()
	timer := time.NewTimer(p.cfg.StartupTimeout)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = p.Stop(context.Background())
			return "", ctx.Err()
		case <-done:
			p.mu.Lock()
			err := p.waitErr
			p.mu.Unlock()
			p.clear()
			if err == nil {
				err = errors.New("Harness exited before becoming ready")
			}
			p.store.SetRuntimeInfo(state.Failed, err.Error(), "")
			return "", err
		case <-timer.C:
			_ = p.Stop(context.Background())
			err := fmt.Errorf("Harness startup timed out after %s", p.cfg.StartupTimeout)
			p.store.SetRuntimeInfo(state.Failed, err.Error(), "")
			return "", err
		case raw := <-ready:
			if err := ProbeBootManifest(p.client, raw, minDuration(8*time.Second, p.cfg.StartupTimeout)); err != nil {
				_ = p.Stop(context.Background())
				p.store.SetRuntimeInfo(state.Failed, err.Error(), "")
				return "", err
			}
			p.mu.Lock()
			p.url = raw
			p.mu.Unlock()
			p.store.SetRuntimeInfo(state.Ready, "Harness 已就绪", raw)
			go p.monitor(cmd, done, tree)
			return raw, nil
		}
	}
}

func nodeImportSpecifier(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	slash := filepath.ToSlash(abs)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	return (&url.URL{Scheme: "file", Path: slash}).String(), nil
}

func (p *Process) scan(r io.Reader, ready chan<- string, wg *sync.WaitGroup) {
	defer wg.Done()
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 64*1024), 1024*1024)
	for s.Scan() {
		line := s.Text()
		if p.log != nil {
			_, _ = fmt.Fprintln(p.log, line)
		}
		if raw, ok := ParseReadyLine(line); ok {
			select {
			case ready <- raw:
			default:
			}
		}
	}
}

func (p *Process) Stop(ctx context.Context) error {
	p.mu.Lock()
	if p.cmd == nil {
		p.mu.Unlock()
		return nil
	}
	stdin, done, tree := p.stdin, p.done, p.tree
	p.stopping = true
	if stdin != nil {
		_, _ = io.WriteString(stdin, `{"type":"shutdown","source":"desktop"}`+"\n")
		_ = stdin.Close()
		p.stdin = nil
	}
	p.mu.Unlock()
	timer := time.NewTimer(p.cfg.ShutdownTimeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		_ = tree.kill()
		<-done
	case <-timer.C:
		_ = tree.kill()
		<-done
	case <-done:
	}
	p.clear()
	return tree.close()
}

func (p *Process) monitor(cmd *exec.Cmd, done <-chan struct{}, tree processTree) {
	<-done
	p.mu.Lock()
	if p.cmd != cmd || p.stopping {
		p.mu.Unlock()
		return
	}
	err := p.waitErr
	p.cmd, p.stdin, p.tree, p.done, p.waitErr, p.url = nil, nil, nil, nil, nil, ""
	p.mu.Unlock()
	_ = tree.close()
	if err == nil {
		err = errors.New("Harness exited unexpectedly")
	}
	p.store.SetRuntimeInfo(state.Failed, err.Error(), "")
	if p.cfg.OnUnexpectedExit != nil {
		p.cfg.OnUnexpectedExit(err)
	}
}

func (p *Process) clear() {
	p.mu.Lock()
	p.cmd, p.stdin, p.tree, p.done, p.waitErr, p.url, p.stopping = nil, nil, nil, nil, nil, "", false
	p.mu.Unlock()
}
func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
