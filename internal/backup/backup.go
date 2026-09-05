package backup

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/run-bigpig/dsh-desktop/internal/appconfig"
	"github.com/run-bigpig/dsh-desktop/internal/state"
)

type Info struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	Reason    string    `json:"reason"`
	Commit    string    `json:"commit,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type Manager struct{ paths appconfig.Paths }

func New(paths appconfig.Paths) *Manager { return &Manager{paths: paths} }

func (m *Manager) Create(reason, commit string) (Info, error) {
	now := time.Now().UTC()
	id := now.Format("20060102T150405.000000000Z")
	dest := filepath.Join(m.paths.Backups, id)
	data := filepath.Join(dest, "harness-home")
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return Info{}, err
	}
	if _, err := os.Stat(m.paths.HarnessHome); err == nil {
		if err := copyTree(m.paths.HarnessHome, data); err != nil {
			return Info{}, err
		}
	} else if !os.IsNotExist(err) {
		return Info{}, err
	}
	info := Info{ID: id, Path: dest, Reason: reason, Commit: commit, CreatedAt: now}
	if err := state.AtomicWriteJSON(filepath.Join(dest, "backup.json"), info); err != nil {
		return Info{}, err
	}
	return info, nil
}

func (m *Manager) Restore(id string) error {
	if strings.ContainsAny(id, `/\\`) || id == "" {
		return fmt.Errorf("invalid backup id")
	}
	source := filepath.Join(m.paths.Backups, id, "harness-home")
	if !appconfig.IsOwnedPath(m.paths.Backups, source) {
		return fmt.Errorf("backup path escapes backup root")
	}
	if _, err := os.Stat(source); err != nil {
		return err
	}
	old := m.paths.HarnessHome + ".restore-old"
	_ = os.RemoveAll(old)
	if _, err := os.Stat(m.paths.HarnessHome); err == nil {
		if err := os.Rename(m.paths.HarnessHome, old); err != nil {
			return err
		}
	}
	if err := copyTree(source, m.paths.HarnessHome); err != nil {
		_ = os.RemoveAll(m.paths.HarnessHome)
		_ = os.Rename(old, m.paths.HarnessHome)
		return err
	}
	_ = os.RemoveAll(old)
	return nil
}

func (m *Manager) List() ([]Info, error) {
	entries, err := os.ReadDir(m.paths.Backups)
	if err != nil {
		return nil, err
	}
	var result []Info
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(m.paths.Backups, e.Name(), "backup.json"))
		if err != nil {
			continue
		}
		var info Info
		if json.Unmarshal(b, &info) == nil {
			result = append(result, info)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.After(result[j].CreatedAt) })
	return result, nil
}

func (m *Manager) Prune(keep int) error {
	list, err := m.List()
	if err != nil {
		return err
	}
	if keep < 0 {
		keep = 0
	}
	if keep >= len(list) {
		return nil
	}
	for _, item := range list[keep:] {
		if !appconfig.IsOwnedPath(m.paths.Backups, item.Path) {
			continue
		}
		if err := os.RemoveAll(item.Path); err != nil {
			return err
		}
	}
	return nil
}

func copyTree(source, dest string) error {
	return filepath.WalkDir(source, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		if d.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if info.Mode()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, in)
		syncErr := out.Sync()
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if syncErr != nil {
			return syncErr
		}
		return closeErr
	})
}
