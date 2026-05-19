-- 0004_cameras.sql
-- Camera definitions — admin-managed via Settings → Cameras. The grid renders
-- in `position` order; `enabled = 0` rows stay configured but hidden.

CREATE TABLE cameras (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  emoji      TEXT    NOT NULL DEFAULT '📷',
  stream_url TEXT    NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_cameras_position ON cameras(position);
