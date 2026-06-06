-- 0024_wheel_motion_detector.sql
-- Replace the optical-mark rotation-counting pipeline with a whole-wheel
-- motion-energy detector. The new detector samples a large ROI at 5 fps,
-- computes mean absolute pixel difference between consecutive frames, and
-- uses a state machine (idle → armed → idle) to emit "wheel motion sessions"
-- with duration and calibrated distance.
--
-- NEW columns added to `cameras`:
--
--   wheel_motion_roi_x/y/w/h  INTEGER  (percentage of frame, 0–100)
--     Bounding box for the whole-wheel ROI. NULL = detector disabled for this
--     camera. Stored as integer percentages 0–100, matching the convention
--     established for wheel_band_* columns.
--
--   wheel_motion_threshold  REAL DEFAULT 12.0
--     Mean-absolute-pixel-difference (0–255 scale) above which a frame is
--     considered "in motion". 12.0 works well empirically for cage lighting.
--
--   wheel_avg_speed_mps  REAL DEFAULT 1.0
--     Calibrated average wheel speed in metres per second (1.0 ≈ 3.6 km/h).
--     Distance = session_duration_s × wheel_avg_speed_mps.
--
-- DEPRECATED columns (kept for one release to allow revertibility):
--   wheel_mark_enabled       -- no longer consulted by the detector
--   wheel_diameter_mm        -- replaced by avg-speed model
--   wheel_band_x_pct         -- replaced by wheel_motion_roi_*
--   wheel_band_width_pct     -- replaced by wheel_motion_roi_*
--   wheel_band_y_pct         -- replaced by wheel_motion_roi_*
--   wheel_band_height_pct    -- replaced by wheel_motion_roi_*
--   wheel_threshold_pct      -- replaced by wheel_motion_threshold
--
-- Seed: cam2 (the camera that faces the wheel) starts with a centred 50%
-- ROI box covering most of the wheel area. Operator should refine via
-- cameras.setWheelMotion in the settings UI.

ALTER TABLE cameras ADD COLUMN wheel_motion_roi_x         INTEGER;
ALTER TABLE cameras ADD COLUMN wheel_motion_roi_y         INTEGER;
ALTER TABLE cameras ADD COLUMN wheel_motion_roi_w         INTEGER;
ALTER TABLE cameras ADD COLUMN wheel_motion_roi_h         INTEGER;
ALTER TABLE cameras ADD COLUMN wheel_motion_threshold     REAL NOT NULL DEFAULT 12.0;
ALTER TABLE cameras ADD COLUMN wheel_avg_speed_mps        REAL NOT NULL DEFAULT 1.0;

-- Seed cam2 with a reasonable default ROI (centre 50% of frame).
-- cam2 is the second camera inserted (position=1 / id=2 in a fresh DB).
-- The UPDATE is a no-op in fresh DBs with no cam2 row; it will apply on the
-- live production DB where cam2 already exists with id=2.
UPDATE cameras
   SET wheel_motion_roi_x = 25,
       wheel_motion_roi_y = 25,
       wheel_motion_roi_w = 50,
       wheel_motion_roi_h = 50
 WHERE name LIKE '%2%' OR position = 1
   AND wheel_motion_roi_x IS NULL;
