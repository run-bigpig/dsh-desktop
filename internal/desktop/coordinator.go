package desktop

import (
	"context"
	"crypto/ed25519"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/backup"
	"github.com/run-bigpig/dsh-desktop/internal/buildinfo"
	"github.com/run-bigpig/dsh-desktop/internal/openpencil"
	"github.com/run-bigpig/dsh-desktop/internal/plugin"
	harnessruntime "github.com/run-bigpig/dsh-desktop/internal/runtime"
	"github.com/run-bigpig/dsh-desktop/internal/seed"
	"github.com/run-bigpig/dsh-desktop/internal/selfupdate"
	"github.com/run-bigpig/dsh-desktop/internal/state"
	"github.com/run-bigpig/dsh-desktop/internal/update"
	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed child-control.mjs
var childControl []byte

type Coordinator struct {
	mu           sync.Mutex
	paths        appconfig.Paths
	cfg          appconfig.Config
	store        *state.Store
	backups      *backup.Manager
	appUpdates   *selfupdate.Manager
	plugins      *plugin.Manager
	pluginBridge *plugin.Bridge
	openPencil   *openpencil.Manager
	window       *windowController
	tools        update.Toolchain
	log          io.Writer
	process      *harnessruntime.Process
	busy         bool
	onReady      func(string)
	onRecovery   func()
}

func NewCoordinator(root string, logWriter io.Writer) (*Coordinator, error) {
	paths := appconfig.NewPaths(root)
	if err := paths.Ensure(); err != nil {
		return nil, err
	}
	if err := os.WriteFile(paths.ChildControl, childControl, 0o600); err != nil {
		return nil, err
	}
	cfg, err := appconfig.LoadConfig(paths)
	if err != nil {
		return nil, err
	}
	store := state.NewStore(paths.State)
	store.SetContext(paths.Root, paths.Logs, cfg.DeveloperMode)
	store.SetDesktopVersion(buildinfo.Version)
	if err := store.Load(); err != nil {
		return nil, err
	}
	tools, err := ResolveToolchain(paths)
	if err != nil {
		store.SetRuntimeInfo(state.Failed, err.Error(), "")
	}
	c := &Coordinator{paths: paths, cfg: cfg, store: store, backups: backup.New(paths), tools: tools, log: logWriter, window: &windowController{}}
	discoveryPath, err := openpencil.DefaultDiscoveryPath()
	if err != nil {
		return nil, fmt.Errorf("resolve OpenPencil discovery path: %w", err)
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve desktop executable: %w", err)
	}
	c.openPencil = openpencil.New(openpencil.Options{
		BinaryPath:    filepath.Join(filepath.Dir(executable), "resources", "openpencil", "openpencil-desktop.exe"),
		DiscoveryPath: discoveryPath,
		LaunchArgs:    []string{"--live-mcp=0"},
		Log:           logWriter,
	})
	c.appUpdates = selfupdate.New(paths, store, buildinfo.Version, buildinfo.ReleaseAPIURL, nil)
	catalogKey, err := base64.StdEncoding.DecodeString(buildinfo.MarketplaceCatalogPublicKey)
	if err != nil || len(catalogKey) != ed25519.PublicKeySize {
		return nil, errors.New("invalid Marketplace catalog public key in build configuration")
	}
	plugins, err := plugin.New(plugin.Options{
		Paths: paths, Tools: tools, Log: logWriter,
		CatalogURL: buildinfo.MarketplaceCatalogURL, CatalogSignatureURL: buildinfo.MarketplaceCatalogSignatureURL,
		TrustedCatalogKey: ed25519.PublicKey(catalogKey),
	})
	if err != nil {
		return nil, err
	}
	bridge, err := plugin.StartBridge(plugins)
	if err != nil {
		return nil, err
	}
	c.plugins, c.pluginBridge = plugins, bridge
	bridge.SetDesktopController(c.window)
	bridge.SetOpenPencilController(c.openPencil)
	plugins.SetControl(bridge.URL(), bridge.Token())
	plugins.SetLifecycle(plugin.Lifecycle{Stop: c.Stop, Start: c.Start})
	return c, nil
}

func (c *Coordinator) EnsurePrivateToolchain() error { return installBundledToolchain(c.paths) }

func (c *Coordinator) SetWindow(window *application.WebviewWindow) { c.window.SetWindow(window) }

func installBundledToolchain(paths appconfig.Paths) error {
	legacyGit := filepath.Join(paths.Toolchain, "git")
	if _, err := os.Stat(legacyGit); err == nil {
		cleanupRoot := filepath.Join(paths.Root, "cleanup")
		if os.MkdirAll(cleanupRoot, 0o700) == nil {
			stale := filepath.Join(cleanupRoot, fmt.Sprintf("toolchain-git-%d", time.Now().UnixNano()))
			if os.Rename(legacyGit, stale) == nil {
				go func() { _ = os.RemoveAll(stale) }()
			} else {
				go func() { _ = os.RemoveAll(legacyGit) }()
			}
		}
	}
	executableName := func(name string) string {
		if runtime.GOOS == "windows" {
			return name + ".exe"
		}
		return name
	}
	required := []string{
		filepath.Join(paths.Toolchain, "node", executableName("node")),
		filepath.Join(paths.Toolchain, "pnpm", executableName("pnpm")),
	}
	complete := true
	for _, path := range required {
		if _, err := os.Stat(path); err != nil {
			complete = false
			break
		}
	}
	if complete {
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	source := filepath.Join(filepath.Dir(exe), "resources", "toolchain")
	if _, err := os.Stat(source); err != nil {
		// Development builds intentionally fall back to PATH in ResolveToolchain.
		return nil
	}
	staging := paths.Toolchain + ".staging"
	_ = os.RemoveAll(staging)
	if err := copyRuntime(source, staging); err != nil {
		return fmt.Errorf("install embedded toolchain: %w", err)
	}
	_ = os.RemoveAll(paths.Toolchain)
	if err := os.Rename(staging, paths.Toolchain); err != nil {
		return fmt.Errorf("publish embedded toolchain: %w", err)
	}
	return nil
}

func (c *Coordinator) SetNavigation(ready func(string), recovery func()) {
	c.mu.Lock()
	c.onReady, c.onRecovery = ready, recovery
	c.mu.Unlock()
}
func (c *Coordinator) Store() *state.Store    { return c.store }
func (c *Coordinator) Paths() appconfig.Paths { return c.paths }

type dshTerminalConfig struct {
	Node, PNPM, PNPMStore, CLI, HarnessHome, WorkingDirectory, StateDirectory string
}

func (c *Coordinator) OpenDSHTerminal() error {
	config, err := c.dshTerminalConfig()
	if err != nil {
		return err
	}
	return launchDSHTerminal(config)
}

func (c *Coordinator) dshTerminalConfig() (dshTerminalConfig, error) {
	snapshot := c.store.Snapshot()
	if snapshot.Active == nil {
		return dshTerminalConfig{}, errors.New("Harness 运行时尚未准备好，请稍后重试")
	}
	runtimeDir, err := c.paths.Runtime(snapshot.Active.Current.Commit)
	if err != nil {
		return dshTerminalConfig{}, err
	}
	cli := filepath.Join(runtimeDir, "apps", "cli", "lib", "bin.js")
	for _, required := range []struct{ label, path string }{
		{"内置 Node", c.tools.Node},
		{"内置 pnpm", c.tools.PNPM},
		{"Harness CLI", cli},
		{"工作目录", c.cfg.WorkingDirectory},
	} {
		if _, err := os.Stat(required.path); err != nil {
			return dshTerminalConfig{}, fmt.Errorf("%s不可用: %w", required.label, err)
		}
	}
	return dshTerminalConfig{
		Node:             c.tools.Node,
		PNPM:             c.tools.PNPM,
		PNPMStore:        c.paths.PNPMStore,
		CLI:              cli,
		HarnessHome:      c.paths.HarnessHome,
		WorkingDirectory: c.cfg.WorkingDirectory,
		StateDirectory:   c.paths.State,
	}, nil
}

func ResolveToolchain(paths appconfig.Paths) (update.Toolchain, error) {
	manifest, err := seed.Load()
	if err != nil {
		return update.Toolchain{}, err
	}
	exe := func(name string) string {
		if runtime.GOOS == "windows" {
			return name + ".exe"
		}
		return name
	}
	fromRoot := func(root string) update.Toolchain {
		git := filepath.Join(root, "git", "bin", exe("git"))
		if runtime.GOOS == "windows" {
			git = filepath.Join(root, "git", "cmd", exe("git"))
		}
		if _, err := os.Stat(git); err != nil {
			git = ""
		}
		return update.Toolchain{
			Node: filepath.Join(root, "node", exe("node")),
			PNPM: filepath.Join(root, "pnpm", exe("pnpm")),
			Git:  git, NodeVersion: manifest.Node, PNPMVersion: manifest.PNPM,
		}
	}
	complete := func(tools update.Toolchain) bool {
		for _, path := range []string{tools.Node, tools.PNPM} {
			if _, err := os.Stat(path); err != nil {
				return false
			}
		}
		return true
	}
	if executable, err := os.Executable(); err == nil {
		if tools := fromRoot(filepath.Join(filepath.Dir(executable), "resources", "toolchain")); complete(tools) {
			return tools, nil
		}
	}
	if tools := fromRoot(paths.Toolchain); complete(tools) {
		return tools, nil
	}
	node, nodeErr := exec.LookPath("node")
	pnpm, pnpmErr := exec.LookPath("pnpm")
	git, _ := exec.LookPath("git")
	tools := update.Toolchain{Node: node, PNPM: pnpm, Git: git, NodeVersion: manifest.Node, PNPMVersion: manifest.PNPM}
	if nodeErr != nil || pnpmErr != nil {
		return tools, fmt.Errorf("embedded toolchain is incomplete; reinstall the desktop package")
	}
	return tools, nil
}

func (c *Coordinator) Start(ctx context.Context) error {
	c.mu.Lock()
	if c.process != nil {
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()
	activation, switchedRuntime, err := c.activateBundledRuntime()
	if err != nil {
		c.store.SetRuntimeInfo(state.Failed, err.Error(), "")
		return err
	}
	url, err := c.startActive(ctx)
	if err != nil && activation != nil {
		c.store.SetRuntimeInfo(state.Recovering, "新版本启动失败，正在自动恢复", "")
		_ = c.backups.Restore(activation.BackupID)
		_ = c.store.SaveActive(activation.Old)
		url, err = c.startActive(ctx)
	}
	if err != nil {
		c.showRecovery()
		return err
	}
	active := c.store.Snapshot().Active
	if active != nil {
		active.Current.ReadyAt = time.Now().UTC()
		_ = c.store.SaveActive(*active)
	}
	if switchedRuntime {
		_ = c.backups.Prune(5)
		_ = update.PruneVersions(c.paths, c.store.Snapshot())
	}
	go func() {
		refreshCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if refreshErr := c.plugins.RefreshCatalog(refreshCtx); refreshErr != nil && c.log != nil {
			_, _ = fmt.Fprintln(c.log, "refresh Marketplace catalog after startup:", refreshErr)
		}
	}()
	c.mu.Lock()
	ready := c.onReady
	c.mu.Unlock()
	if ready != nil {
		ready(url)
	}
	return nil
}

func (c *Coordinator) startActive(ctx context.Context) (string, error) {
	snap := c.store.Snapshot()
	if snap.Active == nil {
		return "", errors.New("no active runtime")
	}
	runtimeDir, err := c.paths.Runtime(snap.Active.Current.Commit)
	if err != nil {
		return "", err
	}
	c.plugins.SetRuntime(runtimeDir, snap.Active.Current.Commit)
	if err := c.plugins.EnsureDesktopPlugin(ctx); err != nil {
		return "", err
	}
	toolPath := strings.Join([]string{filepath.Dir(c.tools.Node), os.Getenv("PATH")}, string(os.PathListSeparator))
	p := harnessruntime.NewProcess(harnessruntime.LaunchConfig{Node: c.tools.Node, ChildControl: c.paths.ChildControl, RuntimeDir: runtimeDir, HarnessHome: c.paths.HarnessHome, WorkingDir: c.cfg.WorkingDirectory, StartupTimeout: c.cfg.StartDuration(), ShutdownTimeout: c.cfg.StopDuration(), Environment: []string{"PATH=" + toolPath, "DSH_DESKTOP_CONTROL_URL=" + c.pluginBridge.URL(), "DSH_DESKTOP_CONTROL_TOKEN=" + c.pluginBridge.Token()}, OnUnexpectedExit: func(error) { c.showRecovery() }}, c.store, c.log)
	c.mu.Lock()
	c.process = p
	c.mu.Unlock()
	url, err := p.Start(ctx)
	if err != nil {
		c.mu.Lock()
		c.process = nil
		c.mu.Unlock()
	}
	return url, err
}

func (c *Coordinator) Stop(ctx context.Context) error {
	c.mu.Lock()
	p := c.process
	c.process = nil
	c.mu.Unlock()
	if p == nil {
		return nil
	}
	return p.Stop(ctx)
}
func (c *Coordinator) Close(ctx context.Context) error {
	err := c.Stop(ctx)
	if openPencilErr := c.openPencil.Close(ctx); err == nil {
		err = openPencilErr
	}
	if bridgeErr := c.pluginBridge.Close(); err == nil {
		err = bridgeErr
	}
	return err
}
func (c *Coordinator) Restart(ctx context.Context) error {
	c.store.SetRuntimeInfo(state.Starting, "正在重启 Harness", "")
	c.showRecovery()
	if err := c.Stop(ctx); err != nil {
		return err
	}
	return c.Start(ctx)
}

type activationJournal struct {
	Old      state.ActiveState
	BackupID string
}

func (c *Coordinator) activateBundledRuntime() (*activationJournal, bool, error) {
	ref, err := c.ensureSeedRuntime()
	if err != nil {
		return nil, false, err
	}
	if c.store.Snapshot().Pending != nil {
		if err := c.store.ClearPending(); err != nil {
			return nil, false, err
		}
	}
	snap := c.store.Snapshot()
	if snap.Active == nil {
		return nil, true, c.store.SaveActive(state.ActiveState{Current: ref})
	}
	if snap.Active.Current.Commit == ref.Commit {
		return nil, false, nil
	}
	b, err := c.backups.Create("automatic pre-activation backup", snap.Active.Current.Commit)
	if err != nil {
		return nil, false, err
	}
	old := *snap.Active
	next := state.ActiveState{Current: ref, Previous: &old.Current}
	c.store.SetRuntimeInfo(state.Activating, "正在切换到桌面版本 "+buildinfo.Version+" 内置的 Harness", "")
	if err := c.store.SaveActive(next); err != nil {
		return nil, false, err
	}
	return &activationJournal{Old: old, BackupID: b.ID}, true, nil
}

func (c *Coordinator) ensureSeedRuntime() (state.RuntimeRef, error) {
	m, err := seed.Load()
	if err != nil {
		return state.RuntimeRef{}, err
	}
	target, _ := c.paths.Runtime(m.Commit)
	if _, err := os.Stat(filepath.Join(target, m.CLIEntry)); err == nil {
		return state.RuntimeRef{Commit: m.Commit, ActivatedAt: time.Now().UTC()}, nil
	}
	source := os.Getenv("DSH_DESKTOP_SEED_DIR")
	if source == "" {
		exe, _ := os.Executable()
		source = filepath.Join(filepath.Dir(exe), "resources", "seed", "runtime", m.Commit)
	}
	if _, err := os.Stat(filepath.Join(source, m.CLIEntry)); err != nil {
		return state.RuntimeRef{}, fmt.Errorf("offline seed runtime %s is missing; reinstall the desktop package", m.Commit[:12])
	}
	if appconfig.IsOwnedPath(c.paths.Versions, target) {
		_ = os.RemoveAll(target)
	}
	if err := copyRuntime(source, target); err != nil {
		return state.RuntimeRef{}, err
	}
	return state.RuntimeRef{Commit: m.Commit, ActivatedAt: time.Now().UTC()}, nil
}

func (c *Coordinator) CheckDesktopUpdate(ctx context.Context) (*state.DesktopUpdate, error) {
	return c.appUpdates.Check(ctx)
}
func (c *Coordinator) InstallDesktopUpdate(ctx context.Context) error {
	return c.appUpdates.DownloadAndLaunch(ctx)
}
func (c *Coordinator) ListBackups() ([]backup.Info, error) { return c.backups.List() }
func (c *Coordinator) Rollback(ctx context.Context, confirmed bool) error {
	if !confirmed {
		return fmt.Errorf("manual rollback requires data-loss confirmation")
	}
	snap := c.store.Snapshot()
	if snap.Active == nil || snap.Active.Previous == nil {
		return fmt.Errorf("no previous successful runtime is available")
	}
	old := *snap.Active
	currentBackup, err := c.backups.Create("manual pre-rollback backup", old.Current.Commit)
	if err != nil {
		return err
	}
	list, err := c.backups.List()
	if err != nil {
		return err
	}
	var dataBackup string
	for _, item := range list {
		if item.Commit == old.Previous.Commit && item.ID != currentBackup.ID {
			dataBackup = item.ID
			break
		}
	}
	if dataBackup == "" {
		return fmt.Errorf("no compatible data backup was found for %s", old.Previous.Commit[:12])
	}
	c.showRecovery()
	if err := c.Stop(ctx); err != nil {
		return err
	}
	c.store.SetRuntimeInfo(state.Recovering, "正在回滚代码与 Harness 数据", "")
	if err := c.backups.Restore(dataBackup); err != nil {
		return err
	}
	next := state.ActiveState{Current: *old.Previous, Previous: &old.Current}
	next.Current.ActivatedAt = time.Now().UTC()
	if err := c.store.SaveActive(next); err != nil {
		return err
	}
	if err := c.Start(ctx); err != nil {
		_ = c.backups.Restore(currentBackup.ID)
		_ = c.store.SaveActive(old)
		return c.Start(ctx)
	}
	return nil
}
func (c *Coordinator) showRecovery() {
	c.mu.Lock()
	f := c.onRecovery
	c.mu.Unlock()
	if f != nil {
		f()
	}
}

func copyRuntime(source, dest string) error {
	return filepath.Walk(source, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		if err == nil {
			err = out.Close()
		} else {
			_ = out.Close()
		}
		return err
	})
}
