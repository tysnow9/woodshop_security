package retention

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"time"
)

// Cleaner deletes date directories under nvrDir that are older than the
// configured retention window. It runs once at startup and then every hour.
//
// Expected layout:
//
//	<nvrDir>/
//	  cam1/<serial>/2026-03-28/...
//	  cam2/<serial>/2026-03-28/...
type Cleaner struct {
	nvrDir       string
	getRetention func() int // called each run so live changes take effect
}

// New creates a Cleaner. getRetention is called on every sweep so that
// in-process settings changes are picked up without a restart.
func New(nvrDir string, getRetention func() int) *Cleaner {
	return &Cleaner{nvrDir: nvrDir, getRetention: getRetention}
}

// Start runs the first sweep immediately, then every hour, until ctx is done.
func (c *Cleaner) Start(ctx context.Context) {
	go func() {
		c.sweep()
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				c.sweep()
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (c *Cleaner) sweep() {
	days := c.getRetention()
	if days == 0 {
		return // retention disabled — keep everything
	}
	// Cutoff is expressed as a local date string (YYYY-MM-DD) because recording
	// directory names are in local time. Date dirs with names strictly less than
	// the cutoff string are deleted. Using local time matches the indexer's prune
	// logic so both always agree on what to delete.
	now := time.Now()
	y, m, d := now.Date()
	cutoff := time.Date(y, m, d, 0, 0, 0, 0, time.Local).AddDate(0, 0, -days).Format("2006-01-02")

	camDirs, err := os.ReadDir(c.nvrDir)
	if err != nil {
		log.Printf("[retention] read %s: %v", c.nvrDir, err)
		return
	}

	for _, camEntry := range camDirs {
		if !camEntry.IsDir() {
			continue
		}
		serialDirs, err := os.ReadDir(filepath.Join(c.nvrDir, camEntry.Name()))
		if err != nil {
			log.Printf("[retention] read %s: %v", filepath.Join(c.nvrDir, camEntry.Name()), err)
			continue
		}
		for _, serialEntry := range serialDirs {
			if !serialEntry.IsDir() {
				continue
			}
			serialPath := filepath.Join(c.nvrDir, camEntry.Name(), serialEntry.Name())
			c.sweepSerial(serialPath, cutoff, days)
		}
	}
}

func (c *Cleaner) sweepSerial(serialPath string, cutoff string, days int) {
	dateDirs, err := os.ReadDir(serialPath)
	if err != nil {
		return
	}
	for _, entry := range dateDirs {
		if !entry.IsDir() {
			continue
		}
		// Skip non-date dirs (e.g. DVRWorkDirectory). Date dirs are YYYY-MM-DD,
		// which sort lexicographically — no need to parse to time.Time.
		name := entry.Name()
		if len(name) != 10 || name[4] != '-' || name[7] != '-' {
			continue
		}
		if name < cutoff {
			dirPath := filepath.Join(serialPath, name)
			log.Printf("[retention] deleting %s (retention: %d days)", dirPath, days)
			if err := os.RemoveAll(dirPath); err != nil {
				log.Printf("[retention] failed to delete %s: %v", dirPath, err)
			}
		}
	}
}
