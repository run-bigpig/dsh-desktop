package plugin

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/update"
)

const desktopPluginVersion = "0.1.63"
const maxPluginArchiveBytes int64 = 64 << 20

var bundledPackageDirectories = []string{
	"plugin-host",
	"plugin-client",
	"plugin-bundle",
}

var managedBundlePackages = []string{
	"@run-bigpig/dsh-desktop-plugin-host",
	"@run-bigpig/dsh-desktop-plugin-client",
	"@run-bigpig/dsh-desktop-plugin",
}

var retiredManagedBundlePackages = []string{"dsh-web-tools"}

var legacyManagedBundlePackageSets = [][]string{
	{
		"@deepseek-ai/dsh-desktop-marketplace-host",
		"@deepseek-ai/dsh-desktop-marketplace-client",
		"@deepseek-ai/dsh-desktop-marketplace",
	},
	{
		"@run-bigpig/dsh-desktop-marketplace-host",
		"@run-bigpig/dsh-desktop-marketplace-client",
		"@run-bigpig/dsh-desktop-marketplace",
	},
}

var stableBundleDirectories = []string{
	"plugin-host",
	"plugin-client",
	"plugin-bundle",
}

var retiredStableBundleDirectories = []string{"web-tools"}

var legacyStableBundleArtifacts = []string{
	"plugin-host.tgz",
	"plugin-client.tgz",
	"plugin-bundle.tgz",
}

type Lifecycle struct {
	Stop  func(context.Context) error
	Start func(context.Context) error
}

type Options struct {
	Paths               appconfig.Paths
	Tools               update.Toolchain
	Log                 io.Writer
	CatalogURL          string
	CatalogSignatureURL string
	TrustedCatalogKey   ed25519.PublicKey
}

type Manager struct {
	mu                  sync.Mutex
	catalogMu           sync.Mutex
	paths               appconfig.Paths
	tools               update.Toolchain
	log                 io.Writer
	catalogURL          string
	catalogSignatureURL string
	trustedCatalogKey   ed25519.PublicKey
	lastCatalogRefresh  time.Time
	runtimeDir          string
	commit              string
	controlURL          string
	controlToken        string
	lifecycle           Lifecycle
	operations          map[string]*operationRecord
	activeOperation     string
	httpClient          *http.Client
	catalogClient       *http.Client
}

func New(options Options) (*Manager, error) {
	m := &Manager{
		paths: options.Paths, tools: options.Tools, log: options.Log,
		catalogURL: options.CatalogURL, catalogSignatureURL: options.CatalogSignatureURL,
		trustedCatalogKey: append(ed25519.PublicKey(nil), options.TrustedCatalogKey...),
		operations:        make(map[string]*operationRecord),
	}
	m.httpClient = &http.Client{
		Timeout: 2 * time.Minute,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many release redirects")
			}
			if request.URL.Scheme != "https" || !allowedDownloadHost(request.URL.Hostname()) {
				return errors.New("release redirect left trusted GitHub hosts")
			}
			return nil
		},
	}
	m.catalogClient = &http.Client{
		Timeout: 8 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many catalog redirects")
			}
			if !secureCatalogURL(request.URL) {
				return errors.New("catalog redirect left HTTPS")
			}
			return nil
		},
	}
	if err := m.recoverInterruptedSwap(); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *Manager) SetRuntime(runtimeDir, commit string) {
	m.mu.Lock()
	m.runtimeDir, m.commit = runtimeDir, commit
	m.mu.Unlock()
}

func (m *Manager) SetControl(url, token string) {
	m.mu.Lock()
	m.controlURL, m.controlToken = url, token
	m.mu.Unlock()
}

func (m *Manager) SetLifecycle(lifecycle Lifecycle) {
	m.mu.Lock()
	m.lifecycle = lifecycle
	m.mu.Unlock()
}

