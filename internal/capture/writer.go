package capture

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Stats summarizes what a Write actually persisted.
type Stats struct {
	Sessions int
	Packets  int
}

// Write serializes the capture to filename atomically (temp file + rename), so a
// reader never observes a half-written document. That includes a UI watching the
// file.
func (sc *SessionCapture) Write(filename string) (Stats, error) {
	data, stats, err := sc.marshal()
	if err != nil {
		return stats, fmt.Errorf("serialize capture: %w", err)
	}

	dir := filepath.Dir(filename)
	if dir == "" {
		dir = "."
	}
	tmp, err := os.CreateTemp(dir, ".capture-*.tmp")
	if err != nil {
		return stats, fmt.Errorf("create temp capture file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename below succeeds

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return stats, fmt.Errorf("write temp capture file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return stats, fmt.Errorf("close temp capture file: %w", err)
	}
	if err := os.Rename(tmpName, filename); err != nil {
		return stats, fmt.Errorf("rename temp capture file into place: %w", err)
	}

	return stats, nil
}

// marshal takes a consistent snapshot of the whole capture. Every session has
// its own mutex for its Packets slice, so all of them are held for the duration
// of the encode. Otherwise a live session could append mid-marshal.
func (sc *SessionCapture) marshal() ([]byte, Stats, error) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	for _, s := range sc.Sessions {
		s.mu.Lock()
	}
	defer func() {
		for _, s := range sc.Sessions {
			s.mu.Unlock()
		}
	}()

	stats := Stats{Sessions: len(sc.Sessions)}
	for _, s := range sc.Sessions {
		stats.Packets += len(s.Packets)
	}

	data, err := json.MarshalIndent(sc, "", "  ")
	return data, stats, err
}
