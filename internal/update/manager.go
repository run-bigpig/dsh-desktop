package update

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/deepseek-ai/deepseek-harness-desktop/internal/appconfig"
	harnessruntime "github.com/deepseek-ai/deepseek-harness-desktop/internal/runtime"
	"github.com/deepseek-ai/deepseek-harness-desktop/internal/state"
)

type Toolchain struct{ Git, Node, PNPM, NodeVersion, PNPMVersion string }
type Progress func(state.Phase, string)
type Manager struct {
	paths    appconfig.Paths
	cfg      appconfig.Config
	store    *state.Store
	tools    Toolchain
	runner   Runner
	log      io.Writer
	progress Progress
}

func New(paths appconfig.Paths, cfg appconfig.Config, store *state.Store, tools Toolchain, runner Runner, log io.Writer, progress Progress) *Manager {
	if runner == nil {
		runner = ExecRunner{}
	}
	if progress == nil {
		progress = func(state.Phase, string) {}
	}
	return &Manager{paths: paths, cfg: cfg, store: store, tools: tools, runner: runner, log: log, progress: progress}
}

func (m *Manager) Check(ctx context.Context) (string, error) {
	m.set(state.Checking, "正在解析官方 master 分支")
	remote, ref := m.cfg.RemoteAndRef()
	if err := m.ensureRepository(ctx, remote); err != nil {
		return "", m.fail(err)
	}
	if err := m.run(ctx, m.tools.Git, []string{"--git-dir", m.paths.Repository, "fetch", "--prune", "origin", ref}, ""); err != nil {
		return "", m.fail(err)
	}
	b, err := m.output(ctx, m.tools.Git, []string{"--git-dir", m.paths.Repository, "rev-parse", "FETCH_HEAD^{commit}"}, "")
	if err != nil {
		return "", m.fail(err)
	}
	commit := strings.TrimSpace(string(b))
	if !appconfig.ValidCommit(commit) {
		return "", m.fail(fmt.Errorf("remote resolved to invalid commit %q", commit))
	}
	return commit, nil
}

func (m *Manager) Prepare(ctx context.Context, confirmed bool) (*state.PendingState, error) {
	if !confirmed {
		return nil, fmt.Errorf("unsigned master update requires explicit confirmation")
	}
	commit, err := m.Check(ctx)
	if err != nil {
		return nil, err
	}
	if snap := m.store.Snapshot(); snap.Active != nil && snap.Active.Current.Commit == commit {
		return nil, fmt.Errorf("commit %s is already active", commit)
	}
	finalDir, _ := m.paths.Runtime(commit)
	if _, err := os.Stat(finalDir); err == nil {
		pending := m.pending(commit)
		if err := m.store.SavePending(pending); err != nil {
			return nil, err
		}
		return &pending, nil
	}
	m.set(state.Building, "正在隔离构建 "+commit[:12])
	_ = m.run(context.Background(), m.tools.Git, []string{"--git-dir", m.paths.Repository, "worktree", "prune"}, "")
	stage := filepath.Join(m.paths.Versions, ".staging-"+commit)
	if !appconfig.IsOwnedPath(m.paths.Versions, stage) {
		return nil, m.fail(fmt.Errorf("unsafe staging path"))
	}
	_ = os.RemoveAll(stage)
	defer func() { _ = os.RemoveAll(stage) }()
	if err := m.run(ctx, m.tools.Git, []string{"--git-dir", m.paths.Repository, "worktree", "add", "--detach", stage, commit}, ""); err != nil {
		return nil, m.fail(err)
	}
	defer func() {
		_ = m.run(context.Background(), m.tools.Git, []string{"--git-dir", m.paths.Repository, "worktree", "remove", "--force", stage}, "")
	}()
	if err := ValidateToolchain(filepath.Join(stage, "package.json"), m.tools.NodeVersion, m.tools.PNPMVersion); err != nil {
		return nil, m.fail(err)
	}
	env := m.buildEnv()
	if err := m.runEnv(ctx, m.tools.PNPM, []string{"install", "--frozen-lockfile", "--store-dir", m.paths.PNPMStore}, stage, env); err != nil {
		return nil, m.fail(fmt.Errorf("frozen install failed: %w", err))
	}
	if err := m.runEnv(ctx, m.tools.PNPM, []string{"run", "build"}, stage, env); err != nil {
		return nil, m.fail(fmt.Errorf("build failed: %w", err))
	}
	if err := m.smoke(ctx, stage, commit); err != nil {
		return nil, m.fail(err)
	}
	if err := os.Remove(filepath.Join(stage, ".git")); err != nil {
		return nil, m.fail(fmt.Errorf("detach built runtime metadata: %w", err))
	}
	if err := os.Rename(stage, finalDir); err != nil {
		return nil, m.fail(fmt.Errorf("publish immutable runtime: %w", err))
	}
	pending := m.pending(commit)
	if err := m.store.SavePending(pending); err != nil {
		return nil, m.fail(err)
	}
	m.set(state.Pending, "更新已构建，将在下次启动激活")
	return &pending, nil
}

