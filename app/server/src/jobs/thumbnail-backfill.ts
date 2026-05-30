// app/server/src/jobs/thumbnail-backfill.ts
// Periodic backfill job for diary entries whose thumbnail generation failed at
// entry-close time (the dominant failure mode is Frigate not yet having flushed
// the recording segment when the narrator fires the eager one-shot generation).
//
// Strategy:
//   - Query for entries missing a thumbnail that are not marked media_unavailable,
//     still have footage potentially available in Frigate (within the 10-day
//     retention window), and have a resolvable camera.
//   - Call generateThumbnailForEntryUnguarded for each candidate — the unguarded
//     variant throws on failure so we can classify the error and update tracking.
//   - On success: thumbnail_path is written by the generator; no extra work needed.
//   - On permanent failure (HTTP 400/401/404/410 from Frigate): mark the entry
//     media_unavailable=1 immediately so it is never retried again.
//   - On transient failure (network errors, HTTP 408/429/5xx): increment
//     media_backfill_attempts. After MAX_TRANSIENT_ATTEMPTS consecutive transient
//     failures the entry is also marked media_unavailable=1.
//   - Process newest-first so freshly-written race failures are healed quickly.
//   - Cap at BATCH_SIZE per run to avoid hammering Frigate with parallel ffmpeg
//     calls. Sequential processing (no concurrency) is intentional.
//
// Cadence: every 3 minutes. This is frequent enough to catch the recording-
// flush race (Frigate typically flushes segments within 30–60 seconds of event
// close) while keeping steady-state overhead negligible once the backlog drains.
//
// Safety gate: bails out immediately when FRIGATE_URL is not configured.

import { getConfig } from '../config.js';
import * as db from '../db.js';
import { childLogger } from '../logger.js';
import { generateThumbnailForEntryUnguarded } from '../thumbnails.js';
import {
  classifyBackfillError,
  describeBackfillError,
  getErrorText,
} from '../backfill-errors.js';

// Re-export so existing callers (e.g. tests) that import from this module keep working.
export { classifyBackfillError, describeBackfillError } from '../backfill-errors.js';
export type { BackfillErrorClass } from '../backfill-errors.js';

const logger = childLogger('thumbnail-backfill-job');

// Mirrors FRIGATE_RECORDING_RETENTION_MS in trpc.ts. Both constants track
// record.retain.days=10 in the Frigate config. They are intentionally kept as
// module-level constants in their respective files to avoid a cross-module
// coupling; if the retention window changes, update both.
const FRIGATE_RECORDING_RETENTION_MS = 10 * 24 * 60 * 60 * 1000; // 10 days

// Maximum entries processed per run. Keeps individual job runs short and
// avoids overloading Frigate with a burst of clip fetches after a restart that
// finds a large historical backlog.
const BATCH_SIZE = 20;

// How many consecutive transient failures before we give up on a candidate.
// 5 attempts × 3-minute tick ≈ 15 minutes. After that, transient errors are
// indistinguishable from permanent ones from a practical standpoint.
export const MAX_TRANSIENT_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Job result
// ---------------------------------------------------------------------------

export interface ThumbnailBackfillResult {
  candidates: number;
  succeeded: number;
  still_missing: number;
}