func (m *Manager) EnsureDesktopPlugin(ctx context.Context) error {
	profile := filepath.Join(m.paths.HarnessHome, "profiles", "web")
	legacyRoot := filepath.Join(filepath.Dir(m.paths.Root), "DeepSeekHarnessDesktop")
	if err := migrateLegacyProfilePaths(profile, legacyRoot, m.paths.Root); err != nil {
		return fmt.Errorf("migrate legacy plugin paths: %w", err)
	}
	if err := m.detachMismatchedProfileStore(profile); err != nil {
		return fmt.Errorf("repair migrated pnpm profile: %w", err)
	}
	installed := installedPackageVersion(m.paths.HarnessHome, "@run-bigpig/dsh-desktop-plugin")
	packages, ok := m.bundledPackages()
	if !ok {
		if m.log != nil {
			_, _ = fmt.Fprintln(m.log, "desktop plugin bundle is not available in this development build")
		}
		return nil
	}
	packages, err := m.publishBundlePackages(packages)
	if err != nil {
		return fmt.Errorf("publish desktop plugin bundle: %w", err)
	}
	originalManifest, changed, err := rewriteManagedBundleSpecs(filepath.Join(profile, "package.json"), packages)
	if err != nil {
		return fmt.Errorf("migrate desktop plugin bundle paths: %w", err)
	}
	if installed != nil && *installed == desktopPluginVersion && !changed {
		if err := m.migrateRetiredDeepSeekDefaultModel(); err != nil {
			return err
		}
		return nil
	}
	args := []string{"plugin", "--profile", "web", "add"}
	for _, directory := range packages {
		args = append(args, "file:"+filepath.ToSlash(directory))
	}
	args = append(args, "--save-exact", "--force", "--ignore-scripts", "--offline", "--store-dir", m.paths.PNPMStore)
	if err := dropProfileLockfile(profile); err != nil {
		return fmt.Errorf("discard position-dependent profile lockfile: %w", err)
	}
	previousModules, err := m.detachProfileModules(profile, "profile-upgrade")
	if err != nil {
		return fmt.Errorf("detach current profile dependencies: %w", err)
	}
	if err := m.runCLI(ctx, m.paths.HarnessHome, args...); err != nil {
		if changed {
			_ = replaceFile(filepath.Join(profile, "package.json"), originalManifest, 0o600)
		}
		_ = restoreProfileModules(profile, previousModules)
		return fmt.Errorf("install desktop plugin bundle: %w", err)
	}
	if err := dropProfileLockfile(profile); err != nil {
		return fmt.Errorf("discard regenerated profile lockfile: %w", err)
	}
	installed = installedPackageVersion(m.paths.HarnessHome, "@run-bigpig/dsh-desktop-plugin")
	if installed == nil || *installed != desktopPluginVersion {
		_ = restoreProfileModules(profile, previousModules)
		return fmt.Errorf("desktop plugin bundle version %s was not installed", desktopPluginVersion)
	}
	if previousModules != "" {
		go func() { _ = os.RemoveAll(previousModules) }()
	}
	if err := m.migrateRetiredDeepSeekDefaultModel(); err != nil {
		return err
	}
	return nil
}

