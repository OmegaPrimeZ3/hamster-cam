-- Migration 0019: add thumbnail_path and clip_path to diary_entries.
-- thumbnail_path: relative path under STORAGE_PATH to a ~480px JPEG thumbnail.
-- clip_path: relative path under STORAGE_PATH to a cached extracted MP4 clip.
-- Both are nullable; generated eagerly for new entries, never backfilled.

ALTER TABLE diary_entries ADD COLUMN thumbnail_path TEXT;
ALTER TABLE diary_entries ADD COLUMN clip_path TEXT;
