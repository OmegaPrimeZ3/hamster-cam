-- Migration 0023: add per-candidate attempt tracking and permanent-unavailable
-- flag to diary_entries, so the thumbnail-backfill job can give up on entries
-- whose source footage genuinely does not exist in Frigate instead of retrying
-- forever.
--
-- media_backfill_attempts  INTEGER NOT NULL DEFAULT 0
--   Counts how many times the backfill job has tried (and failed) to generate
--   media for this entry. Incremented only on transient failures; permanent
--   failures set media_unavailable directly without incrementing.
--
-- media_backfill_last_error  TEXT
--   Human-readable description of the last failure (HTTP status, error code,
--   or "max_transient_attempts"). NULL until the first failure is recorded.
--   Useful for operator diagnostics without requiring log scraping.
--
-- media_unavailable  INTEGER NOT NULL DEFAULT 0
--   Boolean flag (0/1). When 1, the row is excluded from all future backfill
--   candidate queries — the job has given up on this entry. Set to 1 on:
--     - Permanent HTTP errors from Frigate (400, 401, 404, 410).
--     - Exhaustion of MAX_TRANSIENT_ATTEMPTS consecutive transient failures.
--
-- Existing rows start with attempts=0 and unavailable=0; the job's normal
-- flow will naturally process them and reach the give-up threshold within
-- ~15 minutes (5 attempts × 3 min tick) if the footage is truly gone.

ALTER TABLE diary_entries ADD COLUMN media_backfill_attempts  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE diary_entries ADD COLUMN media_backfill_last_error TEXT;
ALTER TABLE diary_entries ADD COLUMN media_unavailable         INTEGER NOT NULL DEFAULT 0;
