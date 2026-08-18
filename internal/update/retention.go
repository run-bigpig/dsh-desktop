package update

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/deepseek-ai/deepseek-harness-desktop/internal/appconfig"
	"github.com/deepseek-ai/deepseek-harness-desktop/internal/state"
)

func PruneVersions(paths appconfig.Paths, snapshot state.Snapshot) error {
	keep := map[string]bool{}
	if snapshot.Active != nil {
		keep[snapshot.Active.Current.Commit] = true
		if snapshot.Active.Previous != nil {
			keep[snapshot.Active.Previous.Commit] = true
		}
	}
	if snapshot.Pending != nil {
		keep[snapshot.Pending.Commit] = true
	}
	entries, err := os.ReadDir(paths.Versions)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || keep[entry.Name()] {
			continue
		}
		if !appconfig.ValidCommit(entry.Name()) && !strings.HasPrefix(entry.Name(), ".staging-") {
			continue
		}
		path := filepath.Join(paths.Versions, entry.Name())
		if !appconfig.IsOwnedPath(paths.Versions, path) {
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	return nil
}
