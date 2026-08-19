package marketplace

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
)

func TestCatalogVerifiesSignatureAndProjectsCompatibility(t *testing.T) {
	root := t.TempDir()
	paths := appconfig.NewPaths(filepath.Join(root, "data"))
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	marketRoot := filepath.Join(root, "market")
	if err := os.MkdirAll(filepath.Join(marketRoot, "catalog"), 0o700); err != nil {
		t.Fatal(err)
	}
	commit := strings.Repeat("a", 40)
	document := catalogDocument{SchemaVersion: 1, GeneratedAt: "2026-08-18T00:00:00Z"}
	entry := catalogPlugin{SchemaVersion: 1, ID: "example.tools", Name: "Tools", Description: "Example", Publisher: "Example", PackageName: "@example/tools", Permissions: []string{"network"}, License: "MIT", Verified: true}
	entry.Repository.ID = 1
	entry.Repository.URL = "https://github.com/example/tools"
	entry.Release.Version = "1.0.0"
	entry.Release.AssetURL = "https://github.com/example/tools/releases/download/v1.0.0/tools.tgz"
	entry.Release.SHA256 = strings.Repeat("1", 64)
	entry.Compatibility.HarnessCommits = []string{commit}
	document.Plugins = []catalogPlugin{entry}
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(marketRoot, "catalog", "catalog.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(private, data))
	if err := os.WriteFile(filepath.Join(marketRoot, "catalog", "catalog.sig"), []byte(signature), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DSH_DESKTOP_MARKETPLACE_DIR", marketRoot)
	m, err := New(Options{Paths: paths, TrustedCatalogKey: public})
	if err != nil {
		t.Fatal(err)
	}
	m.SetRuntime(filepath.Join(root, "runtime"), commit)
	snapshot, err := m.Catalog()
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.CatalogVerified {
		t.Fatal("catalog signature was not verified")
	}
	if len(snapshot.Plugins) != 1 || !snapshot.Plugins[0].Compatible || !snapshot.Plugins[0].Verified {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
}

func TestCatalogRejectsChangedSignedData(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{trustedCatalogKey: public}
	dir := t.TempDir()
	path := filepath.Join(dir, "catalog.json")
	if err := os.WriteFile(path, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(private, []byte("original")))
	if err := os.WriteFile(filepath.Join(dir, "catalog.sig"), []byte(signature), 0o600); err != nil {
		t.Fatal(err)
	}
	if m.verifyCatalog([]byte("changed"), path) {
		t.Fatal("changed catalog was accepted")
	}
}

func TestRefreshCatalogCachesVerifiedGitHubContentAndKeepsLastGoodCopy(t *testing.T) {
	root := t.TempDir()
	paths := appconfig.NewPaths(filepath.Join(root, "data"))
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	commit := strings.Repeat("a", 40)
	document := catalogDocument{SchemaVersion: 1, GeneratedAt: "2026-08-19T00:00:00Z"}
	entry := catalogPlugin{SchemaVersion: 1, ID: "example.tools", Name: "Tools", Description: "Example", Publisher: "Example", PackageName: "@example/tools", License: "MIT", Verified: true}
	entry.Repository.ID = 1
	entry.Repository.URL = "https://github.com/example/tools"
	entry.Release.Version = "1.0.0"
	entry.Release.AssetURL = "https://github.com/example/tools/releases/download/v1.0.0/tools.tgz"
	entry.Release.SHA256 = strings.Repeat("1", 64)
	entry.Compatibility.HarnessCommits = []string{commit}
	document.Plugins = []catalogPlugin{entry}
	catalog, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signature := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(private, catalog)) + "\n")
	valid := true
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Accept") != "application/vnd.github.raw+json" {
			t.Errorf("Accept = %q", request.Header.Get("Accept"))
		}
		switch request.URL.Path {
		case "/catalog.json":
			_, _ = response.Write(catalog)
		case "/catalog.sig":
			if valid {
				_, _ = response.Write(signature)
			} else {
				_, _ = response.Write([]byte("invalid"))
			}
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	newManager := func() *Manager {
		manager, err := New(Options{
			Paths: paths, TrustedCatalogKey: public,
			CatalogURL: server.URL + "/catalog.json", CatalogSignatureURL: server.URL + "/catalog.sig",
		})
		if err != nil {
			t.Fatal(err)
		}
		manager.SetRuntime(filepath.Join(root, "runtime"), commit)
		return manager
	}
	manager := newManager()
	if err := manager.RefreshCatalog(context.Background()); err != nil {
		t.Fatal(err)
	}
	snapshot, err := manager.Catalog()
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.CatalogVerified || len(snapshot.Plugins) != 1 || !snapshot.Plugins[0].Compatible {
		t.Fatalf("unexpected remote snapshot: %+v", snapshot)
	}

	valid = false
	manager = newManager()
	if err := manager.RefreshCatalog(context.Background()); err == nil {
		t.Fatal("invalid replacement signature was accepted")
	}
	snapshot, err = manager.Catalog()
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.CatalogVerified || len(snapshot.Plugins) != 1 {
		t.Fatalf("last verified catalog was not retained: %+v", snapshot)
	}
}

func TestBeginAllowsUninstallOfIncompatibleInstalledPlugin(t *testing.T) {
	root := t.TempDir()
	paths := appconfig.NewPaths(filepath.Join(root, "data"))
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	marketRoot := filepath.Join(root, "market")
	if err := os.MkdirAll(filepath.Join(marketRoot, "catalog"), 0o700); err != nil {
		t.Fatal(err)
	}
	entry := catalogPlugin{SchemaVersion: 1, ID: "legacy.tools", Name: "Legacy Tools", Description: "Example", Publisher: "Example", PackageName: "@example/legacy-tools", License: "MIT"}
	entry.Repository.ID = 1
	entry.Repository.URL = "https://github.com/example/legacy-tools"
	entry.Release.Version = "1.0.0"
	entry.Release.AssetURL = "https://github.com/example/legacy-tools/releases/download/v1.0.0/legacy-tools.tgz"
	entry.Release.SHA256 = strings.Repeat("1", 64)
	entry.Compatibility.HarnessCommits = []string{strings.Repeat("a", 40)}
	document := catalogDocument{SchemaVersion: 1, GeneratedAt: "2026-08-18T00:00:00Z", Plugins: []catalogPlugin{entry}}
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(marketRoot, "catalog", "catalog.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	installedDir := filepath.Join(paths.HarnessHome, "profiles", "web", "node_modules", "@example", "legacy-tools")
	if err := os.MkdirAll(installedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installedDir, "package.json"), []byte(`{"version":"0.9.0"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DSH_DESKTOP_MARKETPLACE_DIR", marketRoot)
	t.Setenv("DSH_DESKTOP_MARKETPLACE_ALLOW_UNSIGNED", "1")
	m, err := New(Options{Paths: paths})
	if err != nil {
		t.Fatal(err)
	}
	m.SetRuntime(filepath.Join(root, "missing-runtime"), strings.Repeat("b", 40))
	operation, err := m.Begin(MutationRequest{PluginID: entry.ID, Action: Uninstall})
	if err != nil {
		t.Fatalf("incompatible installed plugin could not be uninstalled: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		current, ok := m.Operation(operation.ID)
		if ok && current.terminal() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("uninstall operation did not finish")
}
