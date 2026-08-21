package plugin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/update"
)

func TestPluginMutationArgs(t *testing.T) {
	install := pluginMutationArgs(Install, "example-plugin", "C:/cache/example.tgz", "C:/store", "C:/virtual")
	if !slices.Contains(install, "--ignore-scripts") {
		t.Fatal("plugin installation must disable lifecycle scripts")
	}

	uninstall := pluginMutationArgs(Uninstall, "example-plugin", "", "C:/store", "C:/virtual")
	if slices.Contains(uninstall, "--ignore-scripts") {
		t.Fatal("pnpm remove does not support --ignore-scripts")
	}
	want := []string{"plugin", "--profile", "web", "remove", "example-plugin", "--store-dir", "C:/store", "--virtual-store-dir", "C:/virtual"}
	if !slices.Equal(uninstall, want) {
		t.Fatalf("uninstall args = %q, want %q", uninstall, want)
	}
}

func TestActiveOperationReturnsOnlyRunningOperation(t *testing.T) {
	record := &operationRecord{Operation: Operation{
		ID: "operation-id", PluginID: "plugin-id", Action: Install,
		Phase: Installing, Progress: 60, Message: "installing",
	}}
	manager := &Manager{
		operations:      map[string]*operationRecord{"operation-id": record},
		activeOperation: "operation-id",
	}
	operation, ok := manager.ActiveOperation()
	if !ok || operation.ID != record.ID || operation.Progress != 60 {
		t.Fatalf("active operation = %+v, %v", operation, ok)
	}
	record.Phase = Completed
	if operation, ok := manager.ActiveOperation(); ok {
		t.Fatalf("terminal operation was returned as active: %+v", operation)
	}
}

func TestCommandEnvironmentDoesNotRequireGit(t *testing.T) {
	manager := &Manager{tools: update.Toolchain{
		Node: filepath.Join("toolchain", "node", "node.exe"),
		PNPM: filepath.Join("toolchain", "pnpm", "pnpm.exe"),
	}}
	var commandPath string
	for _, item := range manager.commandEnvironment(t.TempDir()) {
		if strings.HasPrefix(item, "PATH=") {
			commandPath = strings.TrimPrefix(item, "PATH=")
			break
		}
	}
	want := strings.Join([]string{
		filepath.Join("toolchain", "node"),
		filepath.Join("toolchain", "pnpm"),
	}, string(os.PathListSeparator))
	if commandPath != want {
		t.Fatalf("PATH = %q, want %q", commandPath, want)
	}
}

func TestDetachMismatchedProfileStore(t *testing.T) {
	paths := appconfig.NewPaths(t.TempDir())
	profile := filepath.Join(paths.HarnessHome, "profiles", "web")
	modules := filepath.Join(profile, "node_modules")
	if err := os.MkdirAll(modules, 0o700); err != nil {
		t.Fatal(err)
	}
	metadata := []byte(`{"storeDir":` + string(mustJSON(t, filepath.Join(t.TempDir(), "pnpm-store", "v11"))) + `}`)
	if err := os.WriteFile(filepath.Join(modules, ".modules.yaml"), metadata, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(modules, "preserved-before-detach"), []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{paths: paths}
	if err := manager.detachMismatchedProfileStore(profile); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(modules); !os.IsNotExist(err) {
		t.Fatalf("profile node_modules was not detached: %v", err)
	}
	cleanup := filepath.Join(paths.Marketplace, "cleanup")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		entries, err := os.ReadDir(cleanup)
		if err == nil && len(entries) == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("detached profile dependencies were not cleaned up")
}

func TestDetachAndRestoreProfileModules(t *testing.T) {
	paths := appconfig.NewPaths(t.TempDir())
	profile := filepath.Join(paths.HarnessHome, "profiles", "web")
	marker := filepath.Join(profile, "node_modules", "preserved")
	if err := os.MkdirAll(filepath.Dir(marker), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{paths: paths}
	previous, err := manager.detachProfileModules(profile, "test")
	if err != nil {
		t.Fatal(err)
	}
	if previous == "" {
		t.Fatal("profile dependencies were not detached")
	}
	partial := filepath.Join(profile, "node_modules", "partial")
	if err := os.MkdirAll(filepath.Dir(partial), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partial, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := restoreProfileModules(profile, previous); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "old" {
		t.Fatalf("previous profile dependencies were not restored: %q, %v", data, err)
	}
	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Fatalf("partial profile dependencies were retained: %v", err)
	}
}

func TestMigrateLegacyProfilePaths(t *testing.T) {
	root := t.TempDir()
	legacyRoot := filepath.Join(root, "DeepSeekHarnessDesktop")
	currentRoot := filepath.Join(root, "DSH-DeskTop")
	profile := filepath.Join(currentRoot, "harness-home", "profiles", "web")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		t.Fatal(err)
	}
	legacyPlugin := "file:" + filepath.ToSlash(filepath.Join(legacyRoot, "marketplace", "downloads", "plugin.tgz"))
	manifest := []byte(`{"dependencies":{"example-plugin":` + string(mustJSON(t, legacyPlugin)) + `,"registry-plugin":"1.2.3"}}`)
	lockfile := []byte("specifier: " + legacyPlugin + "\n")
	if err := os.WriteFile(filepath.Join(profile, "package.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "pnpm-lock.yaml"), lockfile, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := migrateLegacyProfilePaths(profile, legacyRoot, currentRoot); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"package.json", "pnpm-lock.yaml"} {
		data, err := os.ReadFile(filepath.Join(profile, name))
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		if strings.Contains(text, filepath.ToSlash(legacyRoot)) || !strings.Contains(text, filepath.ToSlash(currentRoot)) {
			t.Fatalf("%s was not migrated: %s", name, text)
		}
	}
}

func TestStageProfileDropsPositionDependentLockfile(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "current", "profiles", "web")
	target := filepath.Join(root, "transactions", "operation", "home", "profiles", "web")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := []byte(`{"dependencies":{"desktop":"file:C:/data/plugin/bundle"}}`)
	lockfile := []byte("resolution: {directory: ../../../plugin/bundle, type: directory}\n")
	if err := os.WriteFile(filepath.Join(source, "package.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "pnpm-lock.yaml"), lockfile, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := stageProfile(source, target); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(target, "package.json")); err != nil || string(data) != string(manifest) {
		t.Fatalf("staged manifest = %q, %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(target, "pnpm-lock.yaml")); !os.IsNotExist(err) {
		t.Fatalf("position-dependent lockfile was retained: %v", err)
	}
}

func mustJSON(t *testing.T, value string) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
