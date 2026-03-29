package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Settings are the user-configurable values persisted to disk.
type Settings struct {
	RetentionDays int `json:"retentionDays"`
}

// Store is a thread-safe, file-backed settings store.
type Store struct {
	mu   sync.RWMutex
	path string
	data Settings
}

// Load reads settings from path. Missing file returns defaults; other errors
// are returned to the caller.
func Load(path string) (*Store, error) {
	s := &Store{
		path: path,
		data: Settings{RetentionDays: 7},
	}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s.data); err != nil {
		return nil, err
	}
	return s, nil
}

// Get returns a copy of the current settings.
func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.data
}

// Set replaces the current settings and writes them to disk atomically.
func (s *Store) Set(next Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0644); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	s.data = next
	return nil
}
