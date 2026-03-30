package index

const schema = `
CREATE TABLE IF NOT EXISTS recordings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cam         TEXT    NOT NULL,
    serial      TEXT    NOT NULL,
    date        TEXT    NOT NULL,
    start_time  INTEGER NOT NULL,
    end_time    INTEGER NOT NULL,
    file_path   TEXT    NOT NULL UNIQUE,
    motion      INTEGER NOT NULL DEFAULT 0,
    sprite_path TEXT,
    faststart   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_recordings_cam_date
    ON recordings (cam, date);

CREATE INDEX IF NOT EXISTS idx_recordings_cam_range
    ON recordings (cam, start_time, end_time);
`
