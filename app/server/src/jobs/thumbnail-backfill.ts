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
import { FfmpegError } from '../frigate.js';
import { childLogger } from '../logger.js';
import { generateThumbnailForEntryUnguarded } from '../thumbnails.js';

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
// Error classification
// ---------------------------------------------------------------------------

export type BackfillErrorClass = 'permanent' | 'transient';

/**
 * Classify a thumbnail-generation error as permanent (give up immediately) or
 * transient (increment counter, retry up to MAX_TRANSIENT_ATTEMPTS).
 *
 * Permanent errors:
 *   - HTTP 400 Bad Request  — footage outside Frigate's retention / event not found
 *   - HTTP 401 Unauthorized — auth problem (won't self-heal)
 *   - HTTP 404 Not Found    — event or recording genuinely gone
 *   - HTTP 410 Gone         — explicitly deleted
 *
 * Transient errors (everything else):
 *   - Network errors: ECONNRESET, ECONNREFUSED, ETIMEDOUT, EAI_AGAIN, ENOTFOUND
 *   - HTTP 408, 429, 500, 502, 503, 504
 *   - Any unknown error (conservative: assume it might resolve)
 */
export function classifyBackfillError(err: unknown): BackfillErrorClass {
  // Extract a combined string covering both the error message and ffmpeg stderr
  // (FfmpegError carries the HTTP status line in its stderr field).
  const msg = getErrorText(err);

  // Permanent HTTP statuses: 400, 401, 404, 410.
  // ffmpeg formats these as "Server returned 4XX <reason>" in its stderr.
  if (/\b(400|401|404|410)\b/.test(msg)) return 'permanent';

  // Network errors that won't self-heal by retrying.
  // Note: ENOTFOUND (DNS failure) can be transient, but we include it as
  // transient so the attempt counter handles it via MAX_TRANSIENT_ATTEMPTS.

  // Transient network error codes that appear in error messages.
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/.test(msg)) return 'transient';

  // Transient HTTP statuses: 408, 429, 500, 502, 503, 504.
  if (/\b(408|429|500|502|503|504)\b/.test(msg)) return 'transient';

  // Connection-level text from ffmpeg stderr (when TCP fails before HTTP).
  if (/connection (refused|reset|timed out)|broken pipe/i.test(msg)) return 'transient';

  // Conservative default: unknown errors are treated as transient so we don't
  // silently discard footage that might still be available.
  return 'transient';
}

/** Returns a combined error text string from message + stderr (for FfmpegError). */
function getErrorText(err: unknown): string {
  if (err instanceof FfmpegError) {
    return `${err.message} ${err.stderr}`;
  }
  if (err instanceof Error) {
    // Node network errors carry a `code` property.
    const code = (err as NodeJS.ErrnoException).code ?? '';
    return `${err.message} ${code}`;
  }
  return String(err);
}

/** Human-readable reason string for a classified error — used in last_error column. */
export function describeBackfillError(err: unknown): string {
  const msg = getErrorText(err);
  // Extract the first recognisable HTTP status for cleaner DB values.
  const httpMatch = msg.match(/\b(400|401|404|408|410|429|500|502|503|504)\b/);
  if (httpMatch) return `http_${httpMatch[1]}`;
  const errCodeMatch = msg.match(/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/);
  if (errCodeMatch) return errCodeMatch[0].toLowerCase();
  return err instanceof Error ? err.message.slice(0, 120) : 'unknown_error';
}

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
      } else {
        // Generator returned without throwing but also without writing a path.
        // This happens for recap entries (skipped inside _generate) or entries
        // with no resolvable camera — treat as a permanent skip, not a transient
        // failure, so we don't loop forever on structurally-ungeneratable rows.
        logger.debug(
          { diary_entry_id: entry.id },
          'thumbnail backfill: generator returned without writing path — marking unavailable',
        );
        db.markDiaryEntryMediaUnavailable(entry.id, 'no_path_written');
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
