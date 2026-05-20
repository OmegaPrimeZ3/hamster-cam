-- 0013_push.sql
-- Web Push notification infrastructure.
--
-- push_subscriptions: one row per browser/device that has subscribed. The
--   UNIQUE(endpoint) constraint means the same device can re-subscribe without
--   creating duplicate rows (handled via upsert in db.ts). Rows are
--   automatically removed when the referenced user is deleted (ON DELETE
--   CASCADE) or when the push gateway returns 410 Gone / 404.
--
-- notification_preferences: one row per user, created on first access with
--   sane defaults. Activities JSON array holds which activity strings the
--   user wants push notifications for. Quiet-hours use minute-of-day integers
--   (0–1439): quiet_start_minute defaults to 1260 (21:00), quiet_end_minute
--   to 420 (07:00).

CREATE TABLE push_subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT    NOT NULL,
  p256dh       TEXT    NOT NULL,
  auth         TEXT    NOT NULL,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE(endpoint)
);

CREATE INDEX idx_push_subs_user ON push_subscriptions(user_id);

CREATE TABLE notification_preferences (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled           INTEGER NOT NULL DEFAULT 1,
  activities        TEXT    NOT NULL DEFAULT '["wheel","food","water","resting","hiding"]',
  quiet_start_minute INTEGER NOT NULL DEFAULT 1260,
  quiet_end_minute   INTEGER NOT NULL DEFAULT 420,
  rare_only         INTEGER NOT NULL DEFAULT 1
);
