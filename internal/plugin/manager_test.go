package plugin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
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

func TestProfileVirtualStoreReusesInstalledMetadata(t *testing.T) {
	paths := appconfig.NewPaths(t.TempDir())
	profile := filepath.Join(paths.HarnessHome, "profiles", "web")
	modules := filepath.Join(profile, "node_modules")
	if err := os.MkdirAll(modules, 0o700); err != nil {
		t.Fatal(err)
	}
	existing := filepath.Join(paths.Marketplace, "virtual-stores", "existing")
	metadata := []byte(`{"virtualStoreDir":` + string(mustJSON(t, existing)) + `}`)
	if err := os.WriteFile(filepath.Join(modules, ".modules.yaml"), metadata, 0o600); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{paths: paths}
	if got := manager.profileVirtualStore(profile); got != existing {
		t.Fatalf("profile virtual store = %q, want %q", got, existing)
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
