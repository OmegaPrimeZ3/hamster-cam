-- 0011_camera_zones.sql
-- Per-camera zone configuration. Operator-managed metadata describing which
-- zones each camera has been set up with in Frigate — used by the UI to
-- render zone pills on each camera and to build a dynamic scoreboard with
-- one tile per zone that is actually wired up.
--
-- NOT pushed into Frigate; the Frigate YAML stays the source of truth for
-- where boxes are drawn. The values stored here are the keyword vocabulary
-- documented in app/server/src/narrator.ts `matchKeyword`
-- (wheel, food, water, bathroom, resting, tunnel, hiding) — JSON-encoded as
-- a string[] in the `zones` column for portability.

ALTER TABLE cameras
  ADD COLUMN zones TEXT NOT NULL DEFAULT '[]';
