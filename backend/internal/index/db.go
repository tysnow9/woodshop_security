package index

import (
	"database/sql"
	"fmt"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// DB wraps an SQLite connection for recording index operations.
type DB struct {
	sql *sql.DB
	mu  sync.Mutex
}

// RecordingRow is one row from the recordings table.
type RecordingRow struct {
	ID              int64
	Cam             string
	Serial          string
	Date            string
	StartTime       time.Time
	EndTime         time.Time
	FilePath        string
	Motion          bool
	SpritePath      string // empty string if NULL
	Faststart       bool
	FaststartFailed bool   // true = permanent failure, skip retries
}

// OpenDB opens (or creates) the SQLite database at path and applies the schema.
func OpenDB(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %q: %w", path, err)
	}

	// SQLite is single-writer; cap to one open connection to avoid SQLITE_BUSY.
	sqlDB.SetMaxOpenConns(1)

	if _, err := sqlDB.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return nil, fmt.Errorf("pragma journal_mode: %w", err)
	}
	if _, err := sqlDB.Exec("PRAGMA foreign_keys=ON"); err != nil {
		return nil, fmt.Errorf("pragma foreign_keys: %w", err)
	}
	if _, err := sqlDB.Exec(schema); err != nil {
		return nil, fmt.Errorf("apply schema: %w", err)
	}

	// Migration: add faststart_failed column to existing databases.
	// Silently ignored if the column already exists.
	_, _ = sqlDB.Exec(`ALTER TABLE recordings ADD COLUMN faststart_failed INTEGER NOT NULL DEFAULT 0`)

	return &DB{sql: sqlDB}, nil
}

// UpsertRecording inserts the row if file_path is new.
// Returns (id, true, nil) on insert, (id, false, nil) if already existed.
func (d *DB) UpsertRecording(r RecordingRow) (id int64, inserted bool, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	motionInt := 0
	if r.Motion {
		motionInt = 1
	}

	res, err := d.sql.Exec(`
		INSERT OR IGNORE INTO recordings
			(cam, serial, date, start_time, end_time, file_path, motion)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		r.Cam, r.Serial, r.Date,
		r.StartTime.Unix(), r.EndTime.Unix(),
		r.FilePath, motionInt,
	)
	if err != nil {
		return 0, false, fmt.Errorf("upsert recording: %w", err)
	}

	n, _ := res.RowsAffected()
	if n > 0 {
		id, _ = res.LastInsertId()
		return id, true, nil
	}

	// Already existed — fetch the existing id.
	err = d.sql.QueryRow(
		`SELECT id FROM recordings WHERE file_path = ?`, r.FilePath,
	).Scan(&id)
	if err != nil {
		return 0, false, fmt.Errorf("fetch existing id: %w", err)
	}
	return id, false, nil
}

// SetFaststartFailed marks a recording as permanently failed so the indexer
// never re-queues it. Used for corrupt files (e.g. moov atom not found).
func (d *DB) SetFaststartFailed(id int64) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	_, err := d.sql.Exec(
		`UPDATE recordings SET faststart_failed=1 WHERE id=?`, id,
	)
	return err
}

// SetFaststart marks a recording as faststart-processed and updates its file path.
func (d *DB) SetFaststart(id int64, filePath string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	_, err := d.sql.Exec(
		`UPDATE recordings SET faststart=1, file_path=? WHERE id=?`,
		filePath, id,
	)
	return err
}

// SetSprite sets the sprite path for a recording.
func (d *DB) SetSprite(id int64, spritePath string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	_, err := d.sql.Exec(
		`UPDATE recordings SET sprite_path=? WHERE id=?`,
		spritePath, id,
	)
	return err
}

// GetByID returns a single recording row.
func (d *DB) GetByID(id int64) (RecordingRow, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	row := d.sql.QueryRow(`SELECT
		id, cam, serial, date, start_time, end_time,
		file_path, motion, COALESCE(sprite_path,''), faststart, faststart_failed
		FROM recordings WHERE id=?`, id)

	return scanRow(row)
}

// ListByDate returns all recordings for a camera on a given date, ordered by start time.
func (d *DB) ListByDate(cam, date string) ([]RecordingRow, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	rows, err := d.sql.Query(`SELECT
		id, cam, serial, date, start_time, end_time,
		file_path, motion, COALESCE(sprite_path,''), faststart, faststart_failed
		FROM recordings WHERE cam=? AND date=? ORDER BY start_time ASC`,
		cam, date,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []RecordingRow
	for rows.Next() {
		r, err := scanRow(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

// ListDates returns distinct dates that have recordings for a camera, newest first.
func (d *DB) ListDates(cam string) ([]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	rows, err := d.sql.Query(
		`SELECT DISTINCT date FROM recordings WHERE cam=? ORDER BY date DESC`, cam,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var dates []string
	for rows.Next() {
		var date string
		if err := rows.Scan(&date); err != nil {
			return nil, err
		}
		dates = append(dates, date)
	}
	return dates, rows.Err()
}

// PruneByDate deletes recordings for a camera with date strictly before cutoffDate.
func (d *DB) PruneByDate(cam, cutoffDate string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	_, err := d.sql.Exec(
		`DELETE FROM recordings WHERE cam=? AND date < ?`, cam, cutoffDate,
	)
	return err
}

// scanner is satisfied by both *sql.Row and *sql.Rows.
type scanner interface {
	Scan(dest ...any) error
}

func scanRow(s scanner) (RecordingRow, error) {
	var r RecordingRow
	var startUnix, endUnix int64
	var motionInt, faststartInt, faststartFailedInt int

	if err := s.Scan(
		&r.ID, &r.Cam, &r.Serial, &r.Date,
		&startUnix, &endUnix,
		&r.FilePath, &motionInt, &r.SpritePath, &faststartInt, &faststartFailedInt,
	); err != nil {
		return RecordingRow{}, err
	}

	r.StartTime = time.Unix(startUnix, 0).UTC()
	r.EndTime = time.Unix(endUnix, 0).UTC()
	r.Motion = motionInt != 0
	r.Faststart = faststartInt != 0
	r.FaststartFailed = faststartFailedInt != 0
	return r, nil
}
