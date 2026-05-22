-- 0015_camera_live_src.sql
-- Add `live_src` column to cameras: the go2rtc stream name (e.g. hamster_cam_1)
-- used by the authenticated WebSocket proxy at GET /live/ws?src=<name>.
--
-- Nullable so existing rows keep working. Operators set this via
-- Settings → Cameras → Live Source. stream_url is retained for backward-
-- compatibility (snapshot capture, recording paths, etc.) but is no longer
-- required for live display.

ALTER TABLE cameras ADD COLUMN live_src TEXT;
