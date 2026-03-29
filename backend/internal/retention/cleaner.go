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
	// Cutoff is the start of day (UTC) exactly `days` ago.
	// Date dirs strictly before cutoff are deleted.
	cutoff := time.Now().UTC().Truncate(24 * time.Hour).AddDate(0, 0, -days)

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

func (c *Cleaner) sweepSerial(serialPath string, cutoff time.Time, days int) {
	dateDirs, err := os.ReadDir(serialPath)
	if err != nil {
		return
	}
	for _, entry := range dateDirs {
		if !entry.IsDir() {
			continue
		}
		t, err := time.Parse("2006-01-02", entry.Name())
		if err != nil {
			continue // not a date dir (e.g. DVRWorkDirectory); skip
		}
		if t.Before(cutoff) {
			dirPath := filepath.Join(serialPath, entry.Name())
			log.Printf("[retention] deleting %s (retention: %d days)", dirPath, days)
			if err := os.RemoveAll(dirPath); err != nil {
				log.Printf("[retention] failed to delete %s: %v", dirPath, err)
			}
		}
	}
}
