package update

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/state"
)

func TestPruneVersions(t *testing.T) {
	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	commits := []string{"1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222", "3333333333333333333333333333333333333333", "4444444444444444444444444444444444444444"}
	for _, c := range commits {
		if err := os.MkdirAll(filepath.Join(paths.Versions, c), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	snap := state.Snapshot{Active: &state.ActiveState{Current: state.RuntimeRef{Commit: commits[0]}, Previous: &state.RuntimeRef{Commit: commits[1]}}, Pending: &state.PendingState{RuntimeRef: state.RuntimeRef{Commit: commits[2]}}}
	if err := PruneVersions(paths, snap); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(paths.Versions, commits[3])); !os.IsNotExist(err) {
		t.Fatal("obsolete version was retained")
	}
	for _, c := range commits[:3] {
		if _, err := os.Stat(filepath.Join(paths.Versions, c)); err != nil {
			t.Fatalf("kept version %s missing: %v", c, err)
		}
	}
}
