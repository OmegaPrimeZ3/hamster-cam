-- 0012_recap_entries.sql
-- Extend diary_entries to support AI-generated recap entries.
--
-- SQLite does not support modifying CHECK constraints in-place, so we
-- recreate the table. The new constraints add:
--   kind:     'recap' in addition to narrative/snapshot/timelapse
--   activity: 'recap' in addition to the existing set
--   ai_model: TEXT NULL — which model produced the recap (NULL = human/template)
--
-- Because SQLite cannot DROP CONSTRAINT we must:
--   1. Create a new table with the desired schema
--   2. Copy all existing rows
--   3. Drop the old table
--   4. Rename the new table

PRAGMA foreign_keys = OFF;

CREATE TABLE diary_entries_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at   INTEGER NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'narrative'
                  CHECK (kind IN ('narrative','snapshot','timelapse','recap')),
  activity      TEXT
                  CHECK (activity IS NULL OR activity IN (
                    'wheel','food','water','bathroom','resting',
                    'tunnel','exploring','hiding','transition',
                    'snapshot','timelapse','recap'
                  )),
  narrative     TEXT    NOT NULL,
  pet_name      TEXT,
  camera_id     INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
  from_camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
  to_camera_id   INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
  duration_ms   INTEGER,
  snapshot_id   INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
  media_path    TEXT,
  details       TEXT,
  ai_model      TEXT
);

INSERT INTO diary_entries_new (
  id, occurred_at, kind, activity, narrative, pet_name,
  camera_id, from_camera_id, to_camera_id,
  duration_ms, snapshot_id, media_path, details, ai_model
)
SELECT
  id, occurred_at, kind, activity, narrative, pet_name,
  camera_id, from_camera_id, to_camera_id,
  duration_ms, snapshot_id, media_path, details, NULL
FROM diary_entries;

DROP TABLE diary_entries;

ALTER TABLE diary_entries_new RENAME TO diary_entries;

CREATE INDEX idx_diary_occurred_at ON diary_entries(occurred_at DESC);
CREATE INDEX idx_diary_kind_time   ON diary_entries(kind, occurred_at DESC);
CREATE INDEX idx_diary_activity    ON diary_entries(activity, occurred_at DESC);

PRAGMA foreign_keys = ON;
