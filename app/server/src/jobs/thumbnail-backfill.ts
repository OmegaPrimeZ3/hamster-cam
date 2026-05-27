// app/server/src/jobs/thumbnail-backfill.ts
// Periodic backfill job for diary entries whose thumbnail generation failed at
// entry-close time (the dominant failure mode is Frigate not yet having flushed
// the recording segment when the narrator fires the eager one-shot generation).
//
// Strategy:
//   - Query for entries missing a thumbnail that still have footage available
//     in Frigate (within the 3-day retention window, with a resolvable camera).
//   - Call the existing generateThumbnailForEntry for each candidate — it is
//     idempotent, never throws, and covers the rename/persist logic.
//   - Process newest-first so freshly-written race failures are healed quickly.
//   - Cap at BATCH_SIZE per run to avoid hammering Frigate with parallel ffmpeg
//     calls. Sequential processing (no concurrency) is intentional — ffmpeg is
//     CPU-bound and Frigate's clip endpoint handles load poorly under bursts.
//
// Cadence: every 3 minutes. This is frequent enough to catch the recording-
// flush race (Frigate typically flushes segments within 30–60 seconds of event
// close) while keeping steady-state overhead negligible once the backlog drains.
// After the first pass the query returns 0 rows for all recent entries and the
// job exits in microseconds.
//
// Safety gate: bails out immediately when FRIGATE_URL is not configured — no
// Frigate, no thumbnails, no point running.

import { getConfig } from '../config.js';
import * as db from '../db.js';
import { childLogger } from '../logger.js';
import { generateThumbnailForEntry } from '../thumbnails.js';

const logger = childLogger('thumbnail-backfill-job');

// Mirrors FRIGATE_RECORDING_RETENTION_MS in trpc.ts. Both constants track
// record.retain.days=3 in the Frigate config. They are intentionally kept as
// module-level constants in their respective files to avoid a cross-module
// coupling; if the retention window changes, update both.
const FRIGATE_RECORDING_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// Maximum entries processed per run. Keeps individual job runs short and
// avoids overloading Frigate with a burst of clip fetches after a restart that
// finds a large historical backlog (e.g. the ~294 NULL rows on first deploy).
const BATCH_SIZE = 20;

export interface ThumbnailBackfillResult {
  candidates: number;
  succeeded: number;
  still_missing: number;
}

export async function runThumbnailBackfillJob(): Promise<ThumbnailBackfillResult> {
  const cfg = getConfig();

  if (!cfg.FRIGATE_URL) {
    logger.debug('FRIGATE_URL not configured — skipping thumbnail backfill');
    return { candidates: 0, succeeded: 0, still_missing: 0 };
  }

  const retentionCutoffMs = Date.now() - FRIGATE_RECORDING_RETENTION_MS;
  const candidates = db.listDiaryEntriesMissingThumbnail(retentionCutoffMs, BATCH_SIZE);

  if (candidates.length === 0) {
    logger.debug('no thumbnail backfill candidates');
    return { candidates: 0, succeeded: 0, still_missing: 0 };
  }

  logger.info({ count: candidates.length }, 'thumbnail backfill: processing candidates');

  let succeeded = 0;
  for (const entry of candidates) {
    await generateThumbnailForEntry(entry);
    // Re-fetch to check whether thumbnail_path was written.
    const refreshed = db.getDiaryEntryById(entry.id);
    if (refreshed?.thumbnail_path) {
      succeeded += 1;
    }
  }

  const stillMissing = candidates.length - succeeded;
  logger.info(
    { candidates: candidates.length, succeeded, still_missing: stillMissing },
    'thumbnail backfill complete',
  );
  return { candidates: candidates.length, succeeded, still_missing: stillMissing };
}