// ---------------------------------------------------------------------------
// Main job entry point
// ---------------------------------------------------------------------------

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
    try {
      await generateThumbnailForEntryUnguarded(entry);

      // Re-fetch to check whether thumbnail_path was written.
      const refreshed = db.getDiaryEntryById(entry.id);
      if (refreshed?.thumbnail_path) {
        succeeded += 1;
        // attempts counter is left as-is for debugging — don't reset it.
      } else if (isStructurallyUngeneratable(entry)) {
        // Truly ungeneratable: kind=recap (no representative frame by design)
        // or no resolvable camera. Mark permanent so we don't loop forever.
        logger.debug(
          { diary_entry_id: entry.id, kind: entry.kind, camera_id: entry.camera_id },
          'thumbnail backfill: structurally ungeneratable — marking unavailable',
        );
        db.markDiaryEntryMediaUnavailable(entry.id, 'no_path_written');
      } else {
        // Generator returned null without throwing — most commonly because
        // thumbnailFromFrigateFrame swallowed a transient Frigate failure
        // (extractFrame writes a zero-byte placeholder on failure and returns
        // captured:false). Treat as transient: bump the attempts counter,
        // give up only after MAX_TRANSIENT_ATTEMPTS like any other transient.
        const newAttempts = entry.media_backfill_attempts + 1;
        if (newAttempts >= MAX_TRANSIENT_ATTEMPTS) {
          logger.info(
            {
              diary_entry_id: entry.id,
              reason: 'max_transient_attempts',
              attempts: newAttempts,
            },
            'thumbnail backfill: marking unavailable',
          );
          db.updateDiaryEntryBackfillAttempt(entry.id, newAttempts, 'no_path_written');
          db.markDiaryEntryMediaUnavailable(entry.id, 'max_transient_attempts');
        } else {
          logger.debug(
            {
              diary_entry_id: entry.id,
              attempt: newAttempts,
              of: MAX_TRANSIENT_ATTEMPTS,
            },
            'thumbnail backfill: transient null-return, will retry',
          );
          db.updateDiaryEntryBackfillAttempt(entry.id, newAttempts, 'no_path_written');
        }
      }
    } catch (err) {
      const classification = classifyBackfillError(err);
      const errorDesc = describeBackfillError(err);
      const newAttempts = entry.media_backfill_attempts + 1;

      if (classification === 'permanent') {
        // Permanent failure: give up immediately.
        const httpStatus = getErrorText(err).match(/\b(400|401|404|410)\b/)?.[1];
        logger.info(
          {
            diary_entry_id: entry.id,
            reason: errorDesc,
            httpStatus: httpStatus ? Number(httpStatus) : undefined,
            attempts: newAttempts,
          },
          'thumbnail backfill: marking unavailable',
        );
        db.markDiaryEntryMediaUnavailable(entry.id, errorDesc);
      } else {
        // Transient failure: increment counter.
        if (newAttempts >= MAX_TRANSIENT_ATTEMPTS) {
          // Hit the ceiling — give up.
          logger.info(
            {
              diary_entry_id: entry.id,
              reason: 'max_transient_attempts',
              attempts: newAttempts,
            },
            'thumbnail backfill: marking unavailable',
          );
          db.updateDiaryEntryBackfillAttempt(entry.id, newAttempts, errorDesc);
          db.markDiaryEntryMediaUnavailable(entry.id, 'max_transient_attempts');
        } else {
          // Still retrying.
          logger.info(
            {
              diary_entry_id: entry.id,
              attempt: newAttempts,
              of: MAX_TRANSIENT_ATTEMPTS,
              errCode: errorDesc,
            },
            'thumbnail backfill: transient failure, will retry',
          );
          db.updateDiaryEntryBackfillAttempt(entry.id, newAttempts, errorDesc);
        }
      }
    }
  }

  const stillMissing = candidates.length - succeeded;
  logger.info(
    { candidates: candidates.length, succeeded, still_missing: stillMissing },
    'thumbnail backfill complete',
  );
  return { candidates: candidates.length, succeeded, still_missing: stillMissing };
}

/**
 * True when the entry can NEVER produce a thumbnail regardless of how many
 * times the generator runs — kind=recap (skipped inside _generate by design),
 * or no camera_id to extract a frame against. Anything else (narrative with a
 * camera_id) is potentially generatable; a null return from the generator on
 * that class is almost always a transient Frigate extract failure that
 * deserves retries, not an immediate permanent mark.
 */
function isStructurallyUngeneratable(entry: db.DiaryEntryRow): boolean {
  if (entry.kind === 'recap') return true;
  if (entry.kind === 'narrative' && entry.camera_id == null) return true;
  return false;
}
