package appconfig

import (
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
