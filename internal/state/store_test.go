package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWriteAndReload(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)
	active := ActiveState{Current: RuntimeRef{Commit: "47f943859bef60e4160492346772ded9b24f765a"}}
	if err := store.SaveActive(active); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "active.json.tmp")); !os.IsNotExist(err) {
		t.Fatalf("temporary state file remained: %v", err)
	}
	reloaded := NewStore(dir)
	if err := reloaded.Load(); err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Snapshot().Active; got == nil || got.Current.Commit != active.Current.Commit {
		t.Fatalf("unexpected active state: %#v", got)
	}
}