func migrateLegacyProfilePaths(profile, legacyRoot, currentRoot string) error {
	replacements := [][2][]byte{
		{[]byte(filepath.ToSlash(legacyRoot)), []byte(filepath.ToSlash(currentRoot))},
		{[]byte(legacyRoot), []byte(currentRoot)},
		{[]byte(strings.ReplaceAll(legacyRoot, `\`, `\\`)), []byte(strings.ReplaceAll(currentRoot, `\`, `\\`))},
	}
	for _, name := range []string{"package.json", "pnpm-lock.yaml"} {
		path := filepath.Join(profile, name)
		original, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		updated := original
		for _, replacement := range replacements {
			updated = bytes.ReplaceAll(updated, replacement[0], replacement[1])
		}
		if bytes.Equal(updated, original) {
			continue
		}
		if err := replaceFile(path, updated, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) detachMismatchedProfileStore(profile string) error {
	modules := filepath.Join(profile, "node_modules")
	data, err := os.ReadFile(filepath.Join(modules, ".modules.yaml"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var metadata struct {
		StoreDir string `json:"storeDir"`
	}
	if json.Unmarshal(data, &metadata) != nil || metadata.StoreDir == "" {
		return nil
	}
	desired := filepath.Clean(m.paths.PNPMStore)
	actual := filepath.Clean(metadata.StoreDir)
	sameStore := actual == desired
	if runtime.GOOS == "windows" {
		sameStore = strings.EqualFold(actual, desired)
	}
	if sameStore || appconfig.IsOwnedPath(desired, actual) {
		return nil
	}
	stale, err := m.detachProfileModules(profile, "profile-store")
	if err != nil {
		return err
	}
	if m.log != nil {
		_, _ = fmt.Fprintf(m.log, "detached profile dependencies linked to previous pnpm store %s\n", metadata.StoreDir)
	}
	go func() { _ = os.RemoveAll(stale) }()
	return nil
}

func (m *Manager) detachProfileModules(profile, label string) (string, error) {
	modules := filepath.Join(profile, "node_modules")
	if _, err := os.Stat(modules); errors.Is(err, os.ErrNotExist) {
		return "", nil
	} else if err != nil {
		return "", err
	}
	cleanupRoot := filepath.Join(m.paths.Marketplace, "cleanup")
	if err := os.MkdirAll(cleanupRoot, 0o700); err != nil {
		return "", err
	}
	stale := filepath.Join(cleanupRoot, fmt.Sprintf("%s-node_modules-%d", label, time.Now().UnixNano()))
	if err := os.Rename(modules, stale); err != nil {
		return "", err
	}
	return stale, nil
}

func restoreProfileModules(profile, previous string) error {
	modules := filepath.Join(profile, "node_modules")
	if err := os.RemoveAll(modules); err != nil {
		return err
	}
	if previous == "" {
		return nil
	}
	return os.Rename(previous, modules)
}

func (m *Manager) publishBundlePackages(sources []string) ([]string, error) {
	if len(sources) != len(stableBundleDirectories) {
		return nil, errors.New("desktop plugin bundle package list is invalid")
	}
	directory := filepath.Join(m.paths.Plugin, "bundle")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	targets := make([]string, len(sources))
	for index, source := range sources {
		target := filepath.Join(directory, stableBundleDirectories[index])
		temporary := target + ".tmp"
		if err := os.RemoveAll(temporary); err != nil {
			return nil, err
		}
		if err := os.CopyFS(temporary, os.DirFS(source)); err != nil {
			_ = os.RemoveAll(temporary)
			return nil, err
		}
		if err := os.RemoveAll(target); err != nil {
			_ = os.RemoveAll(temporary)
			return nil, err
		}
		if err := os.Rename(temporary, target); err != nil {
			_ = os.RemoveAll(temporary)
			return nil, err
		}
		targets[index] = target
	}
	for _, name := range legacyStableBundleArtifacts {
		if err := os.Remove(filepath.Join(directory, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	for _, name := range retiredStableBundleDirectories {
		if err := os.RemoveAll(filepath.Join(directory, name)); err != nil {
			return nil, err
		}
	}
	legacyDirectory := filepath.Join(m.paths.Marketplace, "bundle")
	if err := os.RemoveAll(legacyDirectory); err != nil && m.log != nil {
		_, _ = fmt.Fprintln(m.log, "remove legacy desktop Marketplace bundle directory:", err)
	}
	return targets, nil
}

func rewriteManagedBundleSpecs(path string, artifacts []string) ([]byte, bool, error) {
	if len(artifacts) != len(managedBundlePackages) {
		return nil, false, errors.New("desktop plugin bundle package list is invalid")
	}
	original, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(original, &document); err != nil {
		return nil, false, err
	}
	dependencies := make(map[string]string)
	if raw := document["dependencies"]; len(raw) != 0 {
		if err := json.Unmarshal(raw, &dependencies); err != nil {
			return nil, false, err
		}
	}
	changed := false
	for _, packageName := range retiredManagedBundlePackages {
		if _, ok := dependencies[packageName]; ok {
			delete(dependencies, packageName)
			changed = true
		}
	}
	for index, packageName := range managedBundlePackages {
		_, current := dependencies[packageName]
		legacy := false
		for _, legacyPackages := range legacyManagedBundlePackageSets {
			if index < len(legacyPackages) {
				if _, ok := dependencies[legacyPackages[index]]; ok {
					legacy = true
				}
			}
		}
		if !current && !legacy {
			continue
		}
		spec := "file:" + filepath.ToSlash(artifacts[index])
		if dependencies[packageName] != spec {
			dependencies[packageName] = spec
			changed = true
		}
		for _, legacyPackages := range legacyManagedBundlePackageSets {
			if index < len(legacyPackages) {
				if _, ok := dependencies[legacyPackages[index]]; ok {
					delete(dependencies, legacyPackages[index])
					changed = true
				}
			}
		}
	}
	if raw := document["dsh"]; len(raw) != 0 {
		var dsh map[string]json.RawMessage
		if err := json.Unmarshal(raw, &dsh); err != nil {
			return nil, false, err
		}
		if rawProfile := dsh["profile"]; len(rawProfile) != 0 {
			var profile map[string]json.RawMessage
			if err := json.Unmarshal(rawProfile, &profile); err != nil {
				return nil, false, err
			}
			if rawBundles := profile["bundles"]; len(rawBundles) != 0 {
				var bundles []string
				if err := json.Unmarshal(rawBundles, &bundles); err != nil {
					return nil, false, err
				}
				for index, bundle := range bundles {
					for _, legacyPackages := range legacyManagedBundlePackageSets {
						if bundle == legacyPackages[2] {
							bundles[index] = managedBundlePackages[2]
							changed = true
							break
						}
					}
				}
				if changed {
					encodedBundles, err := json.Marshal(bundles)
					if err != nil {
						return nil, false, err
					}
					profile["bundles"] = encodedBundles
					encodedProfile, err := json.Marshal(profile)
					if err != nil {
						return nil, false, err
					}
					dsh["profile"] = encodedProfile
					encodedDSH, err := json.Marshal(dsh)
					if err != nil {
						return nil, false, err
					}
					document["dsh"] = encodedDSH
				}
			}
		}
	}
	if !changed {
		return original, false, nil
	}
	encodedDependencies, err := json.Marshal(dependencies)
	if err != nil {
		return nil, false, err
	}
	document["dependencies"] = encodedDependencies
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, false, err
	}
	encoded = append(encoded, '\n')
	if err := replaceFile(path, encoded, 0o600); err != nil {
		return nil, false, err
	}
	return original, true, nil
}

func replaceFile(path string, data []byte, mode fs.FileMode) error {
	temporary := path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func (m *Manager) Begin(request MutationRequest) (Operation, error) {
	if request.PluginID == "" || (request.Action != Install && request.Action != Update && request.Action != Uninstall) {
		return Operation{}, ErrInvalid
	}
	snapshot, err := m.Catalog()
	if err != nil {
		return Operation{}, err
	}
	var plugin *Plugin
	for i := range snapshot.Plugins {
		if snapshot.Plugins[i].ID == request.PluginID {
			copy := snapshot.Plugins[i]
			plugin = &copy
			break
		}
	}
	if plugin == nil {
		return Operation{}, ErrNotFound
	}
	if !snapshot.CatalogVerified && os.Getenv("DSH_DESKTOP_MARKETPLACE_ALLOW_UNSIGNED") != "1" {
		return Operation{}, fmt.Errorf("%w: plugin installation is disabled until the catalog signature is verified", ErrInvalid)
	}
	if request.Action == Install && plugin.InstalledVersion != nil {
		return Operation{}, fmt.Errorf("%w: plugin is already installed", ErrInvalid)
	}
	if request.Action == Update && plugin.InstalledVersion == nil {
		return Operation{}, fmt.Errorf("%w: plugin is not installed", ErrInvalid)
	}
	if request.Action == Update && !plugin.UpdateAvailable {
		return Operation{}, fmt.Errorf("%w: catalog version is not newer than the installed plugin", ErrInvalid)
	}
	if request.Action == Uninstall && plugin.InstalledVersion == nil {
		return Operation{}, fmt.Errorf("%w: plugin is not installed", ErrInvalid)
	}
	id, err := randomID()
	if err != nil {
		return Operation{}, err
	}
	record := &operationRecord{Operation: Operation{
		ID: id, PluginID: request.PluginID, Action: request.Action,
		Phase: Queued, Progress: 0, Message: "操作已排队",
	}, createdAt: time.Now().UTC()}
	m.mu.Lock()
	if active := m.operations[m.activeOperation]; active != nil && !active.terminal() {
		m.mu.Unlock()
		return Operation{}, ErrBusy
	}
	m.operations[id] = record
	m.activeOperation = id
	m.mu.Unlock()
	go m.execute(id, *plugin)
	return record.Operation, nil
}

func (m *Manager) Operation(id string) (Operation, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, ok := m.operations[id]
	if !ok {
		return Operation{}, false
	}
	return record.Operation, true
}

func (m *Manager) ActiveOperation() (Operation, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	record := m.operations[m.activeOperation]
	if record == nil || record.terminal() {
		return Operation{}, false
	}
	return record.Operation, true
}

func (m *Manager) execute(id string, plugin Plugin) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := m.executeOperation(ctx, id, plugin); err != nil {
		m.fail(id, err)
	}
}

func (m *Manager) executeOperation(ctx context.Context, id string, plugin Plugin) error {
	document, err := m.catalogEntry(plugin.ID)
	if err != nil {
		return err
	}
	txn := filepath.Join(m.paths.PluginTxns, id)
	if !appconfig.IsOwnedPath(m.paths.PluginTxns, txn) {
		return errors.New("unsafe marketplace transaction path")
	}
	virtualStore := m.virtualStore(id)
	if !appconfig.IsOwnedPath(filepath.Join(m.paths.Marketplace, "virtual-stores"), virtualStore) {
		return errors.New("unsafe marketplace virtual store path")
	}
	_ = os.RemoveAll(txn)
	if err := os.MkdirAll(filepath.Join(txn, "home", "profiles"), 0o700); err != nil {
		return err
	}

	var archive string
	if m.action(id) != Uninstall {
		m.set(id, Downloading, 20, "正在下载固定版本插件")
		archive, err = m.download(ctx, document)
		if err != nil {
			return err
		}
		m.set(id, Verifying, 38, "正在校验插件 SHA-256")
		if err := verifyFileSHA256(archive, document.Release.SHA256); err != nil {
			return err
		}
	}

	m.set(id, Staging, 48, "正在创建隔离安装环境")
	currentProfile := filepath.Join(m.paths.HarnessHome, "profiles", "web")
	stagedProfile := filepath.Join(txn, "home", "profiles", "web")
	if err := stageProfile(currentProfile, stagedProfile); err != nil {
		return err
	}
	m.set(id, Installing, 60, "正在隔离安装插件依赖")
	action := m.action(id)
	if action == Uninstall {
		if err := m.runCLI(ctx, filepath.Join(txn, "home"), pluginMutationArgs(action, document.PackageName, "", m.paths.PNPMStore, virtualStore)...); err != nil {
			return fmt.Errorf("remove plugin: %w", err)
		}
	} else {
		if err := m.runCLI(ctx, filepath.Join(txn, "home"), pluginMutationArgs(action, document.PackageName, archive, m.paths.PNPMStore, virtualStore)...); err != nil {
			return fmt.Errorf("install plugin: %w", err)
		}
	}
	m.set(id, Validating, 72, "正在验证插件配置")
	if err := m.runCLI(ctx, filepath.Join(txn, "home"), "--profile", "web", "--dump-config"); err != nil {
		return fmt.Errorf("validate plugin profile: %w", err)
	}
	if err := dropProfileLockfile(stagedProfile); err != nil {
		return fmt.Errorf("discard staged profile lockfile: %w", err)
	}

	m.set(id, ReadyToRestart, 84, "验证通过，正在切换插件配置")
	m.mu.Lock()
	lifecycle := m.lifecycle
	m.mu.Unlock()
	if lifecycle.Stop == nil || lifecycle.Start == nil {
		return errors.New("desktop lifecycle is unavailable")
	}
	if err := lifecycle.Stop(ctx); err != nil {
		return fmt.Errorf("stop Harness before plugin activation: %w", err)
	}
	previous := filepath.Join(txn, "previous-profile")
	if err := swapProfile(currentProfile, stagedProfile, previous); err != nil {
		_ = lifecycle.Start(context.Background())
		return err
	}
	m.set(id, Restarting, 92, "正在重启 Harness")
	if err := lifecycle.Start(ctx); err != nil {
		_ = lifecycle.Stop(context.Background())
		failedProfile := filepath.Join(txn, "failed-profile")
		_ = os.Rename(currentProfile, failedProfile)
		if restoreErr := os.Rename(previous, currentProfile); restoreErr != nil {
			return fmt.Errorf("plugin activation failed (%v) and profile restore failed: %w", err, restoreErr)
		}
		if restoreStartErr := lifecycle.Start(context.Background()); restoreStartErr != nil {
			return fmt.Errorf("plugin activation failed (%v); old profile restored but failed to start: %w", err, restoreStartErr)
		}
		message := fmt.Sprintf("插件启动失败，已恢复旧配置: %v", err)
		m.setError(id, RolledBack, 100, "已自动回滚", message)
		return nil
	}
	if err := m.archivePrevious(id, previous); err != nil && m.log != nil {
		_, _ = fmt.Fprintln(m.log, "archive previous plugin profile:", err)
	}
	m.set(id, Completed, 100, "插件操作完成")
	go os.RemoveAll(txn)
	return nil
}

func (m *Manager) action(id string) Action {
	m.mu.Lock()
	defer m.mu.Unlock()
	if record := m.operations[id]; record != nil {
		return record.Action
	}
	return ""
}

func (m *Manager) set(id string, phase Phase, progress int, message string) {
	m.mu.Lock()
	if record := m.operations[id]; record != nil {
		record.Phase, record.Progress, record.Message, record.Error = phase, progress, message, nil
	}
	m.mu.Unlock()
}

func (m *Manager) setError(id string, phase Phase, progress int, message, detail string) {
	m.mu.Lock()
	if record := m.operations[id]; record != nil {
		record.Phase, record.Progress, record.Message, record.Error = phase, progress, message, &detail
	}
	m.mu.Unlock()
}

func (m *Manager) fail(id string, err error) {
	m.setError(id, Failed, 100, "插件操作失败", err.Error())
}

func (m *Manager) catalogEntry(id string) (catalogPlugin, error) {
	data, err := os.ReadFile(m.catalogPath())
	if err != nil {
		return catalogPlugin{}, err
	}
	var document catalogDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return catalogPlugin{}, err
	}
	for _, entry := range document.Plugins {
		if entry.ID == id {
			return entry, validateCatalogPlugin(entry)
		}
	}
	return catalogPlugin{}, ErrNotFound
}

func (m *Manager) catalogPath() string {
	if root := os.Getenv("DSH_DESKTOP_MARKETPLACE_DIR"); root != "" {
		if _, err := os.Stat(filepath.Join(root, "catalog", "catalog.json")); err == nil {
			return filepath.Join(root, "catalog", "catalog.json")
		}
		return filepath.Join(root, "catalog.json")
	}
	cached := filepath.Join(m.paths.Marketplace, "catalog.json")
	if data, err := os.ReadFile(cached); err == nil && m.verifyCatalog(data, cached) {
		return cached
	}
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "resources", "marketplace", "catalog.json")
}

func (m *Manager) bundledPackages() ([]string, bool) {
	var directory string
	if root := os.Getenv("DSH_DESKTOP_PLUGIN_DIR"); root != "" {
		directory = root
	} else {
		exe, _ := os.Executable()
		directory = filepath.Join(filepath.Dir(exe), "resources", "plugin")
	}
	paths := make([]string, 0, len(bundledPackageDirectories))
	for _, name := range bundledPackageDirectories {
		path := filepath.Join(directory, name)
		info, err := os.Stat(path)
		if err != nil || !info.IsDir() {
			return nil, false
		}
		paths = append(paths, path)
	}
	return paths, true
}

func (m *Manager) runtime() (string, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.runtimeDir == "" {
		return "", "", errors.New("Harness runtime is not ready")
	}
	return m.runtimeDir, m.commit, nil
}

func (m *Manager) runCLI(ctx context.Context, home string, args ...string) error {
	runtimeDir, _, err := m.runtime()
	if err != nil {
		return err
	}
	cli := filepath.Join(runtimeDir, "apps", "cli", "lib", "bin.js")
	command := exec.CommandContext(ctx, m.tools.Node, append([]string{cli}, args...)...)
	configureCLICommand(command)
	command.Dir = m.paths.Workspaces
	command.Env = m.commandEnvironment(home)
	command.Stdout, command.Stderr = m.log, m.log
	if err := command.Run(); err != nil {
		return fmt.Errorf("dsh %s: %w", strings.Join(args, " "), err)
	}
	return nil
}

func pluginMutationArgs(action Action, packageName, archive, store, virtualStore string) []string {
	if action == Uninstall {
		return []string{"plugin", "--profile", "web", "remove", packageName, "--store-dir", store, "--virtual-store-dir", virtualStore}
	}
	return []string{"plugin", "--profile", "web", "add", archive, "--save-exact", "--ignore-scripts", "--store-dir", store, "--virtual-store-dir", virtualStore}
}

func (m *Manager) virtualStore(name string) string {
	return filepath.Join(m.paths.Marketplace, "virtual-stores", name)
}

func (m *Manager) commandEnvironment(home string) []string {
	allowed := map[string]bool{
		"SYSTEMROOT": true, "WINDIR": true, "COMSPEC": true, "PATHEXT": true,
		"TEMP": true, "TMP": true, "TMPDIR": true, "LANG": true, "LC_ALL": true,
		"LOCALAPPDATA": true, "APPDATA": true, "USERPROFILE": true,
	}
	var env []string
	for _, item := range os.Environ() {
		key, _, ok := strings.Cut(item, "=")
		if ok && allowed[strings.ToUpper(key)] {
			env = append(env, item)
		}
	}
	binDirs := []string{filepath.Dir(m.tools.Node), filepath.Dir(m.tools.PNPM)}
	if m.tools.Git != "" {
		binDirs = append(binDirs, filepath.Dir(m.tools.Git))
	}
	path := strings.Join(binDirs, string(os.PathListSeparator))
	env = append(env, "PATH="+path, "DSH_HOME="+home, "PNPM_HOME="+filepath.Dir(m.tools.PNPM),
		"NPM_CONFIG_UPDATE_NOTIFIER=false", "GIT_TERMINAL_PROMPT=0", "CI=1")
	if runtime.GOOS != "windows" {
		env = append(env, "HOME="+home, "SHELL=/bin/sh")
	}
	m.mu.Lock()
	if m.controlURL != "" {
		env = append(env, "DSH_DESKTOP_CONTROL_URL="+m.controlURL)
	}
	if m.controlToken != "" {
		env = append(env, "DSH_DESKTOP_CONTROL_TOKEN="+m.controlToken)
	}
	m.mu.Unlock()
	return env
}

func (m *Manager) download(ctx context.Context, entry catalogPlugin) (string, error) {
	if err := validateReleaseURL(entry.Release.AssetURL); err != nil {
		return "", err
	}
	name := strings.NewReplacer("/", "-", "@", "", "\\", "-").Replace(entry.PackageName) + "-" + entry.Release.Version + ".tgz"
	target := filepath.Join(m.paths.PluginCache, name)
	if !appconfig.IsOwnedPath(m.paths.PluginCache, target) {
		return "", errors.New("unsafe plugin cache path")
	}
	if verifyFileSHA256(target, entry.Release.SHA256) == nil {
		return target, nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, entry.Release.AssetURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "StarWeave-Marketplace/"+desktopPluginVersion)
	response, err := m.httpClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("download plugin release: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download plugin release: HTTP %d", response.StatusCode)
	}
	temporary := target + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	_, copyErr := io.Copy(file, io.LimitReader(response.Body, maxPluginArchiveBytes+1))
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(temporary)
		return "", copyErr
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return "", closeErr
	}
	info, err := os.Stat(temporary)
	if err != nil || info.Size() > maxPluginArchiveBytes {
		_ = os.Remove(temporary)
		return "", errors.New("plugin release exceeds 64 MiB")
	}
	if err := verifyFileSHA256(temporary, entry.Release.SHA256); err != nil {
		_ = os.Remove(temporary)
		return "", err
	}
	_ = os.Remove(target)
	if err := os.Rename(temporary, target); err != nil {
		return "", err
	}
	return target, nil
}

func validateReleaseURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() != "github.com" || !strings.Contains(u.EscapedPath(), "/releases/download/") || !strings.HasSuffix(strings.ToLower(u.Path), ".tgz") {
		return errors.New("plugin release must be an immutable GitHub Release .tgz")
	}
	return nil
}

func allowedDownloadHost(host string) bool {
	return host == "github.com" || strings.HasSuffix(host, ".githubusercontent.com")
}

func verifyFileSHA256(path, expected string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expected {
		return fmt.Errorf("plugin SHA-256 mismatch: expected %s, got %s", expected, actual)
	}
	return nil
}

func randomID() (string, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}

func copyProfile(source, target string) error {
	if _, err := os.Stat(source); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if relative == "node_modules" || strings.HasPrefix(relative, "node_modules"+string(filepath.Separator)) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o700)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, destination)
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			_ = input.Close()
			return err
		}
		_, copyErr := io.Copy(output, input)
		inputErr := input.Close()
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		if inputErr != nil {
			return inputErr
		}
		return closeErr
	})
}

func stageProfile(source, target string) error {
	if err := copyProfile(source, target); err != nil {
		return err
	}
	return dropProfileLockfile(target)
}

func dropProfileLockfile(profile string) error {
	// pnpm stores local file dependency resolutions relative to the lockfile.
	// Plugin profiles move between live and transaction directories, so keeping
	// a generated lockfile makes those paths resolve from the wrong directory.
	if err := os.Remove(filepath.Join(profile, "pnpm-lock.yaml")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func swapProfile(current, staged, previous string) error {
	if _, err := os.Stat(staged); err != nil {
		return fmt.Errorf("staged plugin profile is missing: %w", err)
	}
	_ = os.RemoveAll(previous)
	currentExists := true
	if _, err := os.Stat(current); errors.Is(err, os.ErrNotExist) {
		currentExists = false
	}
	if currentExists {
		if err := os.Rename(current, previous); err != nil {
			return fmt.Errorf("detach current plugin profile: %w", err)
		}
	}
	if err := os.Rename(staged, current); err != nil {
		if currentExists {
			_ = os.Rename(previous, current)
		}
		return fmt.Errorf("activate staged plugin profile: %w", err)
	}
	return nil
}

func (m *Manager) archivePrevious(id, previous string) error {
	if _, err := os.Stat(previous); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	target := filepath.Join(m.paths.PluginBackups, id+"-web-profile")
	if err := os.Rename(previous, target); err != nil {
		return err
	}
	entries, err := os.ReadDir(m.paths.PluginBackups)
	if err != nil {
		return err
	}
	var directories []fs.DirEntry
	for _, entry := range entries {
		if entry.IsDir() {
			directories = append(directories, entry)
		}
	}
	sort.Slice(directories, func(i, j int) bool {
		left, _ := directories[i].Info()
		right, _ := directories[j].Info()
		return left.ModTime().After(right.ModTime())
	})
	if len(directories) <= 3 {
		return nil
	}
	for _, entry := range directories[3:] {
		path := filepath.Join(m.paths.PluginBackups, entry.Name())
		go os.RemoveAll(path)
	}
	return nil
}

func (m *Manager) recoverInterruptedSwap() error {
	entries, err := os.ReadDir(m.paths.PluginTxns)
	if err != nil {
		return err
	}
	current := filepath.Join(m.paths.HarnessHome, "profiles", "web")
	if _, err := os.Stat(current); err == nil {
		return nil
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		previous := filepath.Join(m.paths.PluginTxns, entry.Name(), "previous-profile")
		if _, err := os.Stat(previous); err == nil {
			if err := os.MkdirAll(filepath.Dir(current), 0o700); err != nil {
				return err
			}
			return os.Rename(previous, current)
		}
	}
	return nil
}
