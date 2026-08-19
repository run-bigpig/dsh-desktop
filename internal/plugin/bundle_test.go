package plugin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
)

func TestRewriteManagedBundleSpecsPreservesProfileAndMigratesOnlyManagedPackages(t *testing.T) {
	directory := t.TempDir()
	manifest := filepath.Join(directory, "package.json")
	original := []byte(`{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh-desktop-marketplace-host": "file:C:/old/host-0.1.0.tgz",
    "@deepseek-ai/dsh-desktop-marketplace-client": "file:C:/old/client-0.1.0.tgz",
    "@deepseek-ai/dsh-desktop-marketplace": "file:C:/old/bundle-0.1.0.tgz",
    "@run-bigpig/dsh-desktop-marketplace-host": "file:C:/old-run-bigpig/host-0.1.9.tgz",
    "@run-bigpig/dsh-desktop-marketplace-client": "file:C:/old-run-bigpig/client-0.1.9.tgz",
    "@run-bigpig/dsh-desktop-marketplace": "file:C:/old-run-bigpig/bundle-0.1.9.tgz",
    "example-plugin": "1.2.3"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-desktop-marketplace", "example-plugin"] } }
}
`)
	if err := os.WriteFile(manifest, original, 0o600); err != nil {
		t.Fatal(err)
	}
	artifacts := []string{
		filepath.Join(directory, "plugin-host.tgz"),
		filepath.Join(directory, "plugin-client.tgz"),
		filepath.Join(directory, "plugin-bundle.tgz"),
	}
	backup, changed, err := rewriteManagedBundleSpecs(manifest, artifacts)
	if err != nil {
		t.Fatal(err)
	}
	if !changed || string(backup) != string(original) {
		t.Fatalf("migration result changed=%v backupMatches=%v", changed, string(backup) == string(original))
	}
	var document struct {
		Dependencies map[string]string `json:"dependencies"`
		DSH          map[string]any    `json:"dsh"`
	}
	data, err := os.ReadFile(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	for index, packageName := range managedBundlePackages {
		expected := "file:" + filepath.ToSlash(artifacts[index])
		if document.Dependencies[packageName] != expected {
			t.Fatalf("dependency %s = %q, want %q", packageName, document.Dependencies[packageName], expected)
		}
		for _, legacyPackages := range legacyManagedBundlePackageSets {
			if _, ok := document.Dependencies[legacyPackages[index]]; ok {
				t.Fatalf("legacy dependency %s was retained", legacyPackages[index])
			}
		}
	}
	if document.Dependencies["example-plugin"] != "1.2.3" || document.DSH["profile"] == nil {
		t.Fatal("migration changed unrelated profile fields")
	}
	profile := document.DSH["profile"].(map[string]any)
	bundles := profile["bundles"].([]any)
	if bundles[0] != "@deepseek-ai/dsh-base" || bundles[1] != managedBundlePackages[2] || bundles[2] != "example-plugin" {
		t.Fatalf("unexpected migrated bundles: %#v", bundles)
	}
}

func TestPublishBundleArtifactsUsesPluginDirectoryAndRemovesLegacyBundle(t *testing.T) {
	paths := appconfig.NewPaths(t.TempDir())
	legacyDirectory := filepath.Join(paths.Marketplace, "bundle")
	if err := os.MkdirAll(legacyDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacyDirectory, "old.tgz"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	sources := make([]string, len(stableBundleArtifacts))
	for index := range sources {
		sources[index] = filepath.Join(t.TempDir(), stableBundleArtifacts[index])
		if err := os.WriteFile(sources[index], []byte("plugin"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	targets, err := (&Manager{paths: paths}).publishBundleArtifacts(sources)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		if !appconfig.IsOwnedPath(paths.Plugin, target) {
			t.Fatalf("published artifact escaped plugin directory: %s", target)
		}
	}
	if _, err := os.Stat(legacyDirectory); !os.IsNotExist(err) {
		t.Fatalf("legacy Marketplace bundle directory still exists: %v", err)
	}
}
