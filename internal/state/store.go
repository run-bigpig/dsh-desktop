package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Store struct {
	dir      string
	mu       sync.RWMutex
	snapshot Snapshot
}

func NewStore(dir string) *Store {
	return &Store{dir: dir, snapshot: Snapshot{Phase: Idle, UpdatedAt: time.Now()}}
}

func (s *Store) Snapshot() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := s.snapshot
	if s.snapshot.Active != nil {
		active := *s.snapshot.Active
		if active.Previous != nil {
			previous := *active.Previous
			active.Previous = &previous
		}
		result.Active = &active
	}
	if s.snapshot.Pending != nil {
		pending := *s.snapshot.Pending
		result.Pending = &pending
	}
	if s.snapshot.AvailableUpdate != nil {
		available := *s.snapshot.AvailableUpdate
		result.AvailableUpdate = &available
	}
	return result
}

func (s *Store) SetRuntimeInfo(phase Phase, message, url string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot.Phase, s.snapshot.Message, s.snapshot.HarnessURL, s.snapshot.UpdatedAt = phase, message, url, time.Now()
}

func (s *Store) SetContext(dataDir, logsDir string, dev bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot.DataDirectory, s.snapshot.LogsDirectory, s.snapshot.DeveloperMode = dataDir, logsDir, dev
	s.snapshot.UnverifiedUpdates, s.snapshot.UpdatedAt = false, time.Now()
}

func (s *Store) SetDesktopVersion(version string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot.DesktopVersion, s.snapshot.UpdatedAt = version, time.Now()
}

func (s *Store) SetAvailableUpdate(update *DesktopUpdate) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if update == nil {
		s.snapshot.AvailableUpdate = nil
	} else {
		copy := *update
		s.snapshot.AvailableUpdate = &copy
	}
	s.snapshot.UpdatedAt = time.Now()
}

func (s *Store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	active, err := readJSON[ActiveState](filepath.Join(s.dir, "active.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("load active state: %w", err)
	}
	pending, err := readJSON[PendingState](filepath.Join(s.dir, "pending.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("load pending state: %w", err)
	}
	if active != nil {
		s.snapshot.Active = active
	}
	if pending != nil {
		s.snapshot.Pending = pending
		s.snapshot.Phase = Pending
	}
	return nil
}

func (s *Store) SaveActive(v ActiveState) error {
	if err := AtomicWriteJSON(filepath.Join(s.dir, "active.json"), v); err != nil {
		return err
	}
	s.mu.Lock()
	s.snapshot.Active = &v
	s.snapshot.UpdatedAt = time.Now()
	s.mu.Unlock()
	return nil
}

func (s *Store) SavePending(v PendingState) error {
	if err := AtomicWriteJSON(filepath.Join(s.dir, "pending.json"), v); err != nil {
		return err
	}
	s.mu.Lock()
	s.snapshot.Pending = &v
	s.snapshot.Phase = Pending
	s.snapshot.UpdatedAt = time.Now()
	s.mu.Unlock()
	return nil
}

func (s *Store) ClearPending() error {
	err := os.Remove(filepath.Join(s.dir, "pending.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	s.mu.Lock()
	s.snapshot.Pending = nil
	s.snapshot.UpdatedAt = time.Now()
	s.mu.Unlock()
	return nil
}

func readJSON[T any](path string) (*T, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

func AtomicWriteJSON(path string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return AtomicWriteFile(path, b, 0o600)
}

func AtomicWriteFile(path string, data []byte, permissions fs.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path+".tmp", os.O_WRONLY|os.O_CREATE|os.O_TRUNC, permissions)
	if err != nil {
		return err
	}
	cleanup := func(e error) error { _ = f.Close(); _ = os.Remove(path + ".tmp"); return e }
	if _, err := f.Write(data); err != nil {
		return cleanup(err)
	}
	if err := f.Sync(); err != nil {
		return cleanup(err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path + ".tmp")
		return err
	}
	if err := atomicReplace(path+".tmp", path); err != nil {
		_ = os.Remove(path + ".tmp")
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
