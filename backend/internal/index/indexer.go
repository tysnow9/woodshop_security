package index

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type workItemKind int

const (
	workFaststart workItemKind = iota
	workSprite
)

type workItem struct {
	kind  workItemKind
	rowID int64
	path  string
}

// Indexer scans the NVR directory tree, inserts discovered recordings into the
// DB, and queues background faststart + sprite generation work.
type Indexer struct {
	nvrDir       string
	db           *DB
	getRetention func() int
	workCh       chan workItem
	wg           sync.WaitGroup
}

var dateRegexp = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// NewIndexer creates an Indexer. getRetention is called each scan cycle to
// determine the retention window (0 = disabled).
func NewIndexer(nvrDir string, db *DB, getRetention func() int) *Indexer {
	return &Indexer{
		nvrDir:       nvrDir,
		db:           db,
		getRetention: getRetention,
		workCh:       make(chan workItem, 64),
	}
}

// Start runs an initial full scan, then polls every 60 seconds.
// Launches 2 background worker goroutines. Respects ctx cancellation.
func (ix *Indexer) Start(ctx context.Context) {
	for i := 0; i < 2; i++ {
		ix.wg.Add(1)
		go func() {
			defer ix.wg.Done()
			ix.runWorker(ctx)
		}()
	}

	go func() {
		ix.fullScan(ctx)
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				// Drain workCh so workers can exit cleanly.
				close(ix.workCh)
				ix.wg.Wait()
				return
			case <-ticker.C:
				ix.fullScan(ctx)
			}
		}
	}()
}

func (ix *Indexer) fullScan(ctx context.Context) {
	camEntries, err := os.ReadDir(ix.nvrDir)
	if err != nil {
		log.Printf("[indexer] ReadDir %s: %v", ix.nvrDir, err)
		return
	}

	for _, camEntry := range camEntries {
		if !camEntry.IsDir() || strings.HasPrefix(camEntry.Name(), ".") {
			continue
		}
		cam := camEntry.Name()
		camPath := filepath.Join(ix.nvrDir, cam)

		serialEntries, err := os.ReadDir(camPath)
		if err != nil {
			log.Printf("[indexer] ReadDir %s: %v", camPath, err)
			continue
		}

		for _, serialEntry := range serialEntries {
			if !serialEntry.IsDir() || serialEntry.Name() == "DVRWorkDirectory" {
				continue
			}
			serial := serialEntry.Name()
			serialPath := filepath.Join(camPath, serial)

			dateEntries, err := os.ReadDir(serialPath)
			if err != nil {
				log.Printf("[indexer] ReadDir %s: %v", serialPath, err)
				continue
			}

			for _, dateEntry := range dateEntries {
				if !dateEntry.IsDir() || !dateRegexp.MatchString(dateEntry.Name()) {
					continue
				}
				date := dateEntry.Name()
				datePath := filepath.Join(serialPath, date)

				chanEntries, err := os.ReadDir(datePath)
				if err != nil {
					log.Printf("[indexer] ReadDir %s: %v", datePath, err)
					continue
				}

				for _, chanEntry := range chanEntries {
					if !chanEntry.IsDir() {
						continue
					}
					davPath := filepath.Join(datePath, chanEntry.Name(), "dav")
					if _, err := os.Stat(davPath); err != nil {
						continue
					}

					hourEntries, err := os.ReadDir(davPath)
					if err != nil {
						log.Printf("[indexer] ReadDir %s: %v", davPath, err)
						continue
					}

					for _, hourEntry := range hourEntries {
						if !hourEntry.IsDir() {
							continue
						}
						hourPath := filepath.Join(davPath, hourEntry.Name())

						fileEntries, err := os.ReadDir(hourPath)
						if err != nil {
							log.Printf("[indexer] ReadDir %s: %v", hourPath, err)
							continue
						}

						for _, fileEntry := range fileEntries {
							if !fileEntry.Type().IsRegular() {
								continue
							}
							name := fileEntry.Name()
							if !strings.HasSuffix(name, ".mp4") {
								continue // skips .mp4_, .idx, .sprite.jpg
							}
							fullPath := filepath.Join(hourPath, name)
							ix.processFile(ctx, cam, serial, date, fullPath, name)
						}
					}
				}
			}
		}

		// Prune DB rows beyond retention window.
		if retention := ix.getRetention(); retention > 0 {
			cutoff := time.Now().AddDate(0, 0, -retention).Format("2006-01-02")
			if err := ix.db.PruneByDate(cam, cutoff); err != nil {
				log.Printf("[indexer] prune cam=%s: %v", cam, err)
			}
		}
	}
}

func (ix *Indexer) processFile(ctx context.Context, cam, serial, date, fullPath, filename string) {
	info, err := parseSegmentFilename(date, filename)
	if err != nil {
		log.Printf("[indexer] parse %q: %v", filename, err)
		return
	}

	row := RecordingRow{
		Cam:      cam,
		Serial:   serial,
		Date:     date,
		StartTime: info.StartTime,
		EndTime:   info.EndTime,
		FilePath:  fullPath,
		Motion:    info.Motion,
	}

	id, inserted, err := ix.db.UpsertRecording(row)
	if err != nil {
		log.Printf("[indexer] upsert %q: %v", fullPath, err)
		return
	}

	if inserted {
		// New file — queue faststart first.
		ix.enqueue(ctx, workItem{kind: workFaststart, rowID: id, path: fullPath})
		return
	}

	// Already in DB — check if work is still outstanding.
	existing, err := ix.db.GetByID(id)
	if err != nil {
		return
	}
	if existing.FaststartFailed {
		return // permanent failure — never retry
	}
	if !existing.Faststart {
		ix.enqueue(ctx, workItem{kind: workFaststart, rowID: id, path: fullPath})
	} else if existing.SpritePath == "" {
		ix.enqueue(ctx, workItem{kind: workSprite, rowID: id, path: fullPath})
	}
}

func (ix *Indexer) enqueue(ctx context.Context, item workItem) {
	select {
	case ix.workCh <- item:
	case <-ctx.Done():
	default:
		// Channel full — scan goroutine must not block or it can't reach later cameras.
		// The next 60s scan cycle will re-enqueue unprocessed files.
	}
}

func (ix *Indexer) runWorker(ctx context.Context) {
	for item := range ix.workCh {
		if ctx.Err() != nil {
			return
		}

		switch item.kind {
		case workFaststart:
			// Cameras write moov at the END of the file (ftyp→free→[mdat...]→moov).
			// runFaststart rewrites to moov-first so browsers can seek immediately.
			// Confirmed needed: files without faststart fail to play in browser.
			if err := runFaststart(ctx, item.path); err != nil {
				log.Printf("[indexer] faststart %q: %v", item.path, err)
				if dbErr := ix.db.SetFaststartFailed(item.rowID); dbErr != nil {
					log.Printf("[indexer] SetFaststartFailed id=%d: %v", item.rowID, dbErr)
				}
				continue
			}
			if err := ix.db.SetFaststart(item.rowID, item.path); err != nil {
				log.Printf("[indexer] SetFaststart id=%d: %v", item.rowID, err)
				continue
			}
			// Queue sprite.
			ix.enqueue(ctx, workItem{kind: workSprite, rowID: item.rowID, path: item.path})

		case workSprite:
			spritePath, err := generateSprite(ctx, item.path)
			if err != nil {
				log.Printf("[indexer] sprite %q: %v", item.path, err)
				continue
			}
			if err := ix.db.SetSprite(item.rowID, spritePath); err != nil {
				log.Printf("[indexer] SetSprite id=%d: %v", item.rowID, err)
			}
		}
	}
}
