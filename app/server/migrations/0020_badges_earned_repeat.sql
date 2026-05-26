-- 0020_badges_earned_repeat.sql
-- Rebuild badges_earned to support repeat-earning.
--
-- OLD schema: badge_id TEXT PRIMARY KEY, earned_at INTEGER
--   → one row per badge, ever. INSERT OR IGNORE silently discards repeat earns.
--
-- NEW schema: auto-increment id + UNIQUE(badge_id, earned_day)
--   → one row per badge per local calendar day (YYYY-MM-DD).
--   Daily badges (marathon, foodie, night_owl, early_bird, hat_trick) earn once
--   per local day and accumulate a count. Once-ever badges (first_day,
--   memory_keeper, mile_high, marathon_club, ultra) keep their UNIQUE row via
--   the application-layer policy in db.earnBadge().
--
-- Migration strategy (rename-create-copy-drop as used by 0012):
--   1. Create the new table
--   2. Copy existing rows, computing earned_day from earned_at using localtime
--   3. Drop the old table
--   4. Rename

PRAGMA foreign_keys = OFF;

CREATE TABLE badges_earned_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  badge_id   TEXT    NOT NULL,
  earned_at  INTEGER NOT NULL,
  earned_day TEXT    NOT NULL,
  UNIQUE(badge_id, earned_day)
);

INSERT INTO badges_earned_new (badge_id, earned_at, earned_day)
SELECT
  badge_id,
  earned_at,
  date(earned_at / 1000, 'unixepoch', 'localtime') AS earned_day
FROM badges_earned;

DROP TABLE badges_earned;

ALTER TABLE badges_earned_new RENAME TO badges_earned;

CREATE INDEX idx_badges_badge_id ON badges_earned(badge_id);

PRAGMA foreign_keys = ON;
