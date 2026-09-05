package backup

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
)

func TestPruneAllowsFewerBackupsThanKeepCount(t *testing.T) {
	paths := appconfig.NewPaths(t.TempDir())
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	manager := New(paths)
	backup, err := manager.Create("seed activation", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Prune(5); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(paths.Backups, backup.ID)); err != nil {
		t.Fatalf("kept backup is missing: %v", err)
	}
}
