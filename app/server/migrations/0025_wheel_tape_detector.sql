-- 0025_wheel_tape_detector.sql
-- Replace the whole-wheel motion-energy detector with a tape-crossing detector
-- using adaptive thresholding (Welford rolling mean/std over a brightness signal).
--
-- NEW columns added to `cameras`:
--
--   wheel_tape_sensitivity  REAL DEFAULT 2.0
--     Sigma multiplier for the dip threshold: a frame is a "dip" when
--     brightness[t] < rolling_mean - sensitivity * rolling_std.
--     Range 1.5–3.5; lower = more sensitive; higher = fewer false positives.
--
--   wheel_tape_circumference_cm  REAL DEFAULT 13.0
--     Physical circumference of the wheel in centimetres (5-inch wheel ≈ 13 cm).
--     wheel_meters = rotations × circumference_cm / 100.
--
-- REUSED columns (wheel_motion_roi_x/y/w/h) now describe the wide horizontal
-- STRIP rather than the whole-wheel bounding box. No schema rename needed.
--
-- DEPRECATED columns kept for revertibility (see migration 0024 for rationale):
--   wheel_motion_threshold  — replaced by adaptive sensitivity threshold
--   wheel_avg_speed_mps     — replaced by rotation × circumference model

ALTER TABLE cameras ADD COLUMN wheel_tape_sensitivity       REAL NOT NULL DEFAULT 2.0;
ALTER TABLE cameras ADD COLUMN wheel_tape_circumference_cm  REAL NOT NULL DEFAULT 13.0;

-- Seed cam2 (the wheel-facing camera) with the better wide-strip default.
-- x=10, y=40, w=80, h=20 gives a wide horizontal strip across the frame mid-section.
-- The UPDATE is a no-op in fresh DBs with no cam2 row; it applies on the live
-- production DB where cam2 already exists.
UPDATE cameras
   SET wheel_motion_roi_x = 10,
       wheel_motion_roi_y = 40,
       wheel_motion_roi_w = 80,
       wheel_motion_roi_h = 20
 WHERE (name LIKE '%2%' OR position = 1)
   AND wheel_motion_roi_x IS NOT NULL;
