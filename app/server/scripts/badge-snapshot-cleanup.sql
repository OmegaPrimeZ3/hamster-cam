-- badge-snapshot-cleanup.sql
-- Removes wrongly-awarded Memory Keeper (memory_keeper) and Paparazzi (paparazzi)
-- badges from the live database on the Mac Mini.
--
-- BACKGROUND
-- ----------
-- The badge engine previously counted ALL rows in the `snapshots` table (which
-- also holds nightly auto-captured frames from the snapshot-capture job), so
-- memory_keeper (threshold: 5) and paparazzi (threshold: 50) were awarded
-- without any genuine manual "Take a photo!" snapshots.
--
-- The engine is now fixed to count kind='snapshot' diary entries
-- (db.countDiaryKindAllTime). This script removes any badge rows that were
-- awarded under the old broken logic but do NOT qualify under the new correct
-- logic. Legitimately-earned rows (where the snapshot diary count meets the
-- threshold) are preserved intact.
--
-- SAFE TO RUN MULTIPLE TIMES: the WHERE conditions gate every DELETE and UPDATE
-- so re-running is a no-op if the cleanup has already been applied.
--
-- ============================================================================
-- STEP 0: BEFORE RUNNING — read the instructions at the bottom of this file.
-- ============================================================================


-- ============================================================================
-- SECTION 1: DIAGNOSTIC QUERIES (run these first, read before proceeding)
-- ============================================================================

-- 1a. Current count of genuine manual snapshots (kind='snapshot' diary entries).
--     This is the authoritative count that the badge engine now uses.
SELECT COUNT(*) AS genuine_snapshot_count
  FROM diary_entries
 WHERE kind = 'snapshot';

-- 1b. Affected badge rows that exist in the DB right now.
SELECT badge_id,
       COUNT(*)         AS row_count,
       MIN(earned_at)   AS first_earned_ms,
       MAX(earned_at)   AS last_earned_ms
  FROM badges_earned
 WHERE badge_id IN ('memory_keeper', 'paparazzi')
 GROUP BY badge_id;

-- 1c. What would qualify under the corrected rules?
--     memory_keeper requires >= 5 genuine snapshots.
--     paparazzi      requires >= 50 genuine snapshots.
SELECT
  (SELECT COUNT(*) FROM diary_entries WHERE kind = 'snapshot') AS genuine_count,
  CASE WHEN (SELECT COUNT(*) FROM diary_entries WHERE kind = 'snapshot') >= 5
       THEN 'YES — keep memory_keeper'
       ELSE 'NO — delete memory_keeper'
  END AS memory_keeper_verdict,
  CASE WHEN (SELECT COUNT(*) FROM diary_entries WHERE kind = 'snapshot') >= 50
       THEN 'YES — keep paparazzi'
       ELSE 'NO — delete paparazzi'
  END AS paparazzi_verdict;


-- ============================================================================
-- SECTION 2: REMEDIATION (run after you have read the diagnostics above)
-- ============================================================================

BEGIN;

-- Delete memory_keeper rows when the genuine snapshot count < 5.
DELETE FROM badges_earned
 WHERE badge_id = 'memory_keeper'
   AND (SELECT COUNT(*) FROM diary_entries WHERE kind = 'snapshot') < 5;

-- Delete paparazzi rows when the genuine snapshot count < 50.
DELETE FROM badges_earned
 WHERE badge_id = 'paparazzi'
   AND (SELECT COUNT(*) FROM diary_entries WHERE kind = 'snapshot') < 50;

COMMIT;


-- ============================================================================
-- SECTION 3: POST-REMEDIATION VERIFICATION
-- ============================================================================

-- Should match the verdict from 1c: badges that qualified are still present;
-- those that didn't qualify are gone.
SELECT badge_id,
       COUNT(*)       AS row_count,
       MIN(earned_at) AS first_earned_ms,
       MAX(earned_at) AS last_earned_ms
  FROM badges_earned
 WHERE badge_id IN ('memory_keeper', 'paparazzi')
 GROUP BY badge_id;

-- Confirm total badges_earned count did not change unexpectedly.
SELECT COUNT(*) AS total_badges_earned FROM badges_earned;
