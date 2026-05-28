-- 0022_nightly_recap_settings.sql
-- Seed three new settings keys introduced for the Nightly Recap tab:
--
--   timelapse_enabled        (bool, default true)
--     On/off gate for the nightly VIDEO timelapse job. When 'false' the
--     jobs/timelapse.ts job short-circuits early, identical to how
--     recap_enabled gates jobs/recap.ts.
--
--   recap_video_zone_priority (string, default '')
--     CSV of activity keywords in priority order, e.g. "wheel,food,water".
--     When non-empty, clip selection in the timelapse job is activity-aware:
--     the top-priority activity's clip is guaranteed included and ranked first.
--     Empty string = no override = current temporal selection behavior.
--
--   recap_names              (string, default '')
--     CSV of names to personalise the AI recap greeting, e.g. "Maya,Leo".
--     When non-empty the AI prompt opens with a child-friendly greeting
--     addressed to those names. Empty = no greeting (current behavior).
--
-- INSERT OR IGNORE so re-running never overwrites a value the admin tweaked.
-- New keys go here; 0001_settings.sql is the v1 vocabulary and is append-only.

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('timelapse_enabled',          'true'),
  ('recap_video_zone_priority',  ''),
  ('recap_names',                '');
