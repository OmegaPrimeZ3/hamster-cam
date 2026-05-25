-- 0016_wheel_band_box.sql
-- Extend per-camera wheel-odometer band from a full-width horizontal strip
-- to a configurable rectangular ROI box. When the wheel is viewed at an angle
-- it projects as an ellipse; a small box aimed at one arc-crossing point fires
-- exactly once per revolution and gives a stronger signal than a wide strip.
--
-- Defaults reproduce the previous full-width behavior (x=0, width=100) so
-- existing head-on cameras are unaffected without any operator action.
--
-- Range constraints (0–100) are enforced at the application layer via Zod,
-- consistent with the pattern established in 0014_wheel_odometer.sql.

ALTER TABLE cameras ADD COLUMN wheel_band_x_pct REAL NOT NULL DEFAULT 0;
ALTER TABLE cameras ADD COLUMN wheel_band_width_pct REAL NOT NULL DEFAULT 100;
