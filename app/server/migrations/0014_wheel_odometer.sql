-- 0014_wheel_odometer.sql
-- Per-camera wheel-odometer configuration. The operator sticks a piece of
-- black tape on the wheel rim; we count rim crossings by sampling RTSP frames
-- via ffmpeg (optical mark detection, Approach B).
--
-- Range constraints (band_y/height 0–100, threshold_pct 0–100) are enforced
-- at the application layer via Zod, mirroring the existing column-constraint
-- pattern for the rest of the schema.

ALTER TABLE cameras ADD COLUMN wheel_mark_enabled INTEGER NOT NULL DEFAULT 0 CHECK (wheel_mark_enabled IN (0,1));
ALTER TABLE cameras ADD COLUMN wheel_diameter_mm REAL NOT NULL DEFAULT 152.0;
ALTER TABLE cameras ADD COLUMN wheel_band_y_pct REAL NOT NULL DEFAULT 50.0;
ALTER TABLE cameras ADD COLUMN wheel_band_height_pct REAL NOT NULL DEFAULT 10.0;
ALTER TABLE cameras ADD COLUMN wheel_threshold_pct REAL NOT NULL DEFAULT 50.0;