func (m *Manager) ensureRepository(ctx context.Context, remote string) error {
	if _, err := os.Stat(m.paths.Repository); os.IsNotExist(err) {
		return m.run(ctx, m.tools.Git, []string{"clone", "--mirror", remote, m.paths.Repository}, "")
	}
	if err := m.run(ctx, m.tools.Git, []string{"--git-dir", m.paths.Repository, "remote", "set-url", "origin", remote}, ""); err != nil {
		return err
	}
	return nil
}

func (m *Manager) smoke(ctx context.Context, stage, commit string) error {
	home := filepath.Join(m.paths.State, "smoke-"+commit)
	_ = os.RemoveAll(home)
	defer os.RemoveAll(home)
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	p := harnessruntime.NewProcess(harnessruntime.LaunchConfig{Node: m.tools.Node, ChildControl: m.paths.ChildControl, RuntimeDir: stage, HarnessHome: home, WorkingDir: m.paths.Workspaces, StartupTimeout: 30 * time.Second, ShutdownTimeout: 10 * time.Second, Environment: m.buildEnv(), CleanEnvironment: true}, m.store, m.log)
	if _, err := p.Start(ctx); err != nil {
		return fmt.Errorf("isolated smoke start failed: %w", err)
	}
	if err := p.Stop(ctx); err != nil {
		return fmt.Errorf("isolated smoke shutdown failed: %w", err)
	}
	return nil
}

func (m *Manager) pending(commit string) state.PendingState {
	remote, ref := m.cfg.RemoteAndRef()
	return state.PendingState{RuntimeRef: state.RuntimeRef{Commit: commit}, Remote: remote, Ref: ref, SignatureVerified: false, BuiltAt: time.Now().UTC()}
}
func (m *Manager) set(p state.Phase, msg string) {
	m.store.SetRuntimeInfo(p, msg, "")
	m.progress(p, msg)
}
func (m *Manager) fail(err error) error { m.set(state.Failed, err.Error()); return err }
func (m *Manager) run(ctx context.Context, name string, args []string, dir string) error {
	return m.runner.Run(ctx, Command{Name: name, Args: args, Dir: dir, Env: m.buildEnv(), Output: m.log})
}
func (m *Manager) runEnv(ctx context.Context, name string, args []string, dir string, env []string) error {
	return m.runner.Run(ctx, Command{Name: name, Args: args, Dir: dir, Env: env, Output: m.log})
}
func (m *Manager) output(ctx context.Context, name string, args []string, dir string) ([]byte, error) {
	return m.runner.Output(ctx, Command{Name: name, Args: args, Dir: dir, Env: m.buildEnv()})
}

func (m *Manager) buildEnv() []string {
	allowed := map[string]bool{"SystemRoot": true, "WINDIR": true, "COMSPEC": true, "PATHEXT": true, "TEMP": true, "TMP": true, "TMPDIR": true, "LANG": true, "LC_ALL": true, "NUMBER_OF_PROCESSORS": true, "PROCESSOR_ARCHITECTURE": true}
	var env []string
	for _, item := range os.Environ() {
		key, _, ok := strings.Cut(item, "=")
		if ok && allowed[key] {
			env = append(env, item)
		}
	}
	binDirs := []string{filepath.Dir(m.tools.Node), filepath.Dir(m.tools.PNPM), filepath.Dir(m.tools.Git)}
	sep := string(os.PathListSeparator)
	buildHome := filepath.Join(m.paths.State, "build-home")
	_ = os.MkdirAll(buildHome, 0o700)
	env = append(env, "PATH="+strings.Join(binDirs, sep), "HOME="+buildHome, "USERPROFILE="+buildHome, "PNPM_HOME="+filepath.Dir(m.tools.PNPM), "NPM_CONFIG_USERCONFIG="+filepath.Join(buildHome, ".npmrc"), "NPM_CONFIG_UPDATE_NOTIFIER=false", "CI=1", "GIT_TERMINAL_PROMPT=0")
	if runtime.GOOS != "windows" {
		env = append(env, "SHELL=/bin/sh")
	}
	return env
}
