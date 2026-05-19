-- 0007_badges_earned.sql
-- Badge ledger — idempotent inserts (one row per badge ever earned). Badge
-- IDs are stable string slugs from app/server/src/badges.ts: 'marathon',
-- 'foodie', 'night_owl', 'early_bird', 'first_day', 'memory_keeper',
-- 'hat_trick'.

CREATE TABLE badges_earned (
  badge_id  TEXT    PRIMARY KEY,
  earned_at INTEGER NOT NULL
);
