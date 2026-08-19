package appconfig

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidCommitAndRuntimeOwnership(t *testing.T) {
	commit := "47f943859bef60e4160492346772ded9b24f765a"
	if !ValidCommit(commit) || ValidCommit(commit[:39]) || ValidCommit("G"+commit[1:]) {
		t.Fatal("commit validation accepted an invalid value")
	}
	root := t.TempDir()
	paths := NewPaths(root)
	if paths.Plugin != filepath.Join(root, "plugin") || paths.Marketplace != filepath.Join(root, "marketplace") {
		t.Fatalf("plugin and Marketplace paths were not separated: %#v", paths)
	}
	path, err := paths.Runtime(commit)
	if err != nil {
		t.Fatal(err)
	}
	if !IsOwnedPath(root, path) {
		t.Fatalf("expected %s to be owned by %s", path, root)
	}
	if IsOwnedPath(root, filepath.Dir(root)) || IsOwnedPath(root, root) {
		t.Fatal("path ownership allowed root escape")
	}
}

func TestMigrateLegacyRoot(t *testing.T) {
	base := t.TempDir()
	t.Setenv("DSH_DESKTOP_DATA_DIR", "")
	t.Setenv("XDG_CONFIG_HOME", base)
	oldRoot := filepath.Join(base, legacyAppDirName)
	if err := os.MkdirAll(filepath.Join(oldRoot, "state"), 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(oldRoot, "state", "active.json")
	if err := os.WriteFile(marker, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	migrated, err := MigrateLegacyRoot()
	if err != nil {
		t.Fatal(err)
	}
	if !migrated {
		t.Fatal("legacy data directory was not migrated")
	}
	if _, err := os.Stat(filepath.Join(base, AppDirName, "state", "active.json")); err != nil {
		t.Fatalf("migrated data is missing: %v", err)
	}
	if _, err := os.Stat(oldRoot); !os.IsNotExist(err) {
		t.Fatalf("legacy data directory still exists: %v", err)
	}
}
