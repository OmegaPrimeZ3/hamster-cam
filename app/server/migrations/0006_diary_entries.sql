-- 0006_diary_entries.sql
-- The activity feed — narrator output. Three `kind` variants:
--   'narrative' — text-only entry (default; from MQTT events via narrator.ts)
--   'snapshot'  — manual capture; media_path points at an image
--   'timelapse' — nightly highlight reel; media_path points at the MP4
-- Transitions (cross-camera coalesced journeys) use kind = 'narrative' too;
-- the template family is encoded inside `narrative`.

CREATE TABLE diary_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at   INTEGER NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'narrative'
                  CHECK (kind IN ('narrative','snapshot','timelapse')),
  activity      TEXT,                                  -- 'wheel'|'food'|'water'|'bathroom'|'resting'|'exploring'|'hiding'|'transition'|'snapshot'|'timelapse'
  narrative     TEXT    NOT NULL,                      -- rendered sentence, e.g. "🎡 Peanut went for a run..."
  pet_name      TEXT,                                  -- snapshot of pet name at write time (so a rename doesn't rewrite history)
  camera_id     INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
  from_camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,  -- only set for transition entries
  to_camera_id   INTEGER REFERENCES cameras(id) ON DELETE SET NULL,  -- only set for transition entries
  duration_ms   INTEGER,                               -- only set for activities with a duration
  snapshot_id   INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
  media_path    TEXT,                                  -- relative path under STORAGE_PATH, populated for snapshot + timelapse
  details       TEXT                                   -- optional JSON payload with raw frigate event for debugging
);

CREATE INDEX idx_diary_occurred_at ON diary_entries(occurred_at DESC);
CREATE INDEX idx_diary_kind_time   ON diary_entries(kind, occurred_at DESC);
CREATE INDEX idx_diary_activity    ON diary_entries(activity, occurred_at DESC);
