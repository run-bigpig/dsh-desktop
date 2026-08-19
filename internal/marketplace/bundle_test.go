package marketplace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRewriteManagedBundleSpecsPreservesProfileAndMigratesOnlyManagedPackages(t *testing.T) {
	directory := t.TempDir()
	manifest := filepath.Join(directory, "package.json")
	original := []byte(`{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@run-bigpig/dsh-desktop-marketplace-host": "file:C:/old/host-0.1.0.tgz",
    "@run-bigpig/dsh-desktop-marketplace-client": "file:C:/old/client-0.1.0.tgz",
    "@run-bigpig/dsh-desktop-marketplace": "file:C:/old/bundle-0.1.0.tgz",
    "example-plugin": "1.2.3"
  },
  "dsh": { "profile": { "bundles": ["@run-bigpig/dsh-desktop-marketplace"] } }
}
`)
	if err := os.WriteFile(manifest, original, 0o600); err != nil {
		t.Fatal(err)
	}
	artifacts := []string{
		filepath.Join(directory, "marketplace-host.tgz"),
		filepath.Join(directory, "marketplace-client.tgz"),
		filepath.Join(directory, "marketplace-bundle.tgz"),
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
	}
	if document.Dependencies["example-plugin"] != "1.2.3" || document.DSH["profile"] == nil {
		t.Fatal("migration changed unrelated profile fields")
	}
}
