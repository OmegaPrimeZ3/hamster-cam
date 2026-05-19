-- 0005_snapshots.sql
-- Single still frames — both Frigate-event thumbnails and manual
-- "Take a photo!" captures from the maximized view. Source frames for the
-- nightly timelapse job (jobs/timelapse.ts) and feeders for diary entries.

CREATE TABLE snapshots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  taken_at  INTEGER NOT NULL,
  path      TEXT    NOT NULL
);

CREATE INDEX idx_snapshots_camera_time ON snapshots(camera_id, taken_at DESC);
CREATE INDEX idx_snapshots_taken_at    ON snapshots(taken_at DESC);
