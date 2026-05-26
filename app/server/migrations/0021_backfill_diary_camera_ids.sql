-- 0021_backfill_diary_camera_ids.sql
-- Repair narrative diary entries written before the cameraIdByName bug was fixed
-- (bug: matched cameras.name instead of cameras.live_src against Frigate event
-- camera identifiers, so all 294 pre-fix entries landed with camera_id = NULL).
--
-- THREE UPDATE PASSES — all guarded so they are no-ops when already correct:
--
-- Pass 1 (non-transition entries): set camera_id where
--   • camera_id IS NULL
--   • details JSON has a "camera" key
--   • a camera row matches via live_src (COLLATE NOCASE) OR name (COLLATE NOCASE)
--   live_src match is tried first via COALESCE so it wins when both match.
--
-- Pass 2 (transition entries — from_camera_id): set from_camera_id where
--   • from_camera_id IS NULL
--   • details JSON has a "from" key
--   • resolved via live_src then name
--   Transition entries legitimately have camera_id = NULL (a transition spans
--   two cameras) — we do NOT touch camera_id for transitions.
--
-- Pass 3 (transition entries — to_camera_id): same logic for "to" / to_camera_id.
--
-- All UPDATEs are idempotent: repeated runs only write to rows still NULL.

-- Pass 1: non-transition entries — populate camera_id from details.$.camera
UPDATE diary_entries
SET camera_id = COALESCE(
  -- prefer live_src match
  (SELECT id FROM cameras
   WHERE live_src IS NOT NULL
     AND lower(trim(live_src)) = lower(trim(json_extract(diary_entries.details, '$.camera')))
   LIMIT 1),
  -- fall back to name match
  (SELECT id FROM cameras
   WHERE lower(trim(name)) = lower(trim(json_extract(diary_entries.details, '$.camera')))
   LIMIT 1)
)
WHERE camera_id IS NULL
  AND activity != 'transition'
  AND json_extract(details, '$.camera') IS NOT NULL
  AND COALESCE(
    (SELECT id FROM cameras
     WHERE live_src IS NOT NULL
       AND lower(trim(live_src)) = lower(trim(json_extract(diary_entries.details, '$.camera')))
     LIMIT 1),
    (SELECT id FROM cameras
     WHERE lower(trim(name)) = lower(trim(json_extract(diary_entries.details, '$.camera')))
     LIMIT 1)
  ) IS NOT NULL;

-- Pass 2: transition entries — populate from_camera_id from details.$.from
UPDATE diary_entries
SET from_camera_id = COALESCE(
  (SELECT id FROM cameras
   WHERE live_src IS NOT NULL
     AND lower(trim(live_src)) = lower(trim(json_extract(diary_entries.details, '$.from')))
   LIMIT 1),
  (SELECT id FROM cameras
   WHERE lower(trim(name)) = lower(trim(json_extract(diary_entries.details, '$.from')))
   LIMIT 1)
)
WHERE from_camera_id IS NULL
  AND activity = 'transition'
  AND json_extract(details, '$.from') IS NOT NULL
  AND COALESCE(
    (SELECT id FROM cameras
     WHERE live_src IS NOT NULL
       AND lower(trim(live_src)) = lower(trim(json_extract(diary_entries.details, '$.from')))
     LIMIT 1),
    (SELECT id FROM cameras
     WHERE lower(trim(name)) = lower(trim(json_extract(diary_entries.details, '$.from')))
     LIMIT 1)
  ) IS NOT NULL;

-- Pass 3: transition entries — populate to_camera_id from details.$.to
UPDATE diary_entries
SET to_camera_id = COALESCE(
  (SELECT id FROM cameras
   WHERE live_src IS NOT NULL
     AND lower(trim(live_src)) = lower(trim(json_extract(diary_entries.details, '$.to')))
   LIMIT 1),
  (SELECT id FROM cameras
   WHERE lower(trim(name)) = lower(trim(json_extract(diary_entries.details, '$.to')))
   LIMIT 1)
)
WHERE to_camera_id IS NULL
  AND activity = 'transition'
  AND json_extract(details, '$.to') IS NOT NULL
  AND COALESCE(
    (SELECT id FROM cameras
     WHERE live_src IS NOT NULL
       AND lower(trim(live_src)) = lower(trim(json_extract(diary_entries.details, '$.to')))
     LIMIT 1),
    (SELECT id FROM cameras
     WHERE lower(trim(name)) = lower(trim(json_extract(diary_entries.details, '$.to')))
     LIMIT 1)
  ) IS NOT NULL;
